// Wiring tests for the quota blocker's identity copy + session-expired
// precedence inside ChatInterface (fb5 issue 73).
//
// The pure pieces are covered elsewhere (selectBlocker precedence in
// tests/client/composerBlocker.test.ts, per-variant copy in
// tests/frontend/ComposerBlockerBanner.test.tsx). What only an integration
// render can pin is the plumbing:
//   - /api/usage snapshot → selectBlocker → derived cap_reached → banner,
//     with the identity copy keyed off the server-reported tier;
//   - useAuthSessionDegraded + isAuthenticated → selectBlocker's
//     authSessionDegraded param, so an active SessionExpiredBanner state
//     SUPPRESSES the at-cap quota copy in favor of the re-login deferral
//     (the quota state belongs to the anon actor the dead session demoted
//     us to; "add an API key" would fight the real fix).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatInterface } from '../../src/components/ChatInterface';
import { ApiKeyContext, type ApiKeyContextValue } from '../../src/contexts/useApiKey';
import {
  reportAuthTokenFailure,
  resetAuthSessionHealth,
} from '../../src/services/authSessionHealth';

const mockUseAuth0 = vi.fn();
vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => mockUseAuth0(),
}));

const auth0State = (isAuthenticated: boolean) => ({
  isAuthenticated,
  isLoading: false,
  user: undefined,
  getIdTokenClaims: vi.fn(async () => undefined),
  getAccessTokenSilently: vi.fn(async () => ''),
  loginWithRedirect: vi.fn(),
  logout: vi.fn(),
});

const apiKeyStub: ApiKeyContextValue = {
  hasKey: false,
  keyLast4: null,
  verified: false,
  useForChat: false,
  setUseForChat: vi.fn(),
  submitKey: vi.fn(),
  clearKey: vi.fn(),
  refresh: vi.fn(),
  keyVersion: 0,
};

let usageResponse: { used_usd: number; limit_usd: number; tier: string };

beforeEach(() => {
  resetAuthSessionHealth();
  usageResponse = { used_usd: 5, limit_usd: 5, tier: 'anon' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/usage')) {
        return Response.json(usageResponse);
      }
      return Response.json({});
    }),
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  // RTL does NOT auto-cleanup here (no vitest `globals: true`), and the
  // previous tree subscribes to the module-level auth-session store —
  // without unmounting it, a later test's reportAuthTokenFailure re-renders
  // the stale tree against the new mock state and queries match both trees.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetAuthSessionHealth();
});

function renderChat() {
  return render(
    <MemoryRouter>
      <ApiKeyContext.Provider value={apiKeyStub}>
        <ChatInterface isCollapsed={false} onToggle={() => {}} graphData={null} />
      </ApiKeyContext.Provider>
    </MemoryRouter>,
  );
}

const ANON_CAP_COPY = /You've used all of the free anonymous allowance/;
const ACCOUNT_CAP_COPY = /You've used all of your account's free allowance/;
const SESSION_EXPIRED_COPY = /Your session has expired, so sending is paused/;

describe('ChatInterface quota blocker wiring', () => {
  it('anon at-cap: derived blocker renders the anonymous-allowance copy', async () => {
    usageResponse = { used_usd: 5, limit_usd: 5, tier: 'anon' };
    mockUseAuth0.mockReturnValue(auth0State(false));
    renderChat();

    expect(await screen.findByText(ANON_CAP_COPY, undefined, { timeout: 3000 })).toBeVisible();
    expect(screen.queryByText(SESSION_EXPIRED_COPY)).toBeNull();
  }, 15_000);

  it('signed-in at-cap: account-allowance copy', async () => {
    usageResponse = { used_usd: 5, limit_usd: 5, tier: 'free' };
    mockUseAuth0.mockReturnValue(auth0State(true));
    renderChat();

    expect(await screen.findByText(ACCOUNT_CAP_COPY, undefined, { timeout: 3000 })).toBeVisible();
  }, 15_000);

  it('degraded session at-cap: re-login deferral replaces the quota copy', async () => {
    // The dead-session demotion: Auth0 still says authenticated, but the
    // token provider keeps failing (invalid_grant), so /api/usage answered
    // for the ANON actor. This is exactly the reviewer's round-4/5 state.
    usageResponse = { used_usd: 5, limit_usd: 5, tier: 'anon' };
    mockUseAuth0.mockReturnValue(auth0State(true));
    reportAuthTokenFailure(
      Object.assign(new Error('Unknown or invalid refresh token.'), { error: 'invalid_grant' }),
    );
    renderChat();

    expect(
      await screen.findByText(SESSION_EXPIRED_COPY, undefined, { timeout: 3000 }),
    ).toBeVisible();
    expect(screen.queryByText(ANON_CAP_COPY)).toBeNull();
    expect(screen.queryByText(ACCOUNT_CAP_COPY)).toBeNull();
  }, 15_000);

  it('degraded but anonymous (banner-gate parity): quota copy stays, no deferral', async () => {
    // SessionExpiredBanner gates on isAuthenticated && degraded; the
    // composer deferral must use the same gate so a genuinely-anon user
    // with a stale degraded flag still gets the actionable anon copy.
    usageResponse = { used_usd: 5, limit_usd: 5, tier: 'anon' };
    mockUseAuth0.mockReturnValue(auth0State(false));
    reportAuthTokenFailure(
      Object.assign(new Error('Unknown or invalid refresh token.'), { error: 'invalid_grant' }),
    );
    renderChat();

    expect(await screen.findByText(ANON_CAP_COPY, undefined, { timeout: 3000 })).toBeVisible();
    expect(screen.queryByText(SESSION_EXPIRED_COPY)).toBeNull();
  }, 15_000);
});
