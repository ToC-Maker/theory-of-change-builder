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
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
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
// Per-test behavior of POST /api/count-tokens-estimate (fb6 issue 74 wiring
// tests). Defaults to a healthy estimate; tests override with the field-
// incident 503 body to exercise the failure path.
let estimateImpl: () => Promise<Response>;

const healthyEstimate = () =>
  Promise.resolve(
    Response.json({
      input_tokens: 10000,
      estimated_cost_usd: 0.07,
      stripped_file_blocks: 0,
      uncounted_file_ids: [],
      cached_file_tokens: 0,
      cached_file_tokens_draft: 0,
      cached_file_tokens_history: 0,
    }),
  );

// Verbatim field-incident body (fb6 issue 74): the reviewer found this in
// the Network tab while the UI showed nothing.
const fieldIncident503 = () =>
  Promise.resolve(
    Response.json(
      {
        error: 'estimation_unavailable',
        upstream_status: 403,
        upstream_message: 'Request not allowed',
      },
      { status: 503 },
    ),
  );

beforeEach(() => {
  resetAuthSessionHealth();
  usageResponse = { used_usd: 5, limit_usd: 5, tier: 'anon' };
  estimateImpl = healthyEstimate;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/usage')) {
        return Response.json(usageResponse);
      }
      if (url.includes('/api/count-tokens-estimate')) {
        return estimateImpl();
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

// ---------------------------------------------------------------------------
// Estimate visibility while quota-blocked (fb6 issue 74)
// ---------------------------------------------------------------------------
//
// Field incident, second occurrence: a quota-exhausted reviewer with an
// upstream estimate failure saw NO estimate-related message anywhere — the
// under-textarea estimate cluster (figure + failure note) clips below the
// fold once the blocker stack is up (reproduced in-browser at 1366x662;
// the composer column does not scroll). The fix carries the estimate
// status INSIDE the blocker banner for quota variants and suppresses the
// under-textarea cluster there (single source of truth at a time). These
// tests pin that wiring end-to-end: stubbed /api/usage at-cap + stubbed
// /api/count-tokens-estimate + a typed draft.

const REGION_NOTE_COPY =
  /Cost estimates are unavailable: the AI service refused the request from this region\. Chat and generation are affected too\./;
const STILL_WORK_COPY =
  /Estimates still work: your current draft is about \$\d+\.\d+ of input cost\./;
const PLACEHOLDER = 'Ask about your Theory of Change...';

async function typeDraft(text: string) {
  const textarea = await screen.findByPlaceholderText(PLACEHOLDER);
  fireEvent.change(textarea, { target: { value: text } });
}

describe('estimate visibility while quota-blocked (fb6 issue 74)', () => {
  it('failure note (with mapped upstream reason) is visible alongside the blocker; under-textarea cluster suppressed', async () => {
    usageResponse = { used_usd: 5, limit_usd: 5, tier: 'anon' };
    estimateImpl = fieldIncident503;
    mockUseAuth0.mockReturnValue(auth0State(false));
    renderChat();

    expect(await screen.findByText(ANON_CAP_COPY, undefined, { timeout: 3000 })).toBeVisible();
    await typeDraft('draft that will fail to estimate');

    // The mapped note appears (debounced estimate → 503 → failure state).
    expect(await screen.findByText(REGION_NOTE_COPY, undefined, { timeout: 3000 })).toBeVisible();
    // Exactly once: the banner carries it; the under-textarea duplicate is
    // suppressed while a quota blocker is rendered.
    expect(screen.getAllByText(REGION_NOTE_COPY)).toHaveLength(1);
    // The old under-textarea cluster is gone in the blocked state: no
    // estimate row (its "output shown live during streaming" promise is
    // incoherent while sending is paused).
    expect(screen.queryByText(/Estimated input cost:/)).toBeNull();
    // Blocker copy still up — the note rides alongside it, not instead.
    expect(screen.getByText(ANON_CAP_COPY)).toBeVisible();
  }, 15_000);

  it('healthy estimate stays visible while quota-blocked (capped users see what a send WOULD cost)', async () => {
    usageResponse = { used_usd: 5, limit_usd: 5, tier: 'anon' };
    estimateImpl = healthyEstimate;
    mockUseAuth0.mockReturnValue(auth0State(false));
    renderChat();

    expect(await screen.findByText(ANON_CAP_COPY, undefined, { timeout: 3000 })).toBeVisible();
    await typeDraft('healthy estimate draft');

    expect(await screen.findByText(STILL_WORK_COPY, undefined, { timeout: 3000 })).toBeVisible();
    // No duplicated figure: the under-textarea estimate row is suppressed.
    expect(screen.queryByText(/Estimated input cost:/)).toBeNull();
    expect(screen.queryByText(/Cost estimates are/)).toBeNull();
  }, 15_000);

  it('session-expired keeps top precedence; estimate failure rides inside the single deferral banner', async () => {
    usageResponse = { used_usd: 5, limit_usd: 5, tier: 'anon' };
    estimateImpl = fieldIncident503;
    mockUseAuth0.mockReturnValue(auth0State(true));
    reportAuthTokenFailure(
      Object.assign(new Error('Unknown or invalid refresh token.'), { error: 'invalid_grant' }),
    );
    renderChat();

    expect(
      await screen.findByText(SESSION_EXPIRED_COPY, undefined, { timeout: 3000 }),
    ).toBeVisible();
    await typeDraft('draft while session expired and estimates down');

    expect(await screen.findByText(REGION_NOTE_COPY, undefined, { timeout: 3000 })).toBeVisible();
    // Precedence unchanged: quota copy stays deferred.
    expect(screen.queryByText(ANON_CAP_COPY)).toBeNull();
    expect(screen.queryByText(ACCOUNT_CAP_COPY)).toBeNull();
    // No pileup: one deferral banner, one quiet note, no under-textarea
    // duplicates.
    expect(screen.getAllByText(REGION_NOTE_COPY)).toHaveLength(1);
    expect(screen.getAllByText(SESSION_EXPIRED_COPY)).toHaveLength(1);
    expect(screen.queryByText(/Estimated input cost:/)).toBeNull();
  }, 15_000);

  it('unblocked control: under-cap usage keeps the under-textarea cluster (estimate row + failure note)', async () => {
    usageResponse = { used_usd: 0.5, limit_usd: 5, tier: 'anon' };
    estimateImpl = fieldIncident503;
    mockUseAuth0.mockReturnValue(auth0State(false));
    renderChat();

    await typeDraft('under-cap draft with failing estimate');

    // The mapped note shows under the textarea, with the rough-fallback
    // disclosure appended, and the estimate row stays.
    expect(await screen.findByText(REGION_NOTE_COPY, undefined, { timeout: 3000 })).toBeVisible();
    expect(screen.getByText(/Fell back to a rough local estimate/)).toBeVisible();
    expect(screen.getByText(/Estimated input cost:/)).toBeVisible();
    expect(screen.queryByText(ANON_CAP_COPY)).toBeNull();
  }, 15_000);
});
