// authSessionHealth — tiny module-level store tracking whether the
// signed-in session can still mint API tokens (PR #34 round-4).
//
// The failure it makes visible: Auth0's refresh-token grant dies
// ("Unknown or invalid refresh token" — rotation reuse-detection killing
// the token family, or absolute-lifetime expiry) while `isAuthenticated`
// stays true from the localstorage cache. Every request-time resolution
// then returns null and the app silently demotes to anonymous: recent
// charts 401, autosaves go out unauthenticated, /api/usage answers for
// the anon actor. Only a re-login mints a new grant. Before this store,
// the sole signal was a console.warn.
//
// Who reports: ONLY the App auth effect's token provider (registered
// exclusively while `isAuthenticated && !authLoading`), so anon flows
// never feed the counter. The App effect resets the store when the user
// is signed out. The banner additionally gates on `isAuthenticated`.
//
// Degradation policy:
//   - definitive failures (invalid_grant family — see
//     isDefinitiveAuthFailure) flip to degraded IMMEDIATELY: they are
//     deterministic and never self-heal, so debouncing only delays help;
//   - anything else (network blips, SDK hiccups) must occur
//     AUTH_SESSION_FAILURE_THRESHOLD times consecutively, so a single
//     transient failure doesn't flap the banner;
//   - any successful token resolution resets to healthy.

/** Consecutive non-definitive failures before the session counts as degraded. */
export const AUTH_SESSION_FAILURE_THRESHOLD = 3;

// Error codes auth0-spa-js surfaces (GenericError#error) that mean "the
// silent path is dead until the user interacts". invalid_grant covers
// revoked/expired/unknown refresh tokens; missing_refresh_token is the
// SDK-side variant when no RT exists and the iframe fallback is off (or
// failed); the *_required family is the OAuth "interaction needed" set
// the iframe fallback reports when the Auth0 session cookie is gone or
// third-party cookies are blocked.
const DEFINITIVE_AUTH_ERROR_CODES = new Set([
  'invalid_grant',
  'missing_refresh_token',
  'login_required',
  'consent_required',
  'interaction_required',
  'mfa_required',
]);

/** True when the error means a re-login is required (it will never self-heal). */
export function isDefinitiveAuthFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { error?: unknown }).error;
  return typeof code === 'string' && DEFINITIVE_AUTH_ERROR_CODES.has(code);
}

let consecutiveFailures = 0;
let degraded = false;
const listeners = new Set<() => void>();

function setDegraded(next: boolean): void {
  if (degraded === next) return;
  degraded = next;
  listeners.forEach((listener) => listener());
}

/** A request-time token resolution produced a usable token. */
export function reportAuthTokenSuccess(): void {
  consecutiveFailures = 0;
  setDegraded(false);
}

/**
 * A request-time token resolution came back empty while the UI shows the
 * user as signed in. `err` (when available) is the silent-refresh error;
 * invalid_grant-family errors degrade immediately, others count toward
 * AUTH_SESSION_FAILURE_THRESHOLD.
 */
export function reportAuthTokenFailure(err?: unknown): void {
  consecutiveFailures += 1;
  if (isDefinitiveAuthFailure(err) || consecutiveFailures >= AUTH_SESSION_FAILURE_THRESHOLD) {
    setDegraded(true);
  }
}

/** Clear all state (sign-out, tests). */
export function resetAuthSessionHealth(): void {
  consecutiveFailures = 0;
  setDegraded(false);
}

/** Subscribe to degraded-state changes; returns the unsubscriber. */
export function subscribeAuthSessionHealth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Snapshot for useSyncExternalStore. */
export function isAuthSessionDegraded(): boolean {
  return degraded;
}
