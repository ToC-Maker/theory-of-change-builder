// RequestTokenSource — shared request-time auth-token resolution.
//
// Extracted from ChartService's PR 7 round-2 401 fix so ChartService,
// chatService, and LoggingService share one implementation instead of
// three drifting copies. The problem it solves: a mount-time static
// token snapshot breaks in two real states while the UI still shows the
// user as signed in —
//   1. Auth0 silent refresh fails at mount → the App auth effect clears
//      the static (anonymous fallback) → requests go out with NO Bearer
//      header;
//   2. the ID token expires mid-session → requests go out with an
//      EXPIRED token.
// The worker fails closed on both for the hardened routes (getUserCharts
// 401, updateChart 403, anthropic-stream 401 invalid_token, logging-*
// 401), so the token must be resolved fresh at request time.
//
// Usage: each service owns one instance. The App auth effect registers a
// provider (`() => getFreshIdToken(...)`, which returns the cached ID
// token and transparently refreshes near/after expiry — a cheap local
// claims read on the hot path) and keeps calling `setToken` for the
// legacy static snapshot.

/**
 * Resolves the Bearer token for the next API request. Resolving `null`
 * means "no session right now" — the request goes out anonymous.
 */
export type AuthTokenProvider = () => Promise<string | null>;

export class RequestTokenSource {
  /**
   * Last-known token snapshot. Kept for (1) legacy callers that set a
   * token without registering a provider (tests, ToCViewerOnly's
   * make-a-copy flow), and (2) a fallback when the provider throws.
   */
  private token: string | null = null;

  private provider: AuthTokenProvider | null = null;

  /** @param logTag Prefix for the provider-failure console warning. */
  constructor(private readonly logTag: string) {}

  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  /** Register (or clear, with `null`) the request-time token provider. */
  setProvider(provider: AuthTokenProvider | null): void {
    this.provider = provider;
  }

  /**
   * Token to attach to the request being built right now.
   *
   * Provider registered: its result is authoritative — a fresh token
   * when the session is alive, `null` when it is not (sending a
   * known-stale static would just trade a clean anonymous request for
   * a misleading "expired token" 401). The static snapshot is kept in
   * sync so `hasToken()` reflects reality. If the provider throws
   * (Auth0 SDK hiccup), fall back to the last-known token: possibly
   * stale beats definitely absent.
   *
   * No provider: legacy behavior, the static snapshot.
   */
  async resolve(): Promise<string | null> {
    if (this.provider) {
      try {
        const fresh = await this.provider();
        this.token = fresh;
        return fresh;
      } catch (err) {
        console.warn(
          `[${this.logTag}] auth token provider failed; falling back to last-known token:`,
          err,
        );
        return this.token;
      }
    }
    return this.token;
  }
}
