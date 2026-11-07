import { ToCData } from '../types';
import { normalizeChart } from '../../shared/chart-model';
import { isChartVersion } from '../../shared/chart-wire';
import type { LinkSharingLevel, Permission } from '../../shared/permissions';
import type { ServerState } from '../sync/ChartDocument';
import { RequestTokenSource, type AuthTokenProvider } from './requestTokenSource';

export type { LinkSharingLevel, Permission, PermissionStatus } from '../../shared/permissions';
export type { AuthTokenProvider } from './requestTokenSource';

const API_BASE = '/api';

/**
 * A non-2xx answer from the chart API. `status` lets callers tell a
 * server-side failure that may pass (5xx), a refusal that a failed token
 * refresh can cause (401/403), and one that will not pass (404 unknown
 * chart).
 */
export class ChartApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ChartApiError';
    this.status = status;
  }
}

// A save or poll the server has not answered by now is treated as failed so
// the caller can retry: one stalled request must not hold up every later save
// or stop the poll loop.
const REQUEST_TIMEOUT_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * A Worker that predates versions answered. A document without a version could
 * never be saved or polled, and retrying would repeat the answer.
 */
function versionOf(body: unknown, status: number): number {
  if (!isRecord(body) || !isChartVersion(body.version)) {
    throw new ChartApiError('The server did not return a chart version', status);
  }
  return body.version;
}

interface ErrorBody {
  text: string;
  json: unknown;
}

/** The share links of a chart; the share dialog also builds one for a chart that already exists. */
export interface CreateChartResponse {
  chartId: string;
  editToken: string;
  viewUrl: string;
  editUrl: string;
}

export interface CreatedChart extends CreateChartResponse {
  /** The version the server stored the chart at. */
  version: number;
}

/**
 * What a create flow tells the app once the server has the chart: `chart` is
 * exactly what was sent, so the app can tell what changed while the request was
 * out and the version it is based on.
 */
export interface ChartCreated {
  editToken: string;
  chartId: string;
  version: number;
  chart: ToCData;
}

/**
 * The chart the app is saving to, handed back to a create flow: the chart it
 * just created, or the one that attached first when two creates raced. The
 * creator follows it (URL, links, uploads) rather than its own.
 */
export interface OpenChart {
  editToken: string;
  chartId: string;
}

export interface GetChartResponse {
  /** Normalised: every section and column has an id. */
  chartData: ToCData;
  chartId: string;
  version: number;
  canEdit: boolean;
  // true iff the server verified the caller's JWT and their sub matches the
  // chart owner's sub. Used by the client to gate owner-only fetches
  // (managePermissions) so we don't spam 403s for non-owned charts. Missing
  // on older server responses, treat `undefined` as `false`.
  isOwner?: boolean;
}

export type UpdateChartOutcome =
  | { status: 'saved'; version: number }
  | { status: 'conflict'; theirs: ServerState };

export interface PollChartResult {
  version: number;
  /** Present only when `version` differs from the one polled with; normalised. */
  chartData?: ToCData;
}

export interface UserChart {
  chartId: string;
  title: string;
  editUrl: string;
  viewUrl: string;
  updatedAt: string;
  createdAt: string;
  permissionLevel: 'owner' | 'edit';
}

export class ChartService {
  // Request-time token source (shared resolver — see
  // src/services/requestTokenSource.ts for the resolution semantics:
  // provider-first, static fallback, provider-throw → last-known).
  //
  // PR 7 round-2 fix: the worker now requires a valid Bearer JWT on
  // getUserCharts (and on updateChart for owned, restricted charts),
  // and the mount-time static snapshot alone proved unreliable — it is
  // intentionally nulled when Auth0 silent refresh fails, and it
  // silently expires mid-session. The signed-in 401s + "chart isn't
  // saved" report came from exactly those states. Resolving the token
  // per request via the registered provider keeps it fresh for as long
  // as the Auth0 session can be refreshed.
  private static tokenSource = new RequestTokenSource('ChartService');

  // Set the auth token (called from components with useAuth0 hook)
  static setAuthToken(token: string | null) {
    this.tokenSource.setToken(token);
  }

  // Check if auth token is set
  static hasAuthToken(): boolean {
    return this.tokenSource.hasToken();
  }

  /**
   * Register (or clear, with `null`) the request-time token provider.
   * Called from the App auth effect alongside `setAuthToken`.
   */
  static setAuthTokenProvider(provider: AuthTokenProvider | null) {
    this.tokenSource.setProvider(provider);
  }

  /** Build request headers, attaching Authorization when a token resolves. */
  private static async buildHeaders(
    base: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const token = await this.tokenSource.resolve();
    if (token) {
      base['Authorization'] = `Bearer ${token}`;
    }
    return base;
  }

  /**
   * Like `buildHeaders`, but for owner-only endpoints that are
   * meaningless without a session: throws the same 'Authentication
   * required' error the old static-only check produced.
   */
  private static async requireAuthHeaders(
    base: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const headers = await this.buildHeaders(base);
    if (!headers['Authorization']) {
      throw new Error('Authentication required');
    }
    return headers;
  }

  /** The body of a non-2xx answer: its text, and its parse when it is JSON. */
  private static async readBody(response: Response): Promise<ErrorBody> {
    const text = await response.text();
    try {
      return { text, json: JSON.parse(text) };
    } catch {
      // A body that is not JSON (a proxy's error page) explains nothing: the generic message stands.
      return { text, json: undefined };
    }
  }

  /**
   * The error for a non-2xx answer, carrying the Worker's own message when it
   * gave one. The raw body is logged because it is the only trace of why the
   * Worker refused.
   */
  private static async failure(
    method: string,
    path: string,
    response: Response,
    fallbackMessage: string,
    body?: ErrorBody,
  ): Promise<ChartApiError> {
    const { text, json } = body ?? (await this.readBody(response));
    console.error(`[ChartService] ${method} ${API_BASE}${path} -> ${response.status}`, text);
    const message =
      isRecord(json) && typeof json.error === 'string' && json.error ? json.error : undefined;
    return new ChartApiError(message ?? fallbackMessage, response.status);
  }

  /**
   * Runs `request` with a signal that aborts after REQUEST_TIMEOUT_MS. The
   * timer also covers reading the body, which is where a stalled answer hangs.
   */
  private static async withTimeout<T>(
    what: string,
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () =>
        timeout.abort(
          new DOMException(
            `${what} got no answer within ${REQUEST_TIMEOUT_MS / 1000}s`,
            'TimeoutError',
          ),
        ),
      REQUEST_TIMEOUT_MS,
    );
    try {
      return await request(timeout.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  static async createChart(chartData: ToCData): Promise<CreatedChart> {
    const headers = await this.buildHeaders({ 'Content-Type': 'application/json' });
    if (headers['Authorization']) {
      console.log('[ChartService] Creating chart with auth token');
    } else {
      console.log('[ChartService] Creating chart without auth token (user not authenticated)');
    }

    const response = await fetch(`${API_BASE}/createChart`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chartData }),
    });

    if (!response.ok) {
      throw await this.failure('POST', '/createChart', response, 'Failed to create chart');
    }

    const created = await response.json();
    return { ...created, version: versionOf(created, response.status) };
  }

  /** The chart of the view-only route; it has no version because it is never saved. */
  static async getChart(chartId: string): Promise<ToCData> {
    const params = new URLSearchParams();
    params.append('chartId', chartId);

    const response = await fetch(`${API_BASE}/getChart?${params}`);

    if (!response.ok) {
      throw await this.failure('GET', '/getChart', response, 'Failed to fetch chart');
    }

    const result = await response.json();
    return normalizeChart(result.chartData);
  }

  static async getChartByEditToken(editToken: string): Promise<GetChartResponse> {
    const headers = await this.buildHeaders();

    const params = new URLSearchParams();
    params.append('editToken', editToken);

    const response = await fetch(`${API_BASE}/getChart?${params}`, {
      headers,
    });

    if (!response.ok) {
      let fallback = 'Failed to fetch chart';
      if (response.status === 401) {
        fallback = 'Authentication required. Please log in to access this chart.';
      } else if (response.status === 404) {
        fallback = 'Chart not found. It may have been deleted.';
      }
      throw await this.failure('GET', '/getChart', response, fallback);
    }

    const result = await response.json();
    return {
      ...result,
      version: versionOf(result, response.status),
      chartData: normalizeChart(result.chartData),
    };
  }

  /**
   * Saves `chartData`, which was derived from the server's chart at
   * `baseVersion`. The Worker applies it only if that is still the current
   * version; otherwise it answers 409 with the latest chart, returned here as a
   * conflict for the caller to merge.
   */
  static async updateChart(
    editToken: string,
    chartData: ToCData,
    baseVersion: number,
  ): Promise<UpdateChartOutcome> {
    // Attach the Bearer token when one's available so the server can
    // attribute the edit to the caller — used by worker/api/updateChart.ts
    // to upsert a chart_permissions row (permission_level='edit') so
    // non-owned charts the user modifies surface in "My Charts".
    // Anonymous edits still work (the edit_token is the authorization
    // gate); they just don't produce an attribution row.
    //
    // For owned charts with link_sharing_level != 'editor' the worker
    // REQUIRES a valid Bearer token (owner or approved collaborator) —
    // see worker/api/updateChart.ts — which is why the token resolves
    // through the request-time provider here: a stale mount-time token
    // means every autosave 403s silently.
    const headers = await this.buildHeaders({ 'Content-Type': 'application/json' });

    return this.withTimeout('The save request', async (signal) => {
      const response = await fetch(`${API_BASE}/updateChart`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ editToken, chartData, baseVersion }),
        signal,
      });

      if (!response.ok) {
        const body = await this.readBody(response);
        const { json } = body;
        if (
          response.status === 409 &&
          isRecord(json) &&
          json.error === 'conflict' &&
          isChartVersion(json.version)
        ) {
          // The versions only: the body is the whole chart.
          console.log(
            `[ChartService] updateChart conflict: saved on version ${baseVersion}, server is at ${json.version}`,
          );
          return {
            status: 'conflict' as const,
            theirs: { version: json.version, chart: normalizeChart(json.chartData) },
          };
        }
        // Prefer the worker's explanation (e.g. "Invalid or expired
        // authentication. Please log in again.") — it feeds the
        // SaveIndicator tooltip, where "Failed to update chart" gives the
        // user nothing to act on.
        throw await this.failure('POST', '/updateChart', response, 'Failed to update chart', body);
      }

      const saved = await response.json();
      return { status: 'saved' as const, version: versionOf(saved, response.status) };
    });
  }

  /**
   * The check an open editor makes every few seconds: the server's current
   * version, with the chart only when it differs from `knownVersion`.
   */
  static async pollChart(editToken: string, knownVersion: number): Promise<PollChartResult> {
    const headers = await this.buildHeaders({ 'Content-Type': 'application/json' });

    return this.withTimeout('The version check', async (signal) => {
      const response = await fetch(`${API_BASE}/pollChart`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ editToken, knownVersion }),
        signal,
      });

      if (!response.ok) {
        throw await this.failure('POST', '/pollChart', response, 'Failed to poll chart');
      }

      const result = await response.json();
      const version = versionOf(result, response.status);
      return result.chartData === undefined
        ? { version }
        : { version, chartData: normalizeChart(result.chartData) };
    });
  }

  // Helper to extract edit token from URL
  static getEditTokenFromUrl(): string | null {
    const path = window.location.pathname;
    const match = path.match(/^\/edit\/([^/]+)$/);
    return match ? match[1] : null;
  }

  // Helper to extract chart ID from URL
  static getChartIdFromUrl(): string | null {
    const path = window.location.pathname;
    const match = path.match(/^\/chart\/([^/]+)$/);
    return match ? match[1] : null;
  }

  // Get chart ID from an edit token by calling the API
  static async getChartIdFromEditToken(editToken: string): Promise<string> {
    const result = await this.getChartByEditToken(editToken);
    return result.chartId;
  }

  // Save edit token to localStorage for persistence
  static saveEditToken(chartId: string, editToken: string): void {
    const tokens = JSON.parse(localStorage.getItem('editTokens') || '{}');
    tokens[chartId] = editToken;
    localStorage.setItem('editTokens', JSON.stringify(tokens));
  }

  // Get edit token from localStorage
  static getStoredEditToken(chartId: string): string | null {
    const tokens = JSON.parse(localStorage.getItem('editTokens') || '{}');
    return tokens[chartId] || null;
  }

  // Get all charts accessible by a user.
  //
  // The worker derives the user from the verified JWT (the userId param
  // is legacy/ignored server-side), so the Authorization header is
  // mandatory — without it the endpoint 401s, which is the "failed to
  // load user charts" the PR 7 round-2 reviewer hit.
  static async getUserCharts(userId: string): Promise<UserChart[]> {
    const params = new URLSearchParams();
    params.append('userId', userId);

    const headers = await this.buildHeaders();

    const response = await fetch(`${API_BASE}/getUserCharts?${params}`, { headers });

    if (!response.ok) {
      throw await this.failure('GET', '/getUserCharts', response, 'Failed to fetch user charts');
    }

    const result = await response.json();
    return result.charts;
  }

  // Get permissions for a chart (owner only).
  //
  // The server returns `{ permissions, linkSharingLevel }`. `linkSharingLevel`
  // is optional only to cover the chart-not-found edge case; in normal
  // responses the field is always present.
  static async getChartPermissions(
    chartId: string,
  ): Promise<{ permissions: Permission[]; linkSharingLevel?: LinkSharingLevel }> {
    const headers = await this.requireAuthHeaders();

    const params = new URLSearchParams();
    params.append('chartId', chartId);

    const response = await fetch(`${API_BASE}/managePermissions?${params}`, {
      headers,
    });

    if (!response.ok) {
      throw await this.failure(
        'GET',
        '/managePermissions',
        response,
        'Failed to fetch chart permissions',
      );
    }

    const result = await response.json();
    // Return the full result object with both permissions and linkSharingLevel
    return result;
  }

  // Remove permission from a user (owner only)
  static async removePermission(chartId: string, targetUserId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/managePermissions`, {
      method: 'DELETE',
      headers: await this.requireAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ chartId, targetUserId }),
    });

    if (!response.ok) {
      throw await this.failure(
        'DELETE',
        '/managePermissions',
        response,
        'Failed to remove permission',
      );
    }
  }

  // Update user's permission level (owner only)
  static async updatePermissionLevel(
    chartId: string,
    targetUserId: string,
    permissionLevel: 'owner' | 'edit',
  ): Promise<void> {
    const response = await fetch(`${API_BASE}/managePermissions`, {
      method: 'PATCH',
      headers: await this.requireAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ chartId, targetUserId, permissionLevel }),
    });

    if (!response.ok) {
      throw await this.failure(
        'PATCH',
        '/managePermissions',
        response,
        'Failed to update permission',
      );
    }
  }

  // Update link sharing settings (owner only)
  static async updateLinkSharing(
    chartId: string,
    linkSharingLevel: LinkSharingLevel,
  ): Promise<void> {
    const response = await fetch(`${API_BASE}/managePermissions`, {
      method: 'PUT',
      headers: await this.requireAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ chartId, linkSharingLevel }),
    });

    if (!response.ok) {
      throw await this.failure(
        'PUT',
        '/managePermissions',
        response,
        'Failed to update link sharing',
      );
    }
  }

  // Approve a pending access request (owner only)
  static async approveAccessRequest(chartId: string, targetUserId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/managePermissions`, {
      method: 'PATCH',
      headers: await this.requireAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ chartId, targetUserId, action: 'approve' }),
    });

    if (!response.ok) {
      throw await this.failure('PATCH', '/managePermissions', response, 'Failed to approve access');
    }
  }

  // Reject a pending access request (owner only)
  static async rejectAccessRequest(chartId: string, targetUserId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/managePermissions`, {
      method: 'PATCH',
      headers: await this.requireAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ chartId, targetUserId, action: 'reject' }),
    });

    if (!response.ok) {
      throw await this.failure('PATCH', '/managePermissions', response, 'Failed to reject access');
    }
  }

  // Delete a chart (owner only, or anyone with the edit token for anonymous charts).
  //
  // The worker's anon branch requires the editToken in the body (see
  // worker/api/deleteChart.ts). Authenticated owner deletes don't need it —
  // the worker takes the chartOwnerId branch and matches by JWT sub against
  // chart_permissions. Passing undefined in the owner case is fine; the
  // editToken is only read on the anon branch.
  static async deleteChart(chartId: string, editToken?: string): Promise<void> {
    // Auth header attaches when a token resolves (owned charts); anon
    // deletes authorize via the editToken in the body.
    const headers = await this.buildHeaders({ 'Content-Type': 'application/json' });

    const body: { chartId: string; editToken?: string } = { chartId };
    if (editToken) {
      body.editToken = editToken;
    }

    const response = await fetch(`${API_BASE}/deleteChart`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw await this.failure('DELETE', '/deleteChart', response, 'Failed to delete chart');
    }
  }
}
