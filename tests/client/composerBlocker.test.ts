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
} from '../../src/components/chat/composerBlocker';

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
    // Fixture chosen to trigger derived would_exceed_cap (4.99 + 0.27 =
    // 5.26 > effective cap 5.25); event still wins over derived.
    const result = selectBlocker({
      eventBlocker: { type: 'cap_reached' },
      usage: { used_usd: 4.99, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0.27,
    });
    expect(result).toEqual({ type: 'cap_reached' });
  });

  it('no event, capped, estimate over effective cap → would_exceed_cap', () => {
    // Effective cap = limit * 1.05 = 5.25. Estimate pushes total to 5.26.
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4.99, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0.27,
    });
    expect(result).toEqual({ type: 'would_exceed_cap' });
  });

  it('no event, capped, estimate over strict cap but within buffer → null', () => {
    // 4.99 + 0.10 = 5.09. Strict cap = 5.00 (over). Effective cap = 5.25
    // (under). Buffer lets this send through. Documents the buffer is
    // active in the derivation.
    const result = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4.99, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0.1,
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
    // Initial: under cap, draft would exceed effective cap (5.25); user
    // sees would_exceed_cap. 4.99 + 0.27 = 5.26 > 5.25.
    const initial = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4.99, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0.27,
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
    // Initial: under cap, draft would exceed effective cap (5.25). 4.5 +
    // 0.76 = 5.26 > 5.25.
    const initial = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 4.5, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0.76,
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
  it('no event + tier byok→free + capped → re-derive would_exceed_cap or null', () => {
    // BYOK active, no draft, no event
    const before = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 100, limit_usd: 5, tier: 'byok' },
      composerEstimateUsd: 0,
    });
    expect(before).toBeNull();

    // BYOK removed: tier flips back to free, used >= limit
    const after = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 5, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0,
    });
    // No draft, so no would_exceed_cap; capAlreadyReached is now a separate
    // concern handled by the banner copy reading from usage directly. The
    // selector returns null when there's no event AND no draft estimate to
    // derive from.
    expect(after).toBeNull();

    // With a draft over the buffer threshold (5 + 0.26 = 5.26 > 5.25
    // effective cap), would_exceed_cap should fire.
    const withDraft = selectBlocker({
      eventBlocker: null,
      usage: { used_usd: 5, limit_usd: 5, tier: 'free' },
      composerEstimateUsd: 0.26,
    });
    expect(withDraft).toEqual({ type: 'would_exceed_cap' });
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
