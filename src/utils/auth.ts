import type { Auth0ContextInterface } from '@auth0/auth0-react';

// Force a refresh when the cached ID token is within this many ms of expiry.
// 60s is enough cushion to outlast a slow request without sending a token that
// expires mid-flight server-side.
const ID_TOKEN_REFRESH_LEEWAY_MS = 60_000;

/**
 * Returns a raw ID token JWT, refreshing via the SDK's silent-auth path when
 * the cached one is expired or near-expiry.
 *
 * Why the explicit exp check: `getAccessTokenSilently()` keys its cache on
 * the access token's exp, not the ID token's. With no `audience` configured
 * the access token is opaque and the SDK can hold onto it (and the stale
 * ID token alongside it) past the ID token's expiration without refreshing.
 * Server-side auth then 401s on `JWTExpired`. See auth0-spa-js#1089 and
 * https://community.auth0.com/t/.../99301 — this is documented Auth0
 * behavior, not a bug. `cacheMode: 'off'` forces the refresh-token exchange
 * regardless of cache state.
 *
 * Returns null on silent-auth failure (refresh token revoked, session
 * expired, network error). Callers should treat null as "not authenticated
 * right now" — do not send API calls that require auth.
 *
 * `onRefreshError` (optional) receives the raw SDK error when the silent
 * refresh throws, BEFORE the null return. The null-return contract erases
 * the error class, but the App-level token provider needs it to tell
 * "transient network blip" from "invalid_grant — the grant is dead, only a
 * re-login fixes it" (see authSessionHealth.ts). Existing callers without
 * the callback are unchanged.
 */
export async function getFreshIdToken(
  getAccessTokenSilently: Auth0ContextInterface['getAccessTokenSilently'],
  getIdTokenClaims: Auth0ContextInterface['getIdTokenClaims'],
  onRefreshError?: (err: unknown) => void,
): Promise<string | null> {
  const cached = await getIdTokenClaims();
  const expMs = typeof cached?.exp === 'number' ? cached.exp * 1000 : 0;
  const needsRefresh = !expMs || Date.now() >= expMs - ID_TOKEN_REFRESH_LEEWAY_MS;

  if (!needsRefresh) {
    return cached?.__raw ?? null;
  }

  try {
    await getAccessTokenSilently({ cacheMode: 'off' });
  } catch (err) {
    // login_required, consent_required, refresh_token_expired, network — all
    // reduce to "we can't refresh the token right now".
    console.warn('[auth] silent token refresh failed:', err);
    onRefreshError?.(err);
    return null;
  }
  const refreshed = await getIdTokenClaims();
  return refreshed?.__raw ?? null;
}
