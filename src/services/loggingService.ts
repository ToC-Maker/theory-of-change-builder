const API_BASE = '/.netlify/functions';

export interface LoggingSession {
  session_id: string;
  chart_id: string;
  user_id?: string;
  started_at: string;
  ended_at?: string;
}

class LoggingServiceClass {
  private currentSessionId: string | null = null;
  private currentChartId: string | null = null;
  private sessionTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly SESSION_DURATION_MS = 30 * 60 * 1000; // 30 minutes

  // Circuit breaker state
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly MAX_FAILURES = 3;
  private readonly RESET_AFTER_MS = 60000; // 1 minute

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
   * Circuit breaker: check if we should skip logging due to repeated failures
   */
  private shouldSkipLogging(): boolean {
    if (Date.now() - this.lastFailureTime > this.RESET_AFTER_MS) {
      this.failureCount = 0;
    }
    return this.failureCount >= this.MAX_FAILURES;
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
   * Initialize or resume a session
   * IMPORTANT: Only call this AFTER chart data is fully loaded
   */
  async initializeSession(chartId: string): Promise<string | null> {
    // Don't initialize if user has opted out
    if (this.isOptedOut()) {
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
      await this.createSession(sessionId, chartId);

      this.currentSessionId = sessionId;
      this.currentChartId = chartId;
      localStorage.setItem('loggingSessionId', sessionId);
      localStorage.setItem('loggingChartId', chartId);
      this.resetSessionTimeout();
      this.recordSuccess();

      return sessionId;
    } catch (error) {
      console.error('[LoggingService] Failed to create session:', error);
      this.recordFailure();
      return null;
    }
  }

  /**
   * Create session on backend
   */
  private async createSession(sessionId: string, chartId: string): Promise<void> {
    if (this.shouldSkipLogging()) {
      throw new Error('Circuit breaker open - skipping logging');
    }

    const token = this.getAuthToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE}/logging-createSession`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session_id: sessionId,
        chart_id: chartId,
        user_agent: navigator.userAgent,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.status}`);
    }
  }

  /**
   * End current session
   */
  async endSession(): Promise<void> {
    if (!this.currentSessionId || this.shouldSkipLogging()) return;

    try {
      await fetch(`${API_BASE}/logging-endSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: this.currentSessionId }),
      });
      this.recordSuccess();
    } catch (error) {
      console.error('[LoggingService] Failed to end session:', error);
      this.recordFailure();
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
   * Set opt-out preference (called from PrivacyPolicyPopup)
   */
  setOptOut(optOut: boolean): void {
    localStorage.setItem('usageLoggingOptOut', optOut ? 'true' : 'false');
    // If opting out, end any current session
    if (optOut && this.currentSessionId) {
      this.endSession();
    }
  }

  /**
   * Check if circuit breaker is allowing requests
   */
  isLoggingEnabled(): boolean {
    return !this.isOptedOut() && !this.shouldSkipLogging();
  }

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

    const token = this.getAuthToken();
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    try {
      const response = await fetch(`${API_BASE}/logging-saveMessage`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          session_id: this.currentSessionId,
          ...data,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to save message: ${response.status}`);
      }
      this.recordSuccess();
    } catch (error) {
      console.error('[LoggingService] Failed to save message:', error);
      this.recordFailure();
      // Don't throw - logging failures shouldn't break the app
    }
  }
}

export const loggingService = new LoggingServiceClass();

// Export the class for static method access
export { LoggingServiceClass };
