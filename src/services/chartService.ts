import { ToCData } from '../types';
import type { LinkSharingLevel, Permission } from '../../shared/permissions';

export type { LinkSharingLevel, Permission, PermissionStatus } from '../../shared/permissions';

const API_BASE = '/api';

export interface CreateChartResponse {
  chartId: string;
  editToken: string;
  viewUrl: string;
  editUrl: string;
}

export interface GetChartResponse {
  chartData: ToCData;
  chartId: string;
  canEdit: boolean;
  // true iff the server verified the caller's JWT and their sub matches the
  // chart owner's sub. Used by the client to gate owner-only fetches
  // (managePermissions) so we don't spam 403s for non-owned charts. Missing
  // on older server responses, treat `undefined` as `false`.
  isOwner?: boolean;
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

/**
 * Resolves the Bearer token for the next API request. Registered by the
 * App-level auth effect as `() => getFreshIdToken(...)`, which returns
 * the cached Auth0 ID token and transparently refreshes it when it is
 * near/after expiry. Resolving `null` means "no session right now" —
 * the request goes out anonymous.
 */
export type AuthTokenProvider = () => Promise<string | null>;

export class ChartService {
  // Last-known token snapshot. Kept for two reasons: (1) legacy callers
  // (ToCViewerOnly's make-a-copy flow, tests) that set a token without
  // registering a provider, and (2) a fallback when the provider
  // itself throws.
  private static authToken: string | null = null;

  // Request-time token source. PR 7 round-2 fix: the worker now
  // requires a valid Bearer JWT on getUserCharts (and on updateChart
  // for owned, restricted charts), and the mount-time static snapshot
  // alone proved unreliable — it is intentionally nulled when Auth0
  // silent refresh fails, and it silently expires mid-session. The
  // signed-in 401s + "chart isn't saved" report came from exactly
  // those states. Resolving the token per request via this provider
  // keeps it fresh for as long as the Auth0 session can be refreshed.
  private static authTokenProvider: AuthTokenProvider | null = null;

  // Set the auth token (called from components with useAuth0 hook)
  static setAuthToken(token: string | null) {
    this.authToken = token;
  }

  // Check if auth token is set
  static hasAuthToken(): boolean {
    return this.authToken !== null;
  }

  /**
   * Register (or clear, with `null`) the request-time token provider.
   * Called from the App auth effect alongside `setAuthToken`.
   */
  static setAuthTokenProvider(provider: AuthTokenProvider | null) {
    this.authTokenProvider = provider;
  }

  /**
   * Token to attach to the request being built right now.
   *
   * Provider registered: its result is authoritative — a fresh token
   * when the session is alive, `null` when it is not (sending a
   * known-stale static would just trade a clean anonymous request for
   * a misleading "expired token" 401). The static snapshot is kept in
   * sync so `hasAuthToken()` reflects reality. If the provider throws
   * (Auth0 SDK hiccup), fall back to the last-known token: possibly
   * stale beats definitely absent.
   *
   * No provider: legacy behavior, the static snapshot.
   */
  private static async resolveAuthToken(): Promise<string | null> {
    if (this.authTokenProvider) {
      try {
        const fresh = await this.authTokenProvider();
        this.authToken = fresh;
        return fresh;
      } catch (err) {
        console.warn(
          '[ChartService] auth token provider failed; falling back to last-known token:',
          err,
        );
        return this.authToken;
      }
    }
    return this.authToken;
  }

  /** Build request headers, attaching Authorization when a token resolves. */
  private static async buildHeaders(
    base: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const token = await this.resolveAuthToken();
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

  static async createChart(chartData: ToCData): Promise<CreateChartResponse> {
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
      throw new Error('Failed to create chart');
    }

    return response.json();
  }

  static async getChart(chartId: string): Promise<ToCData> {
    const params = new URLSearchParams();
    params.append('chartId', chartId);

    const response = await fetch(`${API_BASE}/getChart?${params}`);

    if (!response.ok) {
      throw new Error('Failed to fetch chart');
    }

    const result = await response.json();
    return result.chartData;
  }

  static async getChartByEditToken(editToken: string): Promise<GetChartResponse> {
    const headers = await this.buildHeaders();

    const params = new URLSearchParams();
    params.append('editToken', editToken);

    const response = await fetch(`${API_BASE}/getChart?${params}`, {
      headers,
    });

    if (!response.ok) {
      // Try to get error message from response
      let errorMessage = 'Failed to fetch chart';
      try {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } catch {
        // If JSON parsing fails, use status-based messages
        if (response.status === 401) {
          errorMessage = 'Authentication required. Please log in to access this chart.';
        } else if (response.status === 404) {
          errorMessage = 'Chart not found. It may have been deleted.';
        }
      }
      throw new Error(errorMessage);
    }

    return response.json();
  }

  static async updateChart(editToken: string, chartData: ToCData): Promise<void> {
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

    const response = await fetch(`${API_BASE}/updateChart`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ editToken, chartData }),
    });

    if (!response.ok) {
      // Prefer the worker's explanation (e.g. "Invalid or expired
      // authentication. Please log in again.") — it feeds the
      // SaveIndicator tooltip, where "Failed to update chart" gives the
      // user nothing to act on.
      let message = 'Failed to update chart';
      try {
        const errorData = (await response.json()) as { error?: string };
        if (errorData?.error) {
          message = errorData.error;
        }
      } catch {
        // Non-JSON body (proxy error page etc.) — keep the generic message.
      }
      throw new Error(message);
    }
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
      throw new Error('Failed to fetch user charts');
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
      const error = await response.json();
      throw new Error(error.error || 'Failed to fetch chart permissions');
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
      const error = await response.json();
      throw new Error(error.error || 'Failed to remove permission');
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
      const error = await response.json();
      throw new Error(error.error || 'Failed to update permission');
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
      const error = await response.json();
      throw new Error(error.error || 'Failed to update link sharing');
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
      const error = await response.json();
      throw new Error(error.error || 'Failed to approve access');
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
      const error = await response.json();
      throw new Error(error.error || 'Failed to reject access');
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
      const error = await response.json();
      throw new Error(error.error || 'Failed to delete chart');
    }
  }
}
