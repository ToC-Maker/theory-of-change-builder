// SessionExpiredBanner — fixed pill under the TopBar shown when the
// signed-in session can no longer mint API tokens (PR #34 round-4).
//
// Trigger state (see authSessionHealth.ts): Auth0 still reports
// `isAuthenticated` from its localstorage cache, but every request-time
// token resolution fails — classically a revoked refresh-token grant
// ("Unknown or invalid refresh token"). In that state recent charts 401,
// autosaves silently go out unauthenticated, and quota reads answer for
// the anon actor. The ONLY fix is a re-login (new grant), so the banner
// says exactly that and wires the button to the same loginWithRedirect +
// returnTo pattern as ByokPanel's sign-in (land back on the same chart,
// not at `/`).
//
// Render gates: `isAuthenticated && degraded`. Genuinely-anon users never
// see it (their token provider is unregistered, so the store also never
// degrades for them); a recovered token clears it via the store.

import { useAuth0 } from '@auth0/auth0-react';
import { useAuthSessionDegraded } from '../hooks/useAuthSessionDegraded';

export function SessionExpiredBanner() {
  const { isAuthenticated, loginWithRedirect } = useAuth0();
  const degraded = useAuthSessionDegraded();

  if (!isAuthenticated || !degraded) return null;

  return (
    <div
      role="alert"
      className="fixed top-[61px] left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 shadow-md"
    >
      <span className="text-sm text-amber-900">
        Your session has expired — saving and your charts are paused.
      </span>
      <button
        type="button"
        onClick={() => {
          // Same returnTo contract as ByokPanel: preserve the chart URL
          // across the Auth0 redirect (Auth0RedirectHandler in App.tsx
          // consumes auth0_returnTo).
          const returnTo = window.location.pathname + window.location.search;
          localStorage.setItem('auth0_returnTo', returnTo);
          void loginWithRedirect({ appState: { returnTo } });
        }}
        className="shrink-0 rounded-md bg-amber-600 px-3 py-1 text-sm font-medium text-white hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1"
      >
        Sign in again
      </button>
    </div>
  );
}
