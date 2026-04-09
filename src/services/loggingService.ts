import { ToCData } from '../types';
import { EditInstruction } from '../utils/graphEdits';

const API_BASE = '/api';

export interface SaveSnapshotParams {
  session_id: string;
  chart_id: string;
  graph_data: ToCData;
  edit_type: 'ai_edit' | 'manual_edit' | 'undo' | 'redo' | 'initial';
  triggered_by_message_id?: string | null;
  edit_instructions?: EditInstruction[] | null;
  edit_success?: boolean;
  error_message?: string | null;
}

class LoggingServiceClass {
  private currentSessionId: string | null = null;
  private currentChartId: string | null = null;
  private sessionTimeout: ReturnType<typeof setTimeout> | null = null;
  private initializingPromise: Promise<string | null> | null = null;
  private initializingChartId: string | null = null;
  private readonly SESSION_DURATION_MS = 30 * 60 * 1000; // 30 minutes

  // Circuit breaker state
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly MAX_FAILURES = 3;
  private readonly RESET_AFTER_MS = 60000; // 1 minute

  // Beacon rate limit (separate from circuit breaker to avoid flooding via sendBeacon)
  private lastBeaconTime = 0;
  private readonly BEACON_COOLDOWN_MS = 30000; // 30 seconds

  // Snapshot debounce state
  private snapshotTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingSnapshot: SaveSnapshotParams | null = null;
  private readonly DEBOUNCE_MS = 2000; // 2 second debounce

  // Static auth token (set from App.tsx, mirrors ChartService pattern)
  private static authToken: string | null = null;

  /**
   * Set auth token (called from App.tsx, mirrors ChartService pattern)
   */
  static setAuthToken(token: string | null) {
    LoggingServiceClass.authToken = token;
  }

  /**
   * Get current auth token
   */
  getAuthToken(): string | null {
    return LoggingServiceClass.authToken;
  }

  /**
   * Circuit breaker: check if we should skip logging due to repeated failures.
   * Pure check with no side effects — reset happens only on success via recordSuccess().
   */
  private shouldSkipLogging(): boolean {
    if (this.failureCount >= this.MAX_FAILURES) {
      // Allow a retry after the reset window
      return Date.now() - this.lastFailureTime <= this.RESET_AFTER_MS;
    }
    return false;
  }

  /**
   * Circuit breaker: record a failure
   */
  private recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
  }

  /**
   * Circuit breaker: reset on success
   */
  private recordSuccess(): void {
    this.failureCount = 0;
  }

  /**
   * Build headers with auth token for API requests
   */
  private buildHeaders(): HeadersInit {
    const headers: HeadersInit = { 'Content-Type': 'application/json' };
    const token = this.getAuthToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  /**
   * Execute a fetch with circuit breaker protection.
   * Records success/failure automatically. Returns the Response on success,
   * or undefined if the circuit breaker is open or the request fails.
   */
  private async fetchWithCircuitBreaker(
    url: string,
    options: RequestInit
  ): Promise<Response | undefined> {
    if (this.shouldSkipLogging()) return undefined;

    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.recordSuccess();
      return response;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Initialize or resume a session
   * IMPORTANT: Only call this AFTER chart data is fully loaded
   */
  async initializeSession(chartId: string): Promise<string | null> {
    // Deduplicate concurrent calls for the same chart
    if (this.initializingPromise) {
      if (this.initializingChartId === chartId) {
        return this.initializingPromise;
      }
      // Different chart requested — wait for the current init to finish, then start a new one
      await this.initializingPromise;
    }
    this.initializingChartId = chartId;
    this.initializingPromise = this.doInitializeSession(chartId);
    try {
      return await this.initializingPromise;
    } finally {
      this.initializingPromise = null;
      this.initializingChartId = null;
    }
  }

  private async doInitializeSession(chartId: string): Promise<string | null> {
    // Don't initialize if user has opted out or circuit breaker is open
    if (this.isOptedOut() || this.shouldSkipLogging()) {
      return null;
    }

    // Check if we have an existing valid session for this chart
    const existingSessionId = localStorage.getItem('loggingSessionId');
    const existingChartId = localStorage.getItem('loggingChartId');
    const sessionExpiry = localStorage.getItem('loggingSessionExpiry');

    if (existingSessionId && sessionExpiry && existingChartId === chartId) {
      const expiryTime = parseInt(sessionExpiry, 10);
      if (Date.now() < expiryTime) {
        // Session still valid for this chart
        this.currentSessionId = existingSessionId;
        this.currentChartId = chartId;
        this.resetSessionTimeout();
        return existingSessionId;
      }
    }

    // Create new session
    const sessionId = crypto.randomUUID();

    try {
      const response = await this.fetchWithCircuitBreaker(
        `${API_BASE}/logging-createSession`,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify({
            session_id: sessionId,
            chart_id: chartId,
            user_agent: navigator.userAgent,
          }),
        }
      );

      if (!response) {
        return null; // Circuit breaker open
      }

      // Check if server indicated user has opted out
      const body = await response.json().catch(() => null);
      if (body?.opted_out) {
        return null;
      }

      this.currentSessionId = sessionId;
      this.currentChartId = chartId;
      localStorage.setItem('loggingSessionId', sessionId);
      localStorage.setItem('loggingChartId', chartId);
      this.resetSessionTimeout();

      return sessionId;
    } catch (error) {
      console.error('[LoggingService] Failed to create session:', error);
      return null;
    }
  }

  /**
   * End current session
   */
  async endSession(): Promise<void> {
    if (!this.currentSessionId || this.shouldSkipLogging()) return;

    try {
      await this.fetchWithCircuitBreaker(
        `${API_BASE}/logging-endSession`,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify({ session_id: this.currentSessionId }),
        }
      );
      this.clearSession();
    } catch (error) {
      console.error('[LoggingService] Failed to end session:', error);
      // Don't clear session state on failure — allows retry
    }
  }

  /**
   * End session via sendBeacon (reliable on page unload)
   */
  endSessionBeacon(): void {
    if (!this.currentSessionId || !this.isLoggingEnabled()) return;
    const blob = new Blob(
      [JSON.stringify({ session_id: this.currentSessionId })],
      { type: 'application/json' }
    );
    const queued = navigator.sendBeacon(`${API_BASE}/logging-endSession`, blob);
    if (!queued) {
      console.warn('[LoggingService] sendBeacon failed — payload may exceed ~64KB limit');
    }
    this.clearSession();
  }

  /**
   * Reset session timeout (call on user activity - throttled externally)
   */
  resetSessionTimeout(): void {
    if (this.sessionTimeout) {
      clearTimeout(this.sessionTimeout);
    }

    const expiryTime = Date.now() + this.SESSION_DURATION_MS;
    localStorage.setItem('loggingSessionExpiry', expiryTime.toString());

    this.sessionTimeout = setTimeout(() => {
      this.endSession();
    }, this.SESSION_DURATION_MS);
  }

  /**
   * Clear session data
   */
  private clearSession(): void {
    this.currentSessionId = null;
    this.currentChartId = null;
    localStorage.removeItem('loggingSessionId');
    localStorage.removeItem('loggingChartId');
    localStorage.removeItem('loggingSessionExpiry');
    if (this.sessionTimeout) {
      clearTimeout(this.sessionTimeout);
      this.sessionTimeout = null;
    }
  }

  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Get current chart ID for the session
   */
  getCurrentChartId(): string | null {
    return this.currentChartId;
  }

  /**
   * Check if user has opted out of logging
   * Returns true if:
   * - User explicitly opted out via checkbox
   * - User hasn't accepted privacy policy yet (no consent = no logging)
   */
  isOptedOut(): boolean {
    // No logging until privacy policy is accepted
    if (localStorage.getItem('privacyPolicyAccepted') !== 'true') {
      return true;
    }
    return localStorage.getItem('usageLoggingOptOut') === 'true';
  }

  /**
   * Set opt-out preference (called from PrivacyPolicyPopup and Settings modal)
   * Saves to localStorage and syncs to server for authenticated users.
   */
  setOptOut(optOut: boolean): void {
    localStorage.setItem('usageLoggingOptOut', optOut ? 'true' : 'false');
    // If opting out, end any current session
    if (optOut && this.currentSessionId) {
      this.endSession();
    }
    // Sync to server for authenticated users
    this.syncPreferenceToServer(optOut);
  }

  /**
   * Sync opt-out preference to server (for authenticated users).
   * Fire-and-forget — failures don't affect the local preference.
   * Server sync is best-effort; local preference takes effect immediately.
   */
  private async syncPreferenceToServer(optOut: boolean): Promise<void> {
    const token = this.getAuthToken();
    if (!token) return; // Anonymous users: local-only

    try {
      const response = await fetch(`${API_BASE}/logging-preference`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ opted_out: optOut }),
      });
      if (!response.ok) {
        console.error(
          `[LoggingService] Server rejected preference sync: HTTP ${response.status}`
        );
      }
    } catch (error) {
      console.error('[LoggingService] Failed to sync preference to server:', error);
    }
  }

  /**
   * Fetch server-side preference and sync to localStorage.
   * Call this after login / when auth token becomes available.
   * Server is source of truth for authenticated users: overwrites local preference.
   */
  async syncPreferenceFromServer(): Promise<void> {
    const token = this.getAuthToken();
    if (!token) return;

    try {
      const response = await fetch(`${API_BASE}/logging-preference`, {
        method: 'GET',
        headers: this.buildHeaders(),
      });
      if (!response.ok) {
        console.warn(
          `[LoggingService] Failed to fetch preference from server: HTTP ${response.status}`
        );
        return;
      }

      const data = await response.json();
      if (data.has_record === false) {
        // First login: server has no preference record for this user.
        // Clear localStorage so the privacy popup re-shows for an explicit choice.
        localStorage.removeItem('privacyPolicyAccepted');
        localStorage.removeItem('usageLoggingOptOut');
        return;
      }
      if (typeof data.opted_out === 'boolean') {
        localStorage.setItem('usageLoggingOptOut', data.opted_out ? 'true' : 'false');
      }
    } catch (error) {
      console.error('[LoggingService] Failed to fetch preference from server:', error);
    }
  }

  /**
   * Check if circuit breaker is allowing requests
   */
  isLoggingEnabled(): boolean {
    return !this.isOptedOut() && !this.shouldSkipLogging();
  }

  // ---------------------------------------------------------------------------
  // Error reporting
  // ---------------------------------------------------------------------------

  /**
   * Report a client-side error to the backend. Fire-and-forget: never throws.
   * Does NOT require an active logging session (errors may occur before session init).
   */
  reportError(error: {
    error_name: string;
    error_message: string;
    http_status?: number;
    stack_trace?: string;
    chart_id?: string;
    request_metadata?: Record<string, unknown>;
  }): void {
    // Only check circuit breaker, not opt-out. Error reports are operational
    // diagnostics (not AI improvement data), so they aren't subject to the
    // usage data opt-out.

    const payload = {
      error_id: crypto.randomUUID(),
      error_name: error.error_name,
      error_message: error.error_message,
      http_status: error.http_status,
      stack_trace: error.stack_trace?.slice(0, 4096),
      user_agent: navigator.userAgent,
      chart_id: error.chart_id || this.currentChartId || undefined,
      session_id: this.currentSessionId || undefined,
      request_metadata: error.request_metadata,
    };

    if (this.shouldSkipLogging()) {
      // Circuit breaker is open for fetch, but try sendBeacon as a
      // last resort (different transport, may work when fetch can't).
      // Rate-limited separately to prevent flooding.
      this.sendErrorBeacon(payload);
      return;
    }

    const url = `${API_BASE}/logging-reportError`;

    // Fire-and-forget: no await, errors caught internally.
    // If fetch fails (e.g. broken QUIC connection), fall back to sendBeacon
    // which uses a different browser transport mechanism.
    this.fetchWithCircuitBreaker(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.error('[LoggingService] Failed to report error via fetch, trying sendBeacon:', err);
      this.sendErrorBeacon(payload);
    });
  }

  /**
   * Last-resort error reporting via sendBeacon. Used when fetch fails
   * (broken QUIC connection) or when the circuit breaker is open.
   * Note: sendBeacon cannot send custom headers, so the Authorization
   * token is lost and user_id will be null in the error row.
   * The backend already accepts anonymous reports so data still arrives.
   */
  private sendErrorBeacon(payload: Record<string, unknown>): void {
    const now = Date.now();
    if (now - this.lastBeaconTime < this.BEACON_COOLDOWN_MS) return;
    this.lastBeaconTime = now;

    try {
      const url = `${API_BASE}/logging-reportError`;
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      const queued = navigator.sendBeacon(url, blob);
      if (!queued) {
        console.error('[LoggingService] sendBeacon failed — browser beacon queue may be full or payload too large');
      }
    } catch (beaconErr) {
      console.error('[LoggingService] sendBeacon fallback error:', beaconErr);
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot methods (moved from snapshotService)
  // ---------------------------------------------------------------------------

  /**
   * Save snapshot immediately (for AI edits and initial snapshots).
   * Also called internally after the debounce period.
   */
  async saveSnapshot(params: SaveSnapshotParams): Promise<void> {
    if (!this.isLoggingEnabled()) return;

    try {
      await this.fetchWithCircuitBreaker(
        `${API_BASE}/logging-saveSnapshot`,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(params),
        }
      );
    } catch (error) {
      console.error('[LoggingService] Failed to save snapshot:', error);
      // Don't throw - logging failures shouldn't break the app
    }
  }

  /**
   * Save snapshot with debouncing (for manual edits).
   * Batches rapid edits into a single snapshot.
   */
  saveSnapshotDebounced(params: SaveSnapshotParams): void {
    if (!this.isLoggingEnabled()) return;

    this.pendingSnapshot = params;

    if (this.snapshotTimeout) {
      clearTimeout(this.snapshotTimeout);
    }

    this.snapshotTimeout = setTimeout(async () => {
      if (this.pendingSnapshot) {
        await this.saveSnapshot(this.pendingSnapshot);
        this.pendingSnapshot = null;
      }
    }, this.DEBOUNCE_MS);
  }

  /**
   * Flush any pending debounced snapshot via sendBeacon (reliable on page unload)
   */
  flushPendingSnapshot(): void {
    if (this.snapshotTimeout) {
      clearTimeout(this.snapshotTimeout);
      this.snapshotTimeout = null;
    }
    if (this.pendingSnapshot) {
      if (!this.isLoggingEnabled()) {
        this.pendingSnapshot = null;
        return;
      }
      const blob = new Blob(
        [JSON.stringify(this.pendingSnapshot)],
        { type: 'application/json' }
      );
      const queued = navigator.sendBeacon(`${API_BASE}/logging-saveSnapshot`, blob);
      if (!queued) {
        console.warn('[LoggingService] sendBeacon failed — payload may exceed ~64KB limit');
      }
      this.pendingSnapshot = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Message logging
  // ---------------------------------------------------------------------------

  /**
   * Save a message to the logging backend
   */
  async saveMessage(data: {
    message_id: string;
    chart_id: string;
    role: 'user' | 'assistant';
    content: string;
    usage_input_tokens?: number;
    usage_output_tokens?: number;
    usage_total_tokens?: number;
  }): Promise<void> {
    // Skip if user has opted out or no active session
    if (!this.isLoggingEnabled() || !this.currentSessionId) {
      return;
    }

    try {
      await this.fetchWithCircuitBreaker(
        `${API_BASE}/logging-saveMessage`,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify({
            session_id: this.currentSessionId,
            ...data,
          }),
        }
      );
    } catch (error) {
      console.error('[LoggingService] Failed to save message:', error);
      // Don't throw - logging failures shouldn't break the app
    }
  }

  // ---------------------------------------------------------------------------
  // High-level convenience methods (for ChatInterface)
  // ---------------------------------------------------------------------------

  /**
   * Log a user or assistant message. Guards on active session internally.
   */
  logUserMessage(params: {
    messageId: string;
    role: 'user' | 'assistant';
    content: string;
    tokenUsage?: { input_tokens?: number; output_tokens?: number };
  }): void {
    const chartId = this.currentChartId;
    if (!chartId) return;

    this.saveMessage({
      message_id: params.messageId,
      chart_id: chartId,
      role: params.role,
      content: params.content,
      usage_input_tokens: params.tokenUsage?.input_tokens,
      usage_output_tokens: params.tokenUsage?.output_tokens,
      usage_total_tokens: params.tokenUsage
        ? (params.tokenUsage.input_tokens || 0) + (params.tokenUsage.output_tokens || 0)
        : undefined,
    });
  }

  /**
   * Log an AI edit (success or failure). Guards on active session internally.
   */
  logAIEdit(params: {
    graphData: ToCData;
    messageId: string;
    editInstructions: EditInstruction[];
    success: boolean;
    error?: string;
  }): void {
    const sessionId = this.currentSessionId;
    const chartId = this.currentChartId;
    if (!sessionId || !chartId) return;

    this.saveSnapshot({
      session_id: sessionId,
      chart_id: chartId,
      graph_data: params.graphData,
      edit_type: 'ai_edit',
      triggered_by_message_id: params.messageId,
      edit_instructions: params.editInstructions,
      edit_success: params.success,
      error_message: params.success ? null : (params.error || 'Unknown error'),
    });
  }
}

export const loggingService = new LoggingServiceClass();

// Export the class for static method access
export { LoggingServiceClass };
