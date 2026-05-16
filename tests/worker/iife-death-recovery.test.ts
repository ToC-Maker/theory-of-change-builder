// Tests for Task 8's post-stream reconcile signed-delta SQL in
// `worker/api/anthropic-stream.ts`.
//
// SCOPE NOTE — read this before adding cases:
//
// The reconcile path is a single CTE that atomically:
//   1. Locks the logging_messages row with `SELECT ... FOR UPDATE` and
//      computes `baseline = max(projected, cost_settled_micro_usd)`.
//   2. Computes `signed_delta = actual - baseline` (SIGNED; refunds when
//      mid-stream over-projection > final actual).
//   3. Updates logging_messages:
//        - cost_micro_usd = GREATEST(prev, actual)  (monotone HWM)
//        - cost_settled_micro_usd = actual          (settles to truth)
//        - reconciled_at = NOW()                    (lock against late retries)
//   4. Updates user_api_usage:
//        - cost_micro_usd = GREATEST(0, prev + signed_delta)
//        - input/output/cache/web_search token counters incremented additively.
//   5. The user_api_usage UPDATE is guarded by `EXISTS(SELECT 1 FROM msg_upd)`,
//      so it skips when reconcile-already-fired (race with concurrent reconcile).
//
// This file is an in-memory simulation, NOT a real Postgres test. It pins:
//   - The CTE algebra: baseline = max(projected, settled); delta SIGNED;
//     reconciled row stamped exactly once.
//   - Refund direction works (signed_delta < 0).
//   - Excess direction works (signed_delta > 0).
//   - Mid-stream-already-committed-actual case → delta = 0, no double-counting.
//   - After reconcile, subsequent `applyDeltaCommit` no-ops via the
//     `WHERE reconciled_at IS NULL` guard (regression protection for late
//     retries from the 7-day client retry queue).
//
// What this file does NOT pin (covered elsewhere):
//   - Real `FOR UPDATE` lock acquisition / blocking semantics.
//   - Single-statement vs multi-statement Neon HTTP behaviour.
//   - The wider IIFE wiring (writeDiagnostic, global_monthly_usage,
//     content_blocks, was_killed) — those have separate diagnostics tests.
//
// Mocking strategy: we model the reconcile SQL inline as the production
// code's CTE algebra against an in-memory row pair. Composing the live
// SQL into the test would require a full Worker harness; instead we mirror
// the CTE step-by-step (same baseline/delta/clamp/guard semantics). When
// the production SQL changes, the test fixture must be updated in lockstep;
// the inline reconcile mirror at the top of the file is the load-bearing
// contract pin.
import { describe, expect, it } from 'vitest';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { applyDeltaCommit } from '../../worker/_shared/cost-commit';

// In-memory row pair (logging_messages + user_api_usage). Matches the
// shape used in delta-commit-concurrency.test.ts so the helper-under-test
// imports here apply unchanged.
type LoggingMessageRow = {
  message_id: string;
  user_id: string;
  cost_micro_usd: bigint;
  cost_settled_micro_usd: bigint;
  reconciled_at: Date | null;
};
type UserApiUsageRow = {
  user_id: string;
  cost_micro_usd: bigint;
  input_tokens: number;
  output_tokens: number;
  cache_create_tokens: number;
  cache_read_tokens: number;
  web_search_uses: number;
};

type ReconcileAccumulator = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_search_requests: number;
};

type Backend = {
  sql: NeonQueryFunction<false, false>;
  state: { message: LoggingMessageRow; user_usage: UserApiUsageRow };
  /**
   * Run the reconcile SQL's effect against the in-memory state. Mirrors
   * the production CTE step-by-step. Returns the row pair after reconcile.
   * The same `state` is shared with subsequent `applyDeltaCommit` calls so
   * we can chain reconcile → late retry and observe the lock.
   */
  reconcile: (input: {
    loggingMessageId: string;
    actorId: string;
    projected: bigint;
    actualMicro: bigint;
    accumulator: ReconcileAccumulator;
  }) => {
    settled: bigint;
    appliedSignedDelta: bigint;
    userCost: bigint;
    reconciledAt: Date | null;
  };
};

function makeBackend(initial: {
  message: LoggingMessageRow;
  user_usage: UserApiUsageRow;
}): Backend {
  const state = {
    message: { ...initial.message },
    user_usage: { ...initial.user_usage },
  };

  // Per-message mutex (same pattern as delta-commit-concurrency.test.ts).
  // Reconcile and applyDeltaCommit can race against each other — the mutex
  // serialises them, mirroring the real CTE's row-level lock.
  const mutexes = new Map<string, Promise<void>>();
  function withRowLock<T>(messageId: string, critical: () => Promise<T>): Promise<T> {
    const prev = mutexes.get(messageId) ?? Promise.resolve();
    const next = prev.then(critical);
    mutexes.set(
      messageId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // SQL stub shared with applyDeltaCommit (matches the CTE in
  // worker/_shared/cost-commit.ts). The reconcile path is run via the
  // `reconcile` helper below — we don't try to dispatch SQL by string
  // matching because the reconcile SQL is more complex than the
  // applyDeltaCommit CTE and pattern matching would obscure intent.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    const messageId = String(values[0]);
    const userId = String(values[1]);
    const projected = BigInt(String(values[2]));
    const newCost = BigInt(String(values[3]));

    return withRowLock(messageId, async () => {
      await Promise.resolve();
      const row = state.message;
      const matches =
        row.message_id === messageId && row.user_id === userId && row.reconciled_at === null;
      if (!matches) {
        return [{ new_settled: null, delta: null, applied: false }];
      }
      const baseline =
        projected > row.cost_settled_micro_usd ? projected : row.cost_settled_micro_usd;
      const computedDelta = newCost > baseline ? newCost - baseline : 0n;
      const newSettled =
        newCost > row.cost_settled_micro_usd ? newCost : row.cost_settled_micro_usd;
      const newCostHwm = newCost > row.cost_micro_usd ? newCost : row.cost_micro_usd;
      state.message = {
        ...row,
        cost_micro_usd: newCostHwm,
        cost_settled_micro_usd: newSettled,
      };
      if (computedDelta > 0n) {
        state.user_usage = {
          ...state.user_usage,
          cost_micro_usd: state.user_usage.cost_micro_usd + computedDelta,
        };
      }
      return [{ new_settled: newSettled, delta: computedDelta, applied: true }];
    });
  };

  function reconcile(input: {
    loggingMessageId: string;
    actorId: string;
    projected: bigint;
    actualMicro: bigint;
    accumulator: ReconcileAccumulator;
  }): {
    settled: bigint;
    appliedSignedDelta: bigint;
    userCost: bigint;
    reconciledAt: Date | null;
  } {
    const { loggingMessageId, actorId, projected, actualMicro, accumulator } = input;
    const row = state.message;
    const matches =
      row.message_id === loggingMessageId && row.user_id === actorId && row.reconciled_at === null;
    if (!matches) {
      // EXISTS(SELECT 1 FROM msg_upd) is false: user_api_usage UPDATE skipped.
      return {
        settled: row.cost_settled_micro_usd,
        appliedSignedDelta: 0n,
        userCost: state.user_usage.cost_micro_usd,
        reconciledAt: row.reconciled_at,
      };
    }
    const baseline =
      projected > row.cost_settled_micro_usd ? projected : row.cost_settled_micro_usd;
    const signedDelta = actualMicro - baseline; // SIGNED
    const newMsgCost = actualMicro > row.cost_micro_usd ? actualMicro : row.cost_micro_usd;
    const newReconciledAt = new Date('2026-05-16T12:00:00Z');
    state.message = {
      ...row,
      cost_micro_usd: newMsgCost,
      cost_settled_micro_usd: actualMicro,
      reconciled_at: newReconciledAt,
    };
    const newUserCost = state.user_usage.cost_micro_usd + signedDelta;
    state.user_usage = {
      ...state.user_usage,
      cost_micro_usd: newUserCost < 0n ? 0n : newUserCost,
      input_tokens: state.user_usage.input_tokens + accumulator.input_tokens,
      output_tokens: state.user_usage.output_tokens + accumulator.output_tokens,
      cache_create_tokens:
        state.user_usage.cache_create_tokens + accumulator.cache_creation_input_tokens,
      cache_read_tokens: state.user_usage.cache_read_tokens + accumulator.cache_read_input_tokens,
      web_search_uses: state.user_usage.web_search_uses + accumulator.web_search_requests,
    };
    return {
      settled: actualMicro,
      appliedSignedDelta: signedDelta,
      userCost: state.user_usage.cost_micro_usd,
      reconciledAt: newReconciledAt,
    };
  }

  return { sql: sql as NeonQueryFunction<false, false>, state, reconcile };
}

const ZERO_ACC: ReconcileAccumulator = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  web_search_requests: 0,
};

describe('reconcile signed-delta SQL — Task 8', () => {
  // -------------------------------------------------------------------------
  // Excess direction A: actual > projected and no mid-stream writer.
  //
  // Reservation flowed through user_api_usage (= projected). cost_settled is
  // still 0 (no per-update writer fired in time). baseline = max(projected, 0)
  // = projected. signed_delta = actual - projected (positive). The user is
  // billed the additional actual - projected.
  // -------------------------------------------------------------------------
  it('excess case (actual > projected, no mid-stream writer): credits user_api_usage by (actual - projected)', () => {
    const { state, reconcile } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 0n,
        cost_settled_micro_usd: 0n,
        reconciled_at: null,
      },
      user_usage: {
        user_id: 'auth0|alice',
        cost_micro_usd: 100_000n, // the reservation already debited
        input_tokens: 0,
        output_tokens: 0,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
        web_search_uses: 0,
      },
    });

    const result = reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|alice',
      projected: 100_000n, // $0.10 reserved
      actualMicro: 300_000n, // $0.30 actual
      accumulator: ZERO_ACC,
    });

    // baseline = max(projected=100k, settled=0) = 100k.
    // signed_delta = 300k - 100k = +200k (positive, excess billing).
    expect(result.appliedSignedDelta).toBe(200_000n);
    // user_api_usage was at 100k (reservation) → +200k → 300k (final actual).
    expect(state.user_usage.cost_micro_usd).toBe(300_000n);
    // logging_messages: settled to actual, cost_micro_usd HWM-clamped.
    expect(state.message.cost_settled_micro_usd).toBe(300_000n);
    expect(state.message.cost_micro_usd).toBe(300_000n);
    expect(state.message.reconciled_at).toEqual(new Date('2026-05-16T12:00:00Z'));
  });

  // -------------------------------------------------------------------------
  // Excess direction B: actual > projected and a mid-stream writer already
  // committed `actual` (or higher) to cost_settled.
  //
  // The mid-stream writer's applyDeltaCommit credited (actual - projected)
  // to user_api_usage. cost_settled is now `actual`. When reconcile fires:
  // baseline = max(projected, actual) = actual; signed_delta = actual - actual
  // = 0. No-op on user_api_usage. Idempotent — reconcile after a complete
  // per-update sequence doesn't double-count.
  // -------------------------------------------------------------------------
  it('mid-stream-already-committed-actual: signed_delta = 0, no double-count on user_api_usage', () => {
    const { state, reconcile } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 300_000n,
        cost_settled_micro_usd: 300_000n, // mid-stream writer already committed
        reconciled_at: null,
      },
      user_usage: {
        user_id: 'auth0|alice',
        cost_micro_usd: 300_000n, // reservation 100k + mid-stream delta 200k
        input_tokens: 0,
        output_tokens: 0,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
        web_search_uses: 0,
      },
    });

    const result = reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|alice',
      projected: 100_000n,
      actualMicro: 300_000n,
      accumulator: ZERO_ACC,
    });

    // baseline = max(projected=100k, settled=300k) = 300k.
    // signed_delta = 300k - 300k = 0.
    expect(result.appliedSignedDelta).toBe(0n);
    // user_api_usage unchanged at 300k — no double-count.
    expect(state.user_usage.cost_micro_usd).toBe(300_000n);
    // logging_messages still settled to actual (idempotent), reconciled_at stamped.
    expect(state.message.cost_settled_micro_usd).toBe(300_000n);
    expect(state.message.reconciled_at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Refund direction: actual < projected and no mid-stream writer credited
  // beyond the reservation.
  //
  // Reservation (projected) sits in user_api_usage. The actual final cost
  // is lower (e.g. user aborted early). cost_settled is 0 (no per-update
  // writer fired, or every writer's newCost ≤ projected so delta was 0).
  // baseline = max(projected, 0) = projected. signed_delta = actual - projected
  // (NEGATIVE). user_api_usage decreases by (projected - actual), refunding
  // the overshoot in the same atomic statement that stamps reconciled_at.
  // -------------------------------------------------------------------------
  it('refund case (actual < projected, no mid-stream writer): debits user_api_usage by (projected - actual)', () => {
    const { state, reconcile } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 0n,
        cost_settled_micro_usd: 0n,
        reconciled_at: null,
      },
      user_usage: {
        user_id: 'auth0|alice',
        cost_micro_usd: 500_000n, // $0.50 reservation
        input_tokens: 0,
        output_tokens: 0,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
        web_search_uses: 0,
      },
    });

    const result = reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|alice',
      projected: 500_000n,
      actualMicro: 120_000n, // $0.12 actual (way under projection)
      accumulator: ZERO_ACC,
    });

    // baseline = max(projected=500k, settled=0) = 500k.
    // signed_delta = 120k - 500k = -380k (negative, refund).
    expect(result.appliedSignedDelta).toBe(-380_000n);
    // user_api_usage was at 500k (reservation) → -380k → 120k (final actual).
    expect(state.user_usage.cost_micro_usd).toBe(120_000n);
    // logging_messages settled to actual (truth), cost_micro_usd HWM-clamped.
    expect(state.message.cost_settled_micro_usd).toBe(120_000n);
    expect(state.message.cost_micro_usd).toBe(120_000n);
    expect(state.message.reconciled_at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Negative-clamp safety: a refund larger than the current user_api_usage
  // balance must not go below zero. GREATEST(0::bigint, ...) clamps the
  // result. Models a bookkeeping race where a concurrent reconcile path
  // (or admin manual adjustment) left user_api_usage lower than the refund
  // value at reconcile time.
  // -------------------------------------------------------------------------
  it('negative-clamp: refund > prior user_api_usage cost is clamped to 0', () => {
    const { state, reconcile } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 0n,
        cost_settled_micro_usd: 0n,
        reconciled_at: null,
      },
      user_usage: {
        user_id: 'auth0|alice',
        cost_micro_usd: 50_000n, // only $0.05 currently in the cap
        input_tokens: 0,
        output_tokens: 0,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
        web_search_uses: 0,
      },
    });

    const result = reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|alice',
      projected: 200_000n,
      actualMicro: 10_000n,
      accumulator: ZERO_ACC,
    });

    // signed_delta = 10k - 200k = -190k. cost_micro_usd would go to
    // 50k - 190k = -140k without the clamp. GREATEST(0, ...) → 0.
    expect(result.appliedSignedDelta).toBe(-190_000n);
    expect(state.user_usage.cost_micro_usd).toBe(0n);
  });

  // -------------------------------------------------------------------------
  // Reconciled_at stamping: the column transitions from NULL to a timestamp
  // exactly once. Sanity test in case the SQL is refactored to use a CASE
  // expression or a partial UPDATE that accidentally drops the stamp.
  // -------------------------------------------------------------------------
  it('reconciled_at: NULL → timestamp after a single reconcile', () => {
    const { state, reconcile } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 0n,
        cost_settled_micro_usd: 0n,
        reconciled_at: null,
      },
      user_usage: {
        user_id: 'auth0|alice',
        cost_micro_usd: 100_000n,
        input_tokens: 0,
        output_tokens: 0,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
        web_search_uses: 0,
      },
    });

    expect(state.message.reconciled_at).toBeNull();
    reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|alice',
      projected: 100_000n,
      actualMicro: 100_000n,
      accumulator: ZERO_ACC,
    });
    expect(state.message.reconciled_at).not.toBeNull();
    expect(state.message.reconciled_at).toBeInstanceOf(Date);
  });

  // -------------------------------------------------------------------------
  // Late-retry lock: after reconcile stamps reconciled_at, subsequent
  // `applyDeltaCommit` calls (e.g. from the 7-day localStorage retry queue,
  // or a delayed worker poll completing post-reconcile) must no-op via the
  // `WHERE reconciled_at IS NULL` guard. The plan calls this the "late
  // retry re-inflation" failure mode (Decision Record C5).
  // -------------------------------------------------------------------------
  it('post-reconcile applyDeltaCommit: returns applied:false, no state mutation', async () => {
    const { sql, state, reconcile } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 0n,
        cost_settled_micro_usd: 0n,
        reconciled_at: null,
      },
      user_usage: {
        user_id: 'auth0|alice',
        cost_micro_usd: 100_000n,
        input_tokens: 0,
        output_tokens: 0,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
        web_search_uses: 0,
      },
    });

    // Run reconcile first.
    reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|alice',
      projected: 100_000n,
      actualMicro: 250_000n,
      accumulator: ZERO_ACC,
    });

    expect(state.message.reconciled_at).not.toBeNull();
    const userCostAfterReconcile = state.user_usage.cost_micro_usd; // 250k
    const settledAfterReconcile = state.message.cost_settled_micro_usd; // 250k

    // Late retry from localStorage queue arrives — much larger value.
    const lateRetry = await applyDeltaCommit(
      sql,
      'msg_x',
      'auth0|alice',
      100_000n,
      9_000_000n, // $9 — would massively inflate if the lock didn't fire
    );

    expect(lateRetry.applied).toBe(false);
    expect(lateRetry.delta).toBe(0n);
    expect(lateRetry.new_settled).toBe(0n);
    // No state mutation.
    expect(state.user_usage.cost_micro_usd).toBe(userCostAfterReconcile);
    expect(state.message.cost_settled_micro_usd).toBe(settledAfterReconcile);
  });

  // -------------------------------------------------------------------------
  // IIFE death recovery: per the plan's Decision Record C5 narrative — the
  // reconcile IIFE was killed by Cloudflare's time budget AFTER per-update
  // writes captured cost_settled = $0.30 but BEFORE the reconcile signed-
  // delta SQL ran. cost_settled = $0.30, reconciled_at = NULL. A late client
  // retry POSTing $0.30 must succeed (no `reconciled_at` lock yet) but be a
  // no-op (GREATEST short-circuit). Once a subsequent reconcile completes,
  // reconciled_at is stamped and further retries no-op.
  // -------------------------------------------------------------------------
  it('IIFE-death-recovery: late client retry pre-reconcile is a GREATEST no-op; post-reconcile retries are locked', async () => {
    const { sql, state, reconcile } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 300_000n, // mid-stream writer landed
        cost_settled_micro_usd: 300_000n,
        reconciled_at: null, // IIFE died before stamping
      },
      user_usage: {
        user_id: 'auth0|alice',
        cost_micro_usd: 300_000n,
        input_tokens: 0,
        output_tokens: 0,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
        web_search_uses: 0,
      },
    });

    // Late client retry from localStorage queue: posts the running_cost
    // it observed (= the same $0.30 the mid-stream writer already settled).
    const lateRetryPreReconcile = await applyDeltaCommit(
      sql,
      'msg_x',
      'auth0|alice',
      100_000n,
      300_000n,
    );
    // applied:true (the row is unlocked) but the delta is 0 (newCost ==
    // settled, baseline = max(100k, 300k) = 300k, delta = 0).
    expect(lateRetryPreReconcile.applied).toBe(true);
    expect(lateRetryPreReconcile.delta).toBe(0n);
    // No state change — GREATEST clamps everything.
    expect(state.user_usage.cost_micro_usd).toBe(300_000n);
    expect(state.message.cost_settled_micro_usd).toBe(300_000n);

    // Now reconcile completes. baseline = max(100k, 300k) = 300k;
    // signed_delta = 300k - 300k = 0; reconciled_at stamped.
    const result = reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|alice',
      projected: 100_000n,
      actualMicro: 300_000n,
      accumulator: ZERO_ACC,
    });
    expect(result.appliedSignedDelta).toBe(0n);
    expect(state.message.reconciled_at).not.toBeNull();

    // Further late retries are now locked out.
    const lateRetryPostReconcile = await applyDeltaCommit(
      sql,
      'msg_x',
      'auth0|alice',
      100_000n,
      9_000_000n,
    );
    expect(lateRetryPostReconcile.applied).toBe(false);
    expect(state.user_usage.cost_micro_usd).toBe(300_000n);
  });

  // -------------------------------------------------------------------------
  // Token-counter accumulation: the signed-delta SQL increments token
  // counters on user_api_usage regardless of cost direction. Pin this so a
  // refactor that gates token writes on `signed_delta > 0` would be visible
  // — the refund case still represents real Anthropic-billed tokens that
  // need to land in the observability column.
  // -------------------------------------------------------------------------
  it('token counters: incremented additively on reconcile regardless of signed_delta sign', () => {
    const { state, reconcile } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 0n,
        cost_settled_micro_usd: 0n,
        reconciled_at: null,
      },
      user_usage: {
        user_id: 'auth0|alice',
        cost_micro_usd: 500_000n,
        input_tokens: 100,
        output_tokens: 200,
        cache_create_tokens: 50,
        cache_read_tokens: 75,
        web_search_uses: 1,
      },
    });

    // Refund case — actual < projected — but token counters still grew.
    reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|alice',
      projected: 500_000n,
      actualMicro: 120_000n,
      accumulator: {
        input_tokens: 50,
        output_tokens: 25,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 5,
        web_search_requests: 2,
      },
    });

    expect(state.user_usage.input_tokens).toBe(150); // 100 + 50
    expect(state.user_usage.output_tokens).toBe(225); // 200 + 25
    expect(state.user_usage.cache_create_tokens).toBe(60); // 50 + 10
    expect(state.user_usage.cache_read_tokens).toBe(80); // 75 + 5
    expect(state.user_usage.web_search_uses).toBe(3); // 1 + 2
  });

  // -------------------------------------------------------------------------
  // EXISTS-guard idempotency: if a second reconcile attempt fires against
  // an already-reconciled row (e.g. retry from a queued background job),
  // the user_api_usage UPDATE skips. The mirror models this via the
  // `matches` check; the production SQL achieves it via
  // `EXISTS(SELECT 1 FROM msg_upd)`.
  // -------------------------------------------------------------------------
  it('EXISTS-guard: a second reconcile against the same row no-ops user_api_usage', () => {
    const { state, reconcile } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 0n,
        cost_settled_micro_usd: 0n,
        reconciled_at: null,
      },
      user_usage: {
        user_id: 'auth0|alice',
        cost_micro_usd: 100_000n,
        input_tokens: 0,
        output_tokens: 0,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
        web_search_uses: 0,
      },
    });

    reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|alice',
      projected: 100_000n,
      actualMicro: 300_000n,
      accumulator: ZERO_ACC,
    });
    const userCostAfter1st = state.user_usage.cost_micro_usd;

    // Second attempt — would re-credit (actual - baseline) without the
    // EXISTS guard. With the guard, it no-ops.
    reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|alice',
      projected: 100_000n,
      actualMicro: 999_000_000n,
      accumulator: ZERO_ACC,
    });
    expect(state.user_usage.cost_micro_usd).toBe(userCostAfter1st);
  });

  // -------------------------------------------------------------------------
  // Ownership pin: the CTE bakes user_id into both the SELECT FOR UPDATE
  // and the msg_upd / signed_delta clauses. A mismatched actorId must
  // result in no row mutation (analogous to the helper's IDOR guard).
  // -------------------------------------------------------------------------
  it('ownership: a wrong actorId no-ops both rows', () => {
    const { state, reconcile } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 0n,
        cost_settled_micro_usd: 0n,
        reconciled_at: null,
      },
      user_usage: {
        user_id: 'auth0|alice',
        cost_micro_usd: 100_000n,
        input_tokens: 0,
        output_tokens: 0,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
        web_search_uses: 0,
      },
    });

    const r = reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|bob', // wrong user
      projected: 100_000n,
      actualMicro: 9_000_000n,
      accumulator: ZERO_ACC,
    });

    expect(r.appliedSignedDelta).toBe(0n);
    expect(state.message.cost_settled_micro_usd).toBe(0n);
    expect(state.message.reconciled_at).toBeNull();
    expect(state.user_usage.cost_micro_usd).toBe(100_000n);
  });
});
