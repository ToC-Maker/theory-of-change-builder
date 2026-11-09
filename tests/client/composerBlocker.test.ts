// Pure-function tests for the composer-blocker state machine.
//
// Covers:
//   - costErrorToBlocker: 13 CostErrorType variants × 4 prior states + specials
//   - selectBlocker: derived would_exceed_cap precedence, tier-flip filter
//   - shouldBlockSend: send-gate semantics including unknown-sentinel over-block
//   - isCapClassBlocker: cap-class predicate
//   - preserveCapClassOnly: send-start stickiness rule
//   - Transition sequences covering Mode A regression and BYOK tier flip
//
// Pattern: matches tests/client/chatService-reconcile-cadence.test.ts
// (workerd-compatible, no jsdom, no React).
import { describe, expect, it, vi } from 'vitest';
import type { CostError, CostErrorType } from '../../src/services/chatService';
import {
  type ComposerBlocker,
  type RenderedBlocker,
  costErrorToBlocker,
  selectBlocker,
  shouldBlockSend,
  isCapClassBlocker,
  preserveCapClassOnly,
  SERVICE_ERROR_TYPES,
  estimateUnavailableNote,
  bannerCarriesEstimateStatus,
} from '../../src/components/chat/composerBlocker';
import { LIFETIME_CAP_USD, EFFECTIVE_LIFETIME_CAP_USD } from '../../worker/_shared/tiers';

// Boundary helpers — derived so a tolerance change updates tests automatically.
// Tests want fixtures that sit a hair above the effective cap (would_exceed_cap
// should fire) or a hair below (would NOT fire). 0.01 USD is the minimum
// distinguishable gap at our formatCostUsd grain.
const JUST_OVER_EFFECTIVE = (used: number) => EFFECTIVE_LIFETIME_CAP_USD - used + 0.01;
const JUST_UNDER_EFFECTIVE = (used: number) => EFFECTIVE_LIFETIME_CAP_USD - used - 0.01;

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** All 13 CostErrorType variants we need to handle. */
const ALL_COST_ERROR_TYPES: CostErrorType[] = [
  'lifetime_cap_reached',
  'global_budget_exhausted',
  'turnstile_required',
  'turnstile_failed',
  'invalid_token',
  'idempotent_replay',
  'body_too_large',
  'database_unavailable',
  'estimation_unavailable',
  'authentication_service_unavailable',
  'request_cost_ceiling_exceeded',
  'chart_deleted',
  'file_unavailable',
];

/** Representative prior states for the (event × prior) matrix. */
const PRIOR_STATES: Array<ComposerBlocker | null> = [
  null,
  { type: 'cap_reached' },
  { type: 'advisory', cost_error_type: 'body_too_large', detail: 'old detail' },
  { type: 'request_cut_off' },
];

function makeError(type: CostErrorType, data: unknown = null): CostError {
  return { type, data };
}

// ---------------------------------------------------------------------------
// costErrorToBlocker — full (event × prior-state) matrix
// ---------------------------------------------------------------------------

describe('costErrorToBlocker — full matrix', () => {
  // For each event type, the expected output should be invariant across prior
  // states (the transition function is stateless w.r.t. prior, EXCEPT for the
  // no-op cases turnstile_required/turnstile_failed/idempotent_replay which
  // return undefined to preserve prior).
  const expectedByType: Record<
    CostErrorType,
    (prior: ComposerBlocker | null) => ComposerBlocker | undefined
  > = {
    lifetime_cap_reached: () => ({ type: 'cap_reached' }),
    global_budget_exhausted: () => ({ type: 'global_budget', upstream_message: undefined }),
    turnstile_required: () => undefined,
    turnstile_failed: () => undefined,
    invalid_token: () => ({
      type: 'advisory',
      cost_error_type: 'invalid_token',
      detail: expect.any(String) as unknown as string,
    }),
    idempotent_replay: () => undefined,
    body_too_large: () => ({
      type: 'advisory',
      cost_error_type: 'body_too_large',
      detail: expect.any(String) as unknown as string,
    }),
    database_unavailable: () => ({
      type: 'advisory',
      cost_error_type: 'database_unavailable',
      detail: expect.any(String) as unknown as string,
    }),
    estimation_unavailable: () => ({
      type: 'advisory',
      cost_error_type: 'estimation_unavailable',
      detail: expect.any(String) as unknown as string,
    }),
    authentication_service_unavailable: () => ({
      type: 'advisory',
      cost_error_type: 'authentication_service_unavailable',
      detail: expect.any(String) as unknown as string,
    }),
    request_cost_ceiling_exceeded: () => ({ type: 'request_cut_off' }),
    chart_deleted: () => ({
      type: 'advisory',
      cost_error_type: 'chart_deleted',
      detail: expect.any(String) as unknown as string,
    }),
    file_unavailable: () => ({
      type: 'advisory',
      cost_error_type: 'file_unavailable',
      detail: expect.any(String) as unknown as string,
    }),
  };

  // Special-case lifetime_cap_reached with populated data so it returns
  // cap_reached (case a, used >= limit). Case-b (used < limit, returns
  // last_send_exceeded) is covered separately by the "lifetime_cap_reached
  // under cap → last_send_exceeded" spec below.
  const dataByType: Partial<Record<CostErrorType, unknown>> = {
    lifetime_cap_reached: { used_usd: 5.0, limit_usd: 5.0 },
  };

  for (const type of ALL_COST_ERROR_TYPES) {
    for (const prior of PRIOR_STATES) {
      const priorLabel = prior === null ? 'null' : prior.type;
      it(`${type} × prior=${priorLabel} → expected variant`, () => {
        // The transition is stateless w.r.t. prior — same input always
        // yields same output. Looping over prior states documents that
        // invariant explicitly (and would catch a regression if someone
        // added prior-dependent behavior). Prior is referenced just for
        // the `expectedByType` callback signature; not passed to the
        // function under test.
        const expected = expectedByType[type](prior);
        const data = dataByType[type] ?? null;
        const result = costErrorToBlocker(makeError(type, data));
        if (expected === undefined) {
          expect(result).toBeUndefined();
        } else {
          expect(result).toEqual(expected);
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// costErrorToBlocker — specials
// ---------------------------------------------------------------------------

describe('costErrorToBlocker — specials', () => {
  it('lifetime_cap_reached with $0/$0 falls through to advisory (I9)', () => {
    const result = costErrorToBlocker(
      makeError('lifetime_cap_reached', { used_usd: 0, limit_usd: 0 }),
    );
    expect(result).toEqual({
      type: 'advisory',
      cost_error_type: 'lifetime_cap_reached',
      detail: expect.any(String),
    });
  });

  it('lifetime_cap_reached with missing fields falls through to advisory', () => {
    const result = costErrorToBlocker(makeError('lifetime_cap_reached', null));
    // missing fields → used=0, limit=0 → advisory fallback
    expect(result).toEqual({
      type: 'advisory',
      cost_error_type: 'lifetime_cap_reached',
      detail: expect.any(String),
    });
  });

  it('lifetime_cap_reached with non-zero limit only (used 0 < limit) → last_send_exceeded', () => {
    // used (0) < limit (5) → case (b) → last_send_exceeded. Case (a)
    // (truly at cap) requires used >= limit; covered by the matrix above
    // which uses used=limit=5.0.
    const result = costErrorToBlocker(
      makeError('lifetime_cap_reached', { used_usd: 0, limit_usd: 5 }),
    );
    expect(result).toEqual({ type: 'last_send_exceeded' });
  });

  it('lifetime_cap_reached with used < limit → last_send_exceeded (case b)', () => {
    // The "this specific send was too big, but user is under cap" case.
    // Editing down may let a smaller send through.
    const result = costErrorToBlocker(
      makeError('lifetime_cap_reached', { used_usd: 4.5, limit_usd: 5 }),
    );
    expect(result).toEqual({ type: 'last_send_exceeded' });
  });

  it('lifetime_cap_reached with used == limit → cap_reached (case a, boundary)', () => {
    const result = costErrorToBlocker(
      makeError('lifetime_cap_reached', { used_usd: 5, limit_usd: 5 }),
    );
    expect(result).toEqual({ type: 'cap_reached' });
  });

  it('lifetime_cap_reached with used > limit → cap_reached (case a, over)', () => {
    // Shouldn't normally happen (reservation can't push over) but defensive.
    const result = costErrorToBlocker(
      makeError('lifetime_cap_reached', { used_usd: 5.5, limit_usd: 5 }),
    );
    expect(result).toEqual({ type: 'cap_reached' });
  });

  it('idempotent_replay → undefined (C1 regression: caller preserves blocker)', () => {
    // The function is stateless w.r.t. prior. The full (event × prior)
    // matrix above already runs idempotent_replay against every prior
    // state; this is the regression marker for C1 specifically.
    expect(costErrorToBlocker(makeError('idempotent_replay'))).toBeUndefined();
  });

  it('turnstile_required → undefined (no-op preserves blocker)', () => {
    const result = costErrorToBlocker(makeError('turnstile_required'));
    expect(result).toBeUndefined();
  });

  it('turnstile_failed → undefined (no-op preserves blocker)', () => {
    const result = costErrorToBlocker(makeError('turnstile_failed'));
    expect(result).toBeUndefined();
  });

  it('invalid_token → advisory (FM-Crit-2 regression: no hard block)', () => {
    const result = costErrorToBlocker(makeError('invalid_token'));
    expect(result).toMatchObject({
      type: 'advisory',
      cost_error_type: 'invalid_token',
    });
    expect((result as { detail: string }).detail).toMatch(/session|expired|sign/i);
  });

  it('global_budget_exhausted preserves upstream_message when string', () => {
    const result = costErrorToBlocker(
      makeError('global_budget_exhausted', { upstream_message: 'credit_balance_too_low' }),
    );
    expect(result).toEqual({
      type: 'global_budget',
      upstream_message: 'credit_balance_too_low',
    });
  });

  it('global_budget_exhausted with non-string upstream_message → undefined field', () => {
    const result = costErrorToBlocker(
      makeError('global_budget_exhausted', { upstream_message: 42 }),
    );
    expect(result).toEqual({
      type: 'global_budget',
      upstream_message: undefined,
    });
  });

  it('unknown error type → advisory with cost_error_type=unknown + console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = costErrorToBlocker(
        // Force unknown via cast — simulates server adding a new variant
        // the client doesn't know about yet.
        { type: 'made_up_variant' as CostErrorType, data: null },
      );
      expect(result).toEqual({
        type: 'advisory',
        cost_error_type: 'unknown',
        detail: expect.stringContaining('made_up_variant'),
      });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining('[ComposerBlocker]'),
        'made_up_variant',
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// selectBlocker
// ---------------------------------------------------------------------------

describe('selectBlocker', () => {
  it('event blocker wins over derived would_exceed_cap', () => {
    // Fixture pushes total just over the effective cap so the derived
    // would_exceed_cap WOULD fire; the test confirms event wins anyway.
    const result = selectBlocker({
      eventBlocker: { type: 'cap_reached' },
      usage: { used_usd: 4.99, limit_usd: LIFETIME_CAP_USD, tier: 'free' },
      composerEstimateUsd: JUST_OVER_EFFECTIVE(4.99),
    });
    expect(result).toEqual({ type: 'cap_reached' });
  });

  it('no event, capped, estimate over effective cap → would_exceed_cap', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4.99, limit_usd: LIFETIME_CAP_USD, tier: 'free' },
      composerEstimateUsd: JUST_OVER_EFFECTIVE(4.99),
    });
    expect(result).toEqual({ type: 'would_exceed_cap' });
  });

  it('no event, capped, estimate over strict cap but within buffer → null', () => {
    // Documents the buffer: total goes over strict (5.00) but stays under
    // effective (5.25), so the send is allowed and no derived banner fires.
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4.99, limit_usd: LIFETIME_CAP_USD, tier: 'free' },
      composerEstimateUsd: JUST_UNDER_EFFECTIVE(4.99),
    });
    expect(result).toBeNull();
  });

  it('no event, capped, estimate under remaining → null', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 1, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0.5,
    });
    expect(result).toBeNull();
  });

  it('no event, BYOK tier → null (no derived)', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 100, limit_usd: 5, tier: 'byok' },
      composerEstimateUsd: 1,
    });
    expect(result).toBeNull();
  });

  it('cap_reached + tier flips to byok → null (C11 regression)', () => {
    const result = selectBlocker({
      eventBlocker: { type: 'cap_reached' },
      usage: { used_usd: 5, limit_usd: 5, tier: 'byok' },
      composerEstimateUsd: 0,
    });
    expect(result).toBeNull();
  });

  it('request_cut_off + tier flips to byok → null', () => {
    const result = selectBlocker({
      eventBlocker: { type: 'request_cut_off' },
      usage: { used_usd: 5, limit_usd: 5, tier: 'byok' },
      composerEstimateUsd: 0,
    });
    expect(result).toBeNull();
  });

  it('last_send_exceeded + tier flips to byok → null (BYOK-clear predicate includes this)', () => {
    // selectBlocker INLINES a wider BYOK-clear predicate than
    // isCapClassBlocker — the inlined version includes last_send_exceeded
    // (past free-tier rejection becomes irrelevant once BYOK active).
    // This test pins the divergence so a future refactor that re-uses
    // isCapClassBlocker for the selectBlocker filter doesn't silently
    // break the clear.
    const result = selectBlocker({
      eventBlocker: { type: 'last_send_exceeded' },
      usage: { used_usd: 4.5, limit_usd: 5, tier: 'byok' },
      composerEstimateUsd: 0,
    });
    expect(result).toBeNull();
  });

  it('global_budget + tier flips to byok → preserved (N1 regression — not cap-class)', () => {
    const result = selectBlocker({
      eventBlocker: { type: 'global_budget', upstream_message: 'billing error' },
      usage: { used_usd: 0, limit_usd: 5, tier: 'byok' },
      composerEstimateUsd: 0,
    });
    expect(result).toEqual({ type: 'global_budget', upstream_message: 'billing error' });
  });

  it('advisory + tier flips to byok → preserved (non-cap-class)', () => {
    const adv: ComposerBlocker = {
      type: 'advisory',
      cost_error_type: 'chart_deleted',
      detail: 'some detail',
    };
    const result = selectBlocker({
      eventBlocker: adv,
      usage: { used_usd: 0, limit_usd: 5, tier: 'byok' },
      composerEstimateUsd: 0,
    });
    expect(result).toEqual(adv);
  });

  it('usage === null → returns event blocker (no derived possible)', () => {
    const result = selectBlocker({
      eventBlocker: { type: 'cap_reached' },
      usage: null,
      composerEstimateUsd: 0,
    });
    expect(result).toEqual({ type: 'cap_reached' });
  });

  it('usage === null + no event → null', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: null,
      composerEstimateUsd: 5,
    });
    expect(result).toBeNull();
  });

  it('composerEstimateUsd === 0 → no derived would_exceed_cap', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4.99, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0,
    });
    expect(result).toBeNull();
  });

  it('composerEstimateUsd > 0 but used+estimate <= effective cap → null', () => {
    // 4 + 1 = 5 (at strict limit, well under effective cap of 5.25).
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 1,
    });
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// selectBlocker — session-expired precedence (fb5 issue 73)
// ---------------------------------------------------------------------------
//
// When the signed-in session can no longer mint tokens (SessionExpiredBanner
// active: isAuthenticated && degraded), /api/usage and sends silently answer
// for the ANON actor. Any quota-class blocker computed in that state is a
// downstream symptom of the dead session, and its "add an API key" remedy is
// wrong (key ops need a live session; the real fix is re-login). The selector
// therefore replaces quota-class results with `session_expired_quota`, whose
// copy defers to the session banner's "sign in again" action. Non-quota
// blockers (global_budget, advisory) are identity-independent and pass
// through unchanged.

describe('selectBlocker — authSessionDegraded precedence', () => {
  const atCapAnon = { used_usd: 5, limit_usd: 5, tier: 'anon' };

  it('event cap_reached + degraded → session_expired_quota', () => {
    const result = selectBlocker({
      eventBlocker: { type: 'cap_reached' },
      usage: atCapAnon,
      composerEstimateUsd: 0,
      authSessionDegraded: true,
    });
    expect(result).toEqual({ type: 'session_expired_quota' });
  });

  it('event request_cut_off + degraded → session_expired_quota', () => {
    const result = selectBlocker({
      eventBlocker: { type: 'request_cut_off' },
      usage: atCapAnon,
      composerEstimateUsd: 0,
      authSessionDegraded: true,
    });
    expect(result).toEqual({ type: 'session_expired_quota' });
  });

  it('event last_send_exceeded + degraded → session_expired_quota', () => {
    const result = selectBlocker({
      eventBlocker: { type: 'last_send_exceeded' },
      usage: { used_usd: 4.5, limit_usd: 5, tier: 'anon' },
      composerEstimateUsd: 0,
      authSessionDegraded: true,
    });
    expect(result).toEqual({ type: 'session_expired_quota' });
  });

  it('derived cap_reached (usage at cap, no event) + degraded → session_expired_quota', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: atCapAnon,
      composerEstimateUsd: 0,
      authSessionDegraded: true,
    });
    expect(result).toEqual({ type: 'session_expired_quota' });
  });

  it('derived would_exceed_cap + degraded → session_expired_quota', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4.99, limit_usd: LIFETIME_CAP_USD, tier: 'anon' },
      composerEstimateUsd: JUST_OVER_EFFECTIVE(4.99),
      authSessionDegraded: true,
    });
    expect(result).toEqual({ type: 'session_expired_quota' });
  });

  it('global_budget + degraded → passes through unchanged (not quota-class)', () => {
    const result = selectBlocker({
      eventBlocker: { type: 'global_budget', upstream_message: 'billing error' },
      usage: atCapAnon,
      composerEstimateUsd: 0,
      authSessionDegraded: true,
    });
    expect(result).toEqual({ type: 'global_budget', upstream_message: 'billing error' });
  });

  it('advisory + degraded → passes through unchanged', () => {
    const adv: ComposerBlocker = {
      type: 'advisory',
      cost_error_type: 'chart_deleted',
      detail: 'some detail',
    };
    const result = selectBlocker({
      eventBlocker: adv,
      usage: atCapAnon,
      composerEstimateUsd: 0,
      authSessionDegraded: true,
    });
    expect(result).toEqual(adv);
  });

  it('degraded with no quota condition → null (nothing to defer)', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 1, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0.1,
      authSessionDegraded: true,
    });
    expect(result).toBeNull();
  });

  it('degraded + stale byok snapshot → null (BYOK filter wins; nothing to defer)', () => {
    // A byok-tier snapshot can only be pre-degradation (tier=byok requires a
    // verified JWT, which a degraded session cannot produce). The BYOK
    // tier-flip filter clears cap-class events first, leaving nothing for
    // the degraded rule to replace.
    const result = selectBlocker({
      eventBlocker: { type: 'cap_reached' },
      usage: { used_usd: 5, limit_usd: 5, tier: 'byok' },
      composerEstimateUsd: 0,
      authSessionDegraded: true,
    });
    expect(result).toBeNull();
  });

  it('authSessionDegraded omitted → existing behavior (defaults false)', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: atCapAnon,
      composerEstimateUsd: 0,
    });
    expect(result).toEqual({ type: 'cap_reached' });
  });
});

// ---------------------------------------------------------------------------
// shouldBlockSend
// ---------------------------------------------------------------------------

describe('shouldBlockSend', () => {
  it('cap_reached → true', () => {
    expect(shouldBlockSend({ type: 'cap_reached' })).toBe(true);
  });

  it('request_cut_off → true', () => {
    expect(shouldBlockSend({ type: 'request_cut_off' })).toBe(true);
  });

  it('global_budget → true', () => {
    expect(shouldBlockSend({ type: 'global_budget' })).toBe(true);
  });

  it('would_exceed_cap → true', () => {
    expect(shouldBlockSend({ type: 'would_exceed_cap' })).toBe(true);
  });

  it('advisory with non-unknown cost_error_type → false', () => {
    expect(
      shouldBlockSend({
        type: 'advisory',
        cost_error_type: 'body_too_large',
        detail: 'x',
      }),
    ).toBe(false);
  });

  it('advisory with cost_error_type=unknown → true (FM-Q4 defensive over-block)', () => {
    expect(
      shouldBlockSend({
        type: 'advisory',
        cost_error_type: 'unknown',
        detail: 'x',
      }),
    ).toBe(true);
  });

  it('null → false', () => {
    expect(shouldBlockSend(null)).toBe(false);
  });

  it('advisory invalid_token → false (preserves non-blocking transient recovery)', () => {
    expect(
      shouldBlockSend({
        type: 'advisory',
        cost_error_type: 'invalid_token',
        detail: 'x',
      }),
    ).toBe(false);
  });

  it('last_send_exceeded → false (non-blocking, user can edit and retry)', () => {
    // The variant is past-tense ("your last send would have exceeded").
    // User is under cap; editing down may let a smaller send through.
    // would_exceed_cap derived state gates if their CURRENT draft is
    // still too big — this variant alone shouldn't block.
    expect(shouldBlockSend({ type: 'last_send_exceeded' })).toBe(false);
  });

  it('session_expired_quota → true (the deferred quota condition would reject the send)', () => {
    // The variant only replaces blockers that themselves block; sending
    // while degraded would also silently burn the anon allowance.
    expect(shouldBlockSend({ type: 'session_expired_quota' })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isCapClassBlocker
// ---------------------------------------------------------------------------

describe('isCapClassBlocker', () => {
  it('cap_reached → true', () => {
    expect(isCapClassBlocker({ type: 'cap_reached' })).toBe(true);
  });

  it('request_cut_off → true', () => {
    expect(isCapClassBlocker({ type: 'request_cut_off' })).toBe(true);
  });

  it('global_budget → false (N1 regression — must not include)', () => {
    expect(isCapClassBlocker({ type: 'global_budget' })).toBe(false);
  });

  it('advisory → false', () => {
    expect(
      isCapClassBlocker({
        type: 'advisory',
        cost_error_type: 'body_too_large',
        detail: 'x',
      }),
    ).toBe(false);
  });

  it('null → false', () => {
    expect(isCapClassBlocker(null)).toBe(false);
  });

  it('last_send_exceeded → false (per-attempt, not cap-class for preservation)', () => {
    // isCapClassBlocker means "preserve across context changes (send-start,
    // chart-change, clearChat)" — represents global state that survives UI
    // navigation. last_send_exceeded is about a specific past attempt, so
    // it's per-context and should clear on those signals. (Separately,
    // selectBlocker also clears it on BYOK tier-flip — that's a different
    // predicate, inlined in selectBlocker.)
    expect(isCapClassBlocker({ type: 'last_send_exceeded' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// preserveCapClassOnly
// ---------------------------------------------------------------------------

describe('preserveCapClassOnly', () => {
  it('null prior → null', () => {
    expect(preserveCapClassOnly(null)).toBeNull();
  });

  it('cap_reached prior → preserved (sticky)', () => {
    const prev: ComposerBlocker = { type: 'cap_reached' };
    expect(preserveCapClassOnly(prev)).toBe(prev);
  });

  it('request_cut_off prior → preserved (sticky)', () => {
    const prev: ComposerBlocker = { type: 'request_cut_off' };
    expect(preserveCapClassOnly(prev)).toBe(prev);
  });

  it('global_budget prior → cleared (not cap-class)', () => {
    expect(preserveCapClassOnly({ type: 'global_budget' })).toBeNull();
  });

  it('advisory prior → cleared', () => {
    expect(
      preserveCapClassOnly({
        type: 'advisory',
        cost_error_type: 'body_too_large',
        detail: 'x',
      }),
    ).toBeNull();
  });

  it('last_send_exceeded prior → cleared (per-attempt, not preserved on send-start)', () => {
    expect(preserveCapClassOnly({ type: 'last_send_exceeded' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Transition sequences (bug-class the refactor addresses)
// ---------------------------------------------------------------------------

describe('Mode A regression: silent post-send on cap rejection', () => {
  it('case (a): would_exceed_cap → cap_reached event → cap_reached wins', () => {
    // Initial: under cap, draft would exceed effective cap; user sees
    // would_exceed_cap.
    const initial = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4.99, limit_usd: LIFETIME_CAP_USD, tier: 'free' },
      composerEstimateUsd: JUST_OVER_EFFECTIVE(4.99),
    });
    expect(initial).toEqual({ type: 'would_exceed_cap' });

    // User clicks Send; server returns 429 lifetime_cap_reached. Mode A
    // bug: before the fix, costErrorBanner was cleared then
    // capAlreadyReached was trusted to flip via async refreshUsage — but
    // the rejected request didn't bill, so it stayed false, banner
    // vanished. After the fix: costErrorToBlocker returns the
    // appropriate sticky event variant.
    //
    // Case (a): server reports used >= limit at rejection time (e.g.
    // user was at $5.00 already). Routes to cap_reached.
    const newEvent = costErrorToBlocker(
      makeError('lifetime_cap_reached', { used_usd: 5, limit_usd: 5 }),
    );
    expect(newEvent).toEqual({ type: 'cap_reached' });

    const after = selectBlocker({
      eventBlocker: newEvent ?? null,
      usage: { used_usd: 5, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0,
    });
    expect(after).toEqual({ type: 'cap_reached' });
  });

  it('case (b): would_exceed_cap → last_send_exceeded event → event wins, banner shows', () => {
    // Initial: well under cap, draft would exceed effective cap.
    const initial = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4.5, limit_usd: LIFETIME_CAP_USD, tier: 'free' },
      composerEstimateUsd: JUST_OVER_EFFECTIVE(4.5),
    });
    expect(initial).toEqual({ type: 'would_exceed_cap' });

    // User clicks Send; server rejects with 429 lifetime_cap_reached but
    // server reports used (4.5) < limit (5) — this specific send was too
    // big, not user-at-cap. Routes to last_send_exceeded (non-blocking,
    // amber, auto-clears on edit per the ChatInterface useEffect).
    const newEvent = costErrorToBlocker(
      makeError('lifetime_cap_reached', { used_usd: 4.5, limit_usd: 5 }),
    );
    expect(newEvent).toEqual({ type: 'last_send_exceeded' });

    const after = selectBlocker({
      eventBlocker: newEvent ?? null,
      usage: { used_usd: 4.5, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0,
    });
    expect(after).toEqual({ type: 'last_send_exceeded' });
  });
});

describe('Idempotent replay preserves sticky cap_reached', () => {
  it('idempotent_replay returns undefined; caller preserves prior blocker', () => {
    const current: ComposerBlocker = { type: 'cap_reached' };
    const next = costErrorToBlocker(makeError('idempotent_replay'));
    expect(next).toBeUndefined();
    // Caller pattern: if (next !== undefined) setComposerBlocker(next);
    // → preserves current. We assert here via the pattern reproduction:
    const finalBlocker = next === undefined ? current : next;
    expect(finalBlocker).toEqual({ type: 'cap_reached' });
  });
});

describe('BYOK add tier flip', () => {
  it('cap_reached + usage updates tier → byok → selectBlocker returns null', () => {
    // Before BYOK add: capped, banner showing
    const before = selectBlocker({
      eventBlocker: { type: 'cap_reached' },
      usage: { used_usd: 5, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0,
    });
    expect(before).toEqual({ type: 'cap_reached' });

    // After refreshUsage resolves post-BYOK-add: tier flips to byok
    const after = selectBlocker({
      eventBlocker: { type: 'cap_reached' },
      usage: { used_usd: 5, limit_usd: 5, tier: 'byok' },
      composerEstimateUsd: 0,
    });
    expect(after).toBeNull();
  });
});

describe('BYOK removal — tier flips back to free', () => {
  it('no event + tier byok→free + used >= cap → derived cap_reached fires', () => {
    // BYOK active, no draft, no event — even at 100 over cap, BYOK
    // bypasses every derived check.
    const before = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 100, limit_usd: LIFETIME_CAP_USD, tier: 'byok' },
      composerEstimateUsd: 0,
    });
    expect(before).toBeNull();

    // BYOK removed: tier flips back to free, used >= cap. Selector
    // proactively derives cap_reached (no server event needed) — without
    // this the user could land on a fresh chart past the cap and see no
    // blocker until they hit Send.
    const after = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: LIFETIME_CAP_USD, limit_usd: LIFETIME_CAP_USD, tier: 'free' },
      composerEstimateUsd: 0,
    });
    expect(after).toEqual({ type: 'cap_reached' });
  });
});

describe('Derived cap_reached (no event, used >= displayed cap)', () => {
  it('used exactly at limit → cap_reached', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: LIFETIME_CAP_USD, limit_usd: LIFETIME_CAP_USD, tier: 'free' },
      composerEstimateUsd: 0,
    });
    expect(result).toEqual({ type: 'cap_reached' });
  });

  it('used past limit (kill-switch overshoot landed user in buffer zone) → cap_reached', () => {
    // Concrete repro of the case where a prior stream's kill-switch tolerance
    // let it finish at $5.10. Without this derivation, a subsequent small
    // send would slide past the effective-cap gate (5.10 + 0.10 < 5.25),
    // letting the user trickle in extra sends after they've nominally
    // exhausted the cap.
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 5.1, limit_usd: LIFETIME_CAP_USD, tier: 'free' },
      composerEstimateUsd: 0.1,
    });
    expect(result).toEqual({ type: 'cap_reached' });
  });

  it('used past limit on BYOK tier → null (cap does not apply)', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 100, limit_usd: LIFETIME_CAP_USD, tier: 'byok' },
      composerEstimateUsd: 0.1,
    });
    expect(result).toBeNull();
  });

  it('used just under limit + no draft → null (no proactive cap)', () => {
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4.99, limit_usd: LIFETIME_CAP_USD, tier: 'free' },
      composerEstimateUsd: 0,
    });
    expect(result).toBeNull();
  });
});

describe('Two consecutive cap-rejection events', () => {
  it('returns new {type:cap_reached} object (caller relies on React.memo for short-circuit)', () => {
    const a = costErrorToBlocker(makeError('lifetime_cap_reached', { used_usd: 5, limit_usd: 5 }));
    const b = costErrorToBlocker(makeError('lifetime_cap_reached', { used_usd: 5, limit_usd: 5 }));
    expect(a).toEqual({ type: 'cap_reached' });
    expect(b).toEqual({ type: 'cap_reached' });
    // Reference equality NOT preserved — that's React.memo's job to short-
    // circuit via shallow-equal props (banner has no payload to diff).
    expect(b).not.toBe(a);
  });
});

// ---------------------------------------------------------------------------
// SERVICE_ERROR_TYPES — co-located set
// ---------------------------------------------------------------------------

describe('SERVICE_ERROR_TYPES', () => {
  it('contains the three service-class types', () => {
    expect(SERVICE_ERROR_TYPES.has('database_unavailable')).toBe(true);
    expect(SERVICE_ERROR_TYPES.has('estimation_unavailable')).toBe(true);
    expect(SERVICE_ERROR_TYPES.has('authentication_service_unavailable')).toBe(true);
  });

  it('does NOT contain cap/quota types (asymmetric logging discipline)', () => {
    expect(SERVICE_ERROR_TYPES.has('lifetime_cap_reached')).toBe(false);
    expect(SERVICE_ERROR_TYPES.has('global_budget_exhausted')).toBe(false);
    expect(SERVICE_ERROR_TYPES.has('request_cost_ceiling_exceeded')).toBe(false);
    expect(SERVICE_ERROR_TYPES.has('turnstile_required')).toBe(false);
    expect(SERVICE_ERROR_TYPES.has('turnstile_failed')).toBe(false);
    expect(SERVICE_ERROR_TYPES.has('idempotent_replay')).toBe(false);
    expect(SERVICE_ERROR_TYPES.has('invalid_token')).toBe(false);
    expect(SERVICE_ERROR_TYPES.has('body_too_large')).toBe(false);
    expect(SERVICE_ERROR_TYPES.has('chart_deleted')).toBe(false);
    expect(SERVICE_ERROR_TYPES.has('file_unavailable')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// estimateUnavailableNote — upstream status → human copy map (fb6 issue 74)
// ---------------------------------------------------------------------------
//
// Field incident: /api/count-tokens-estimate failed with
// {"error":"estimation_unavailable","upstream_status":403,
//  "upstream_message":"Request not allowed"} and the UI showed nothing.
// The note must translate upstream statuses into doc-grounded explanations
// (Anthropic error types) rather than echoing raw status/message. 403's
// terse "Request not allowed" is empirically a request-origin/region block
// (NOT quota — billing is a separate 402 type), and it gates ALL AI
// endpoints, so the copy must say chat/generation are affected too.

describe('estimateUnavailableNote', () => {
  it('401 → server-credentials copy (authentication_error is OUR key, not the user)', () => {
    expect(estimateUnavailableNote({ upstreamStatus: 401 })).toBe(
      "Cost estimates are unavailable: the server's AI credentials were rejected. " +
        'This is a server problem, not yours.',
    );
  });

  it('402 → server-side billing copy', () => {
    expect(estimateUnavailableNote({ upstreamStatus: 402 })).toBe(
      'Cost estimates are unavailable: the AI service reported a billing problem on our side.',
    );
  });

  it('403 → region-block copy that names the full blast radius (chat + generation)', () => {
    expect(
      estimateUnavailableNote({ upstreamStatus: 403, upstreamMessage: 'Request not allowed' }),
    ).toBe(
      'Cost estimates are unavailable: the AI service refused the request from this region. ' +
        'Chat and generation are affected too.',
    );
  });

  it('429 → rate-limit copy', () => {
    expect(estimateUnavailableNote({ upstreamStatus: 429 })).toBe(
      'Cost estimates are briefly unavailable: the AI service is rate-limiting. ' +
        'It retries automatically.',
    );
  });

  it.each([500, 504, 529])('%i → transient-upstream copy', (status) => {
    expect(estimateUnavailableNote({ upstreamStatus: status })).toBe(
      'Cost estimates are temporarily unavailable upstream. Estimates resume automatically.',
    );
  });

  it('unknown status + message → generic line with the raw reason appended', () => {
    expect(estimateUnavailableNote({ upstreamStatus: 418, upstreamMessage: 'teapot' })).toBe(
      'Cost estimates are unavailable right now (upstream error 418: teapot).',
    );
  });

  it('unknown status without message → generic line with the raw status', () => {
    expect(estimateUnavailableNote({ upstreamStatus: 418 })).toBe(
      'Cost estimates are unavailable right now (upstream error 418).',
    );
  });

  it('message without status → generic line with the message', () => {
    expect(estimateUnavailableNote({ upstreamMessage: 'shape mismatch' })).toBe(
      'Cost estimates are unavailable right now (shape mismatch).',
    );
  });

  it('no upstream detail (network error, local 503) → bare generic line', () => {
    expect(estimateUnavailableNote({})).toBe('Cost estimates are unavailable right now.');
  });
});

// ---------------------------------------------------------------------------
// bannerCarriesEstimateStatus — which rendered variants surface the
// estimate status INSIDE the blocker banner (fb6 issue 74)
// ---------------------------------------------------------------------------
//
// The under-textarea estimate cluster sits at the bottom of the composer
// stack; when a quota blocker is up, that cluster clips below the fold on
// common laptop viewports (reproduced at 1366x662). For quota-class
// variants the banner itself carries the estimate status, and ChatInterface
// suppresses the under-textarea cluster to avoid duplication. This
// predicate is the single source of truth for that variant set.

describe('bannerCarriesEstimateStatus', () => {
  it.each([
    'cap_reached',
    'request_cut_off',
    'last_send_exceeded',
    'would_exceed_cap',
    'session_expired_quota',
  ] as const)('%s carries estimate status', (type) => {
    expect(bannerCarriesEstimateStatus({ type } as RenderedBlocker)).toBe(true);
  });

  it('null carries nothing (no blocker → under-textarea cluster owns the display)', () => {
    expect(bannerCarriesEstimateStatus(null)).toBe(false);
  });

  it('advisory does not carry (service-error copy would double up)', () => {
    expect(
      bannerCarriesEstimateStatus({
        type: 'advisory',
        cost_error_type: 'estimation_unavailable',
        detail: 'Service temporarily unavailable. Please try again shortly.',
      }),
    ).toBe(false);
  });

  it('global_budget does not carry (identity-independent, has its own upstream line)', () => {
    expect(bannerCarriesEstimateStatus({ type: 'global_budget' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type exports — compile-time check via runtime assertion
// ---------------------------------------------------------------------------

describe('exported type narrowing', () => {
  it('RenderedBlocker is ComposerBlocker | {type:would_exceed_cap} | null', () => {
    // Compile-time check that the type union accepts both halves
    const a: RenderedBlocker = null;
    const b: RenderedBlocker = { type: 'cap_reached' };
    const c: RenderedBlocker = { type: 'would_exceed_cap' };
    expect(a).toBeNull();
    expect(b.type).toBe('cap_reached');
    expect(c.type).toBe('would_exceed_cap');
  });
});
