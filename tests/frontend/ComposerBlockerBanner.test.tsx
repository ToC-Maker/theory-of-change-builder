// Copy-pinning tests for ComposerBlockerBanner (fb5 issue 73).
//
// Round-5 reviewer feedback: the at-cap blocker read as "estimation is
// broken". The copy failed to say (a) WHAT is blocked (sending, not the
// app), (b) WHY (free allowance exhausted), (c) WHO the user is right now
// (anonymous vs signed in; the reviewer was unknowingly anon after an auth
// failure), and (d) WHAT TO DO (sign in / add a key / re-login).
//
// Contract pinned here, verbatim per state:
//   - quota variants name the identity that owns the exhausted allowance
//     ("the free anonymous allowance" when the server answered for an anon
//     actor, "your account's free allowance" when it answered for an
//     account row) and name the action (anon users must sign in BEFORE a
//     key can be added — BYOK keys bind to an Auth0 sub, and signing in
//     does NOT grant a fresh allowance because anon spend folds into the
//     account row, so "sign in AND add your own key" is the only truthful
//     unblock);
//   - identity comes from `usage.tier` when a snapshot exists (the server's
//     view of whose quota row answered), falling back to isAuthenticated;
//   - `session_expired_quota` (selectBlocker's degraded-session deferral)
//     does NOT push API keys; it explains the temporary anon demotion and
//     routes to the same re-login as SessionExpiredBanner (returnTo
//     contract included);
//   - non-quota variants (global_budget, advisory) keep their existing
//     identity-independent rendering.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ComposerBlockerBanner } from '../../src/components/chat/ComposerBlockerBanner';
import type { EstimateFailure, RenderedBlocker } from '../../src/components/chat/composerBlocker';

const mockUseAuth0 = vi.fn();
vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => mockUseAuth0(),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

type Usage = { used_usd: number; limit_usd: number; tier: string } | null;

function renderBanner(params: {
  blocker: RenderedBlocker;
  usage?: Usage;
  isAuthenticated?: boolean;
  hasKey?: boolean;
  composerEstimateUsd?: number;
  estimateFailure?: EstimateFailure | null;
  loginWithRedirect?: ReturnType<typeof vi.fn>;
}) {
  mockUseAuth0.mockReturnValue({
    isAuthenticated: params.isAuthenticated ?? false,
    loginWithRedirect: params.loginWithRedirect ?? vi.fn(),
  });
  return render(
    <ComposerBlockerBanner
      blocker={params.blocker}
      usage={params.usage ?? null}
      hasKey={params.hasKey ?? false}
      composerEstimateUsd={params.composerEstimateUsd ?? 0}
      estimateFailure={params.estimateFailure ?? null}
      isAuthenticated={params.isAuthenticated ?? false}
    />,
  );
}

/** The banner's message element, matched by exact (normalized) text. */
function expectBannerText(expected: string) {
  const matches = screen.getAllByText((_, el) => {
    if (!el || el.children.length > 0) return false;
    return (el.textContent ?? '').replace(/\s+/g, ' ').trim() === expected;
  });
  expect(matches.length).toBeGreaterThan(0);
}

const anonAtCap: Usage = { used_usd: 5, limit_usd: 5, tier: 'anon' };
const accountAtCap: Usage = { used_usd: 5, limit_usd: 5, tier: 'free' };

describe('cap_reached copy', () => {
  it('anon actor: names the anonymous allowance, the pause, and the sign-in-first action', () => {
    renderBanner({ blocker: { type: 'cap_reached' }, usage: anonAtCap, isAuthenticated: false });
    expectBannerText(
      "You've used all of the free anonymous allowance ($5.00), so sending messages is paused. " +
        'Sign in and add your own Anthropic API key to keep going.',
    );
    expect(screen.getByRole('button', { name: /add an anthropic api key/i })).toBeInTheDocument();
    expect(screen.getByText(/donate/i)).toBeInTheDocument();
  });

  it("account actor: names the account's allowance and the add-key action", () => {
    renderBanner({ blocker: { type: 'cap_reached' }, usage: accountAtCap, isAuthenticated: true });
    expectBannerText(
      "You've used all of your account's free allowance ($5.00), so sending messages is paused. " +
        'Add your own Anthropic API key to keep going.',
    );
  });

  it('signed-out browser on an account row (auth-link cookie): account allowance, sign-in-first action', () => {
    // tier='free' with isAuthenticated=false happens via tocb_auth_link
    // (Policy B: the cap survives sign-out). The allowance really is the
    // account's, but adding a key still requires signing in first.
    renderBanner({ blocker: { type: 'cap_reached' }, usage: accountAtCap, isAuthenticated: false });
    expectBannerText(
      "You've used all of your account's free allowance ($5.00), so sending messages is paused. " +
        'Sign in and add your own Anthropic API key to keep going.',
    );
  });

  it('usage fetch failed (null snapshot): no dollar figure, identity from isAuthenticated', () => {
    renderBanner({ blocker: { type: 'cap_reached' }, usage: null, isAuthenticated: false });
    expectBannerText(
      "You've used all of the free anonymous allowance, so sending messages is paused. " +
        'Sign in and add your own Anthropic API key to keep going.',
    );
  });
});

describe('request_cut_off copy', () => {
  it('anon actor', () => {
    renderBanner({
      blocker: { type: 'request_cut_off' },
      usage: anonAtCap,
      isAuthenticated: false,
    });
    expectBannerText(
      'The response was cut short because it used the last of the free anonymous allowance, ' +
        'so sending messages is paused. Sign in and add your own Anthropic API key to keep going.',
    );
  });

  it('account actor', () => {
    renderBanner({
      blocker: { type: 'request_cut_off' },
      usage: accountAtCap,
      isAuthenticated: true,
    });
    expectBannerText(
      "The response was cut short because it used the last of your account's free allowance, " +
        'so sending messages is paused. Add your own Anthropic API key to keep going.',
    );
  });
});

describe('would_exceed_cap copy', () => {
  const nearCap: Usage = { used_usd: 4.74, limit_usd: 5, tier: 'anon' };

  it('anon actor: names the estimate, the remaining allowance, and both recovery paths', () => {
    renderBanner({
      blocker: { type: 'would_exceed_cap' },
      usage: nearCap,
      isAuthenticated: false,
      composerEstimateUsd: 0.4,
    });
    expectBannerText(
      'This message is estimated at $0.40 (chat history and files included), but only $0.26 ' +
        'of the free anonymous allowance is left. Shorten it, or sign in and add your own ' +
        'Anthropic API key to keep going.',
    );
  });

  it('account actor', () => {
    renderBanner({
      blocker: { type: 'would_exceed_cap' },
      usage: { ...nearCap, tier: 'free' },
      isAuthenticated: true,
      composerEstimateUsd: 0.4,
    });
    expectBannerText(
      'This message is estimated at $0.40 (chat history and files included), but only $0.26 ' +
        "of your account's free allowance is left. Shorten it, or add your own Anthropic API " +
        'key to keep going.',
    );
  });
});

describe('last_send_exceeded copy', () => {
  const nearCap: Usage = { used_usd: 4.74, limit_usd: 5, tier: 'anon' };

  it('anon actor: past-tense rejection with the remaining figure', () => {
    renderBanner({
      blocker: { type: 'last_send_exceeded' },
      usage: nearCap,
      isAuthenticated: false,
    });
    expectBannerText(
      'That message would have cost more than the $0.26 left of the free anonymous allowance, ' +
        "so it wasn't sent. Shorten it, or sign in and add your own Anthropic API key to keep going.",
    );
  });

  it('account actor', () => {
    renderBanner({
      blocker: { type: 'last_send_exceeded' },
      usage: { ...nearCap, tier: 'free' },
      isAuthenticated: true,
    });
    expectBannerText(
      "That message would have cost more than the $0.26 left of your account's free allowance, " +
        "so it wasn't sent. Shorten it, or add your own Anthropic API key to keep going.",
    );
  });

  it('usage null: no figure, generic remaining phrase', () => {
    renderBanner({
      blocker: { type: 'last_send_exceeded' },
      usage: null,
      isAuthenticated: false,
    });
    expectBannerText(
      "That message would have cost more than what's left of the free anonymous allowance, " +
        "so it wasn't sent. Shorten it, or sign in and add your own Anthropic API key to keep going.",
    );
  });
});

describe('session_expired_quota (degraded-session deferral)', () => {
  it('explains the temporary anon demotion and routes to re-login, not API keys', async () => {
    const loginWithRedirect = vi.fn();
    renderBanner({
      blocker: { type: 'session_expired_quota' },
      usage: anonAtCap,
      isAuthenticated: true,
      loginWithRedirect,
    });

    expectBannerText(
      "Your session has expired, so sending is paused (you're temporarily on the free " +
        'anonymous allowance). Sign in again to use your account.',
    );

    // The wrong remedies must NOT render: key ops need a live session, and
    // donating doesn't fix a dead refresh-token grant.
    expect(
      screen.queryByRole('button', { name: /add an anthropic api key/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/donate/i)).not.toBeInTheDocument();

    // Same returnTo contract as SessionExpiredBanner / ByokPanel sign-in.
    await userEvent.click(screen.getByRole('button', { name: /sign in again/i }));
    expect(loginWithRedirect).toHaveBeenCalledTimes(1);
    expect(loginWithRedirect).toHaveBeenCalledWith({
      appState: { returnTo: window.location.pathname + window.location.search },
    });
    expect(localStorage.getItem('auth0_returnTo')).toBe(
      window.location.pathname + window.location.search,
    );
  });
});

// ---------------------------------------------------------------------------
// In-banner estimate status (fb6 issue 74)
// ---------------------------------------------------------------------------
//
// Field incident (second occurrence): a quota-exhausted reviewer with a
// failing estimate endpoint saw NO estimate-related message — the
// under-textarea estimate cluster clips below the fold once the blocker
// stack is up (reproduced at 1366x662). Quota variants therefore carry the
// estimate status INSIDE the banner:
//   - estimate failed → one quiet line with the upstream reason in human
//     form (status→copy map in estimateUnavailableNote);
//   - estimate healthy and > $0 → one quiet line acknowledging estimates
//     still work plus the current draft figure (capped users should still
//     see what a message WOULD cost — estimates are free upstream);
//   - would_exceed_cap skips the ok-line (its main copy already contains
//     the figure) but still surfaces a failure;
//   - non-quota variants (advisory, global_budget) carry nothing — the
//     under-textarea cluster still owns the display there.

const FIELD_403: EstimateFailure = { upstreamStatus: 403, upstreamMessage: 'Request not allowed' };
const REGION_NOTE =
  'Cost estimates are unavailable: the AI service refused the request from this region. ' +
  'Chat and generation are affected too.';
const STILL_WORK = (figure: string) =>
  `Estimates still work: your current draft is about ${figure} of input cost.`;

describe('in-banner estimate status', () => {
  it('cap_reached + failed estimate: quiet line with the mapped upstream reason', () => {
    renderBanner({
      blocker: { type: 'cap_reached' },
      usage: anonAtCap,
      estimateFailure: FIELD_403,
    });
    expectBannerText(REGION_NOTE);
  });

  it('cap_reached + healthy estimate: acknowledges estimates still work, shows the figure', () => {
    renderBanner({
      blocker: { type: 'cap_reached' },
      usage: anonAtCap,
      composerEstimateUsd: 0.07,
    });
    expectBannerText(STILL_WORK('$0.07'));
  });

  it('cap_reached + healthy estimate at $0 (empty draft): no estimate line at all', () => {
    renderBanner({ blocker: { type: 'cap_reached' }, usage: anonAtCap, composerEstimateUsd: 0 });
    expect(screen.queryByText(/Estimates still work/)).toBeNull();
    expect(screen.queryByText(/Cost estimates are/)).toBeNull();
  });

  it('failure wins over the ok-line when both could apply (figure is a rough fallback)', () => {
    renderBanner({
      blocker: { type: 'cap_reached' },
      usage: anonAtCap,
      composerEstimateUsd: 0.07,
      estimateFailure: FIELD_403,
    });
    expectBannerText(REGION_NOTE);
    expect(screen.queryByText(/Estimates still work/)).toBeNull();
  });

  it('request_cut_off carries both forms', () => {
    renderBanner({
      blocker: { type: 'request_cut_off' },
      usage: anonAtCap,
      composerEstimateUsd: 0.12,
    });
    expectBannerText(STILL_WORK('$0.12'));
    cleanup();
    renderBanner({
      blocker: { type: 'request_cut_off' },
      usage: anonAtCap,
      estimateFailure: { upstreamStatus: 429 },
    });
    expectBannerText(
      'Cost estimates are briefly unavailable: the AI service is rate-limiting. ' +
        'It retries automatically.',
    );
  });

  it('last_send_exceeded carries the ok-line (current-draft figure helps trimming)', () => {
    renderBanner({
      blocker: { type: 'last_send_exceeded' },
      usage: { used_usd: 4.74, limit_usd: 5, tier: 'anon' },
      composerEstimateUsd: 0.4,
    });
    expectBannerText(STILL_WORK('$0.40'));
  });

  it('would_exceed_cap: NO ok-line (main copy already shows the figure), but failures surface', () => {
    renderBanner({
      blocker: { type: 'would_exceed_cap' },
      usage: { used_usd: 4.74, limit_usd: 5, tier: 'anon' },
      composerEstimateUsd: 0.4,
    });
    expect(screen.queryByText(/Estimates still work/)).toBeNull();
    cleanup();
    renderBanner({
      blocker: { type: 'would_exceed_cap' },
      usage: { used_usd: 4.74, limit_usd: 5, tier: 'anon' },
      composerEstimateUsd: 0.4,
      estimateFailure: FIELD_403,
    });
    expectBannerText(REGION_NOTE);
  });

  it('session_expired_quota: estimate status rides INSIDE the single banner (no pileup), deferral copy and sole CTA unchanged', () => {
    renderBanner({
      blocker: { type: 'session_expired_quota' },
      usage: anonAtCap,
      isAuthenticated: true,
      estimateFailure: FIELD_403,
    });
    expectBannerText(
      "Your session has expired, so sending is paused (you're temporarily on the free " +
        'anonymous allowance). Sign in again to use your account.',
    );
    expectBannerText(REGION_NOTE);
    expect(screen.getByRole('button', { name: /sign in again/i })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /add an anthropic api key/i }),
    ).not.toBeInTheDocument();
  });

  it('advisory carries nothing even when a failure is active', () => {
    renderBanner({
      blocker: { type: 'advisory', cost_error_type: 'chart_deleted', detail: 'Chart gone.' },
      usage: anonAtCap,
      composerEstimateUsd: 0.07,
      estimateFailure: FIELD_403,
    });
    expect(screen.queryByText(/Cost estimates are/)).toBeNull();
    expect(screen.queryByText(/Estimates still work/)).toBeNull();
  });

  it('global_budget carries nothing (keeps its own upstream line)', () => {
    renderBanner({
      blocker: { type: 'global_budget' },
      usage: anonAtCap,
      composerEstimateUsd: 0.07,
      estimateFailure: FIELD_403,
    });
    expect(screen.queryByText(/Cost estimates are/)).toBeNull();
    expect(screen.queryByText(/Estimates still work/)).toBeNull();
  });
});

describe('non-quota variants are untouched', () => {
  it('advisory renders its detail text as before', () => {
    renderBanner({
      blocker: { type: 'advisory', cost_error_type: 'chart_deleted', detail: 'Chart gone.' },
      usage: anonAtCap,
    });
    expect(screen.getByText('Chart gone.')).toBeInTheDocument();
  });

  it('global_budget keeps the shared-cap copy (identity-independent)', () => {
    renderBanner({
      blocker: { type: 'global_budget' },
      usage: anonAtCap,
      hasKey: false,
    });
    expect(screen.getByText(/shared monthly spend cap/i)).toBeInTheDocument();
  });

  it('null blocker renders nothing', () => {
    const { container } = renderBanner({ blocker: null, usage: anonAtCap });
    expect(container).toBeEmptyDOMElement();
  });
});
