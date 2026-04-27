import type { Auth0ContextInterface } from '@auth0/auth0-react';

/**
 * Returns a fresh raw ID token JWT, refreshed via the SDK's silent-auth path
 * before being read. `getAccessTokenSilently()` triggers a refresh-token
 * exchange (needs `offline_access` scope, configured in main.tsx), which
 * also rotates the ID token kept in the SDK cache. `getIdTokenClaims()`
 * then reads that freshly-rotated ID token.
 *
 * Returns null on silent-auth failure (refresh token revoked, session
 * expired, network error). Callers should treat null as "not authenticated
 * right now" — do not send API calls that require auth.
 */
export async function getFreshIdToken(
  getAccessTokenSilently: Auth0ContextInterface['getAccessTokenSilently'],
  getIdTokenClaims: Auth0ContextInterface['getIdTokenClaims'],
): Promise<string | null> {
  try {
    await getAccessTokenSilently();
  } catch (err) {
    // login_required, consent_required, refresh_token_expired, network — all
    // reduce to "we can't refresh the token right now".
    console.warn('[auth] silent token refresh failed:', err);
    return null;
  }
  const claims = await getIdTokenClaims();
  return claims?.__raw ?? null;
}
