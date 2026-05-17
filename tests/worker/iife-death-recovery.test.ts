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
import { applyDeltaCommit } from '../../worker/_shared/cost-commit';
import {
  makeBackend as makeSharedBackend,
  type LoggingMessageRow,
} from '../_shared/in-memory-cost-backend';
// Raw source import — used by the Finding A structural pins to assert the
// production reconcile block captures the signed-delta CTE RETURNING into
// a typed local, gates the `global_monthly_usage` INSERT on that, and
// emits `DiagnosticReconcileSkipped` on the no-op branch. Vitest's
// `?raw` is the same mechanism `cost-commit-sql-invariants.test.ts`
// uses; it pulls the file bytes without ever evaluating the module
// (the production handler depends on Workers globals that the test
// runtime doesn't have).
import anthropicStreamSource from '../../worker/api/anthropic-stream.ts?raw';

// Extended user_api_usage shape — the shared backend's required base is
// `{user_id, cost_micro_usd}` with `byok_cost_micro_usd?` optional (the
// latter added for the BYOK regression fix, 2026-05-17; defaults to 0n
// in `makeBackend`). We add the token-counter columns the reconcile-CTE
// mirror needs to mutate. Passed through the generic on
// `makeSharedBackend` so `state.user_usage` is typed with all fields.
type UserApiUsageRow = {
  user_id: string;
  cost_micro_usd: bigint;
  byok_cost_micro_usd?: bigint;
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

// File-local reconcile-CTE mirror. Distinct from the applyDeltaCommit
// algebra (lives in `tests/_shared/in-memory-cost-backend.ts`) — this
// models the *signed-delta* reconcile SQL in
// `worker/api/anthropic-stream.ts`, which:
//   - computes a SIGNED delta (refunds when actual < projected);
//   - stamps `reconciled_at`;
//   - clamps `user_api_usage.cost_micro_usd` to ≥0 via GREATEST;
//   - increments token-counter columns additively;
//   - guards the user_api_usage UPDATE with EXISTS(SELECT 1 FROM msg_upd).
// Keeping this local to the file (not in `_shared`) because:
//   1. It's reconcile-specific, not applyDeltaCommit-specific.
//   2. Only one test file exercises it.
//   3. It depends on the extended UserApiUsageRow shape that only this
//      file uses.
function makeReconcile(state: { message: LoggingMessageRow; user_usage: UserApiUsageRow }) {
  return function reconcile(input: {
    loggingMessageId: string;
    actorId: string;
    projected: bigint;
    actualMicro: bigint;
    accumulator: ReconcileAccumulator;
    /**
     * BYOK routing flag, mirroring the production `tierIsByok` interpolation
     * in `anthropic-stream.ts`. When true, the signed delta is routed to
     * `byok_cost_micro_usd` (independent of free cap); when false, it goes
     * to `cost_micro_usd` (the column reserveCost reads). Defaults to false
     * so existing free/anon tests stay green without modification.
     */
    isByok?: boolean;
  }): {
    settled: bigint;
    appliedSignedDelta: bigint;
    userCost: bigint;
    reconciledAt: Date | null;
    /**
     * Models the production reconcile SQL's RETURNING row count. The outer
     * `UPDATE user_api_usage ... WHERE ... AND EXISTS(SELECT 1 FROM msg_upd)
     * RETURNING ...` produces:
     *   - 1 row when the CTE found + locked the message row (happy path).
     *   - 0 rows when msg_upd RETURNING was empty (row missing, foreign,
     *     or `reconciled_at` already non-null).
     * Production code in `worker/api/anthropic-stream.ts` (post-Finding A)
     * uses this count to gate the subsequent `global_monthly_usage` INSERT
     * and the `DiagnosticReconcileSkipped` emit; pinning the count here
     * lets the test mirror those branches against deterministic state.
     */
    appliedRows: 0 | 1;
  } {
    const {
      loggingMessageId,
      actorId,
      projected,
      actualMicro,
      accumulator,
      isByok = false,
    } = input;
    const row = state.message;
    const matches =
      row.message_id === loggingMessageId && row.user_id === actorId && row.reconciled_at === null;
    if (!matches) {
      // EXISTS(SELECT 1 FROM msg_upd) is false: user_api_usage UPDATE skipped.
      // Production reconcile SQL's RETURNING yields 0 rows here.
      return {
        settled: row.cost_settled_micro_usd,
        appliedSignedDelta: 0n,
        userCost: state.user_usage.cost_micro_usd,
        reconciledAt: row.reconciled_at,
        appliedRows: 0,
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
    // Route the signed delta to one of the two cost columns based on
    // `isByok`, mirroring the production CASE-WHEN in the reconcile SQL.
    // GREATEST(0, ...) clamp applies to both columns (negative-clamp
    // safety regardless of routing). `?? 0n` defaults the optional
    // byok column to zero for tests that don't initialize it.
    const currentByok = state.user_usage.byok_cost_micro_usd ?? 0n;
    const newFreeCost = isByok
      ? state.user_usage.cost_micro_usd
      : state.user_usage.cost_micro_usd + signedDelta;
    const newByokCost = isByok ? currentByok + signedDelta : currentByok;
    state.user_usage = {
      ...state.user_usage,
      cost_micro_usd: newFreeCost < 0n ? 0n : newFreeCost,
      byok_cost_micro_usd: newByokCost < 0n ? 0n : newByokCost,
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
      // userCost reports the column the delta routed into for assertion
      // convenience (most existing tests are free-tier and check this
      // exact field). BYOK tests can read state.user_usage.byok_cost_micro_usd
      // directly.
      userCost: isByok
        ? (state.user_usage.byok_cost_micro_usd ?? 0n)
        : state.user_usage.cost_micro_usd,
      reconciledAt: newReconciledAt,
      appliedRows: 1,
    };
  };
}

// Thin wrapper that combines the shared backend (applyDeltaCommit algebra
// + diagnostics capture) with the file-local reconcile-CTE mirror.
function makeBackend(initial: { message: LoggingMessageRow; user_usage: UserApiUsageRow }): {
  sql: ReturnType<typeof makeSharedBackend<UserApiUsageRow>>['sql'];
  state: { message: LoggingMessageRow; user_usage: UserApiUsageRow };
  reconcile: ReturnType<typeof makeReconcile>;
} {
  const backend = makeSharedBackend<UserApiUsageRow>(initial);
  // `state.message` is non-null on this overload (matched the non-null
  // input). Re-tighten for the local `reconcile` helper.
  const state = backend.state as { message: LoggingMessageRow; user_usage: UserApiUsageRow };
  const reconcile = makeReconcile(state);
  return { sql: backend.sql, state, reconcile };
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

  // -------------------------------------------------------------------------
  // BYOK routing pin (regression fix 2026-05-17): when `isByok=true`, the
  // signed delta lands in `byok_cost_micro_usd`, NOT `cost_micro_usd`.
  // The headline invariant of the fix: a BYOK reconcile MUST NOT inflate
  // the free-tier cap. `cost_micro_usd` is the column reserveCost reads
  // against `LIFETIME_CAP_MICRO_USD`, so a BYOK write to that column would
  // silently deplete the free cap — the exact bug this fix targets.
  // -------------------------------------------------------------------------
  it('BYOK routing: positive signed_delta credits byok_cost_micro_usd, leaves cost_micro_usd untouched (cap not depleted)', () => {
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
        // Pre-BYOK free spend: $0.10. The cap-check column.
        cost_micro_usd: 100_000n,
        byok_cost_micro_usd: 0n,
        input_tokens: 0,
        output_tokens: 0,
        cache_create_tokens: 0,
        cache_read_tokens: 0,
        web_search_uses: 0,
      },
    });

    // A BYOK stream reconciles with $4.00 of additional spend. Pre-fix this
    // would land in cost_micro_usd, leaving only $0.90 of free cap and
    // breaking the documented invariant "BYOK bypasses the per-user
    // lifetime cap".
    const result = reconcile({
      loggingMessageId: 'msg_x',
      actorId: 'auth0|alice',
      projected: 0n, // BYOK doesn't reserve (no cap to gate against)
      actualMicro: 4_000_000n, // $4.00
      accumulator: ZERO_ACC,
      isByok: true,
    });

    // signed_delta = 4_000_000 - max(0, 0) = 4_000_000 (positive).
    expect(result.appliedSignedDelta).toBe(4_000_000n);
    // Free-cap column is UNTOUCHED — BYOK doesn't deplete the free cap.
    expect(state.user_usage.cost_micro_usd).toBe(100_000n);
    // BYOK column carries the full spend.
    expect(state.user_usage.byok_cost_micro_usd).toBe(4_000_000n);
    // logging_messages.cost_settled_micro_usd still records the truth
    // regardless of routing (it's the per-message attribution key).
    expect(state.message.cost_settled_micro_usd).toBe(4_000_000n);
    expect(state.message.reconciled_at).not.toBeNull();
  });

  it('BYOK routing: token counters land regardless of routing (observability invariant)', () => {
    // The token-counter columns on user_api_usage track observability,
    // not cost. They increment additively whether the delta routed to
    // free or BYOK — a refactor that gated tokens behind the free arm
    // would silently zero out BYOK usage stats.
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
        cost_micro_usd: 0n,
        byok_cost_micro_usd: 0n,
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
      projected: 0n,
      actualMicro: 100_000n,
      accumulator: {
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200,
        web_search_requests: 3,
      },
      isByok: true,
    });
    expect(state.user_usage.input_tokens).toBe(1000);
    expect(state.user_usage.output_tokens).toBe(500);
    expect(state.user_usage.cache_create_tokens).toBe(100);
    expect(state.user_usage.cache_read_tokens).toBe(200);
    expect(state.user_usage.web_search_uses).toBe(3);
  });

  // ---------------------------------------------------------------------
  // Finding A: capture signed-delta CTE RETURNING + gate global_monthly_usage
  // + emit DiagnosticReconcileSkipped when reconcile no-op'd.
  //
  // Pre-fix: the post-stream reconcile in `worker/api/anthropic-stream.ts`
  // discarded the await result of the signed-delta SQL. Two consequences:
  //   1. global_monthly_usage INSERT ran unconditionally — narrow double-
  //      count window when reconcile re-entered past the 60s idempotency
  //      window against an already-reconciled row.
  //   2. The "no rows applied" case was invisible to `logging_errors` —
  //      only `DiagnosticReconcileFailed` (SQL exception path) was queryable.
  //
  // Post-fix: production captures `reconcileRows = (await sql\`...\`)` as a
  // typed array, gates the `global_monthly_usage` INSERT on
  // `reconcileRows.length > 0 && isCapped(tier)`, and emits
  // `DiagnosticReconcileSkipped` when `reconcileRows.length === 0`.
  //
  // Why structural (?raw source) pins instead of behavioural mirror tests:
  // the reconcile block is inline in the streaming handler (no extractable
  // pure helper without much larger scope), and the existing mirror test
  // for the reconcile-CTE algebra cannot exercise the *production* gate
  // without an extracted function (a mirror that re-implements the gate
  // would test the mirror, not production). Structural pins follow the
  // same `?raw` + landmark pattern as `cost-commit-sql-invariants.test.ts`:
  // they catch removal/regression of the load-bearing tokens without
  // locking down formatting.
  //
  // Each landmark below was confirmed to fail loudly when the
  // corresponding production source was temporarily reverted (recorded
  // 2026-05-17 — revert before committing the regression verification).
  // ---------------------------------------------------------------------
  describe('Finding A: gate global_monthly_usage on reconcile rows + emit DiagnosticReconcileSkipped on no-op', () => {
    // The mirror still exercises the inner reconcile algebra (lock,
    // GREATEST, signed-delta math) end-to-end; this set of `it()` blocks
    // only pins the production source's gate landmarks. Without these,
    // a refactor that re-introduced the unconditional INSERT (or dropped
    // the diagnostic) would silently regress both fixes.
    it('captures the signed-delta CTE RETURNING into a typed local', () => {
      // The discarded-await was the headline of Finding A. Pin that the
      // RETURNING result is now stashed into a local named `reconcileRows`.
      // The exact name matters: downstream gating and diagnostic emit
      // both reference it by name.
      expect(anthropicStreamSource).toMatch(/const\s+reconcileRows\s*=\s*\(await\s+sql`/);
    });

    it('gates the global_monthly_usage INSERT on reconcileRows.length > 0', () => {
      // Pre-fix gate was `if (isCapped(tier))` only — the INSERT fired
      // even on no-op reconciles, narrow double-count window for repeated
      // reconciles past the 60s idempotency. Post-fix must include
      // `reconcileRows.length > 0` in the condition.
      expect(anthropicStreamSource).toMatch(
        /if\s*\(\s*reconcileRows\.length\s*>\s*0\s*&&\s*isCapped\(tier\)\s*\)/,
      );
    });

    it('emits DiagnosticReconcileSkipped when reconcileRows.length === 0', () => {
      // Pre-fix the no-op reconcile was invisible to logging_errors —
      // only the SQL-exception path wrote DiagnosticReconcileFailed.
      // Post-fix must call writeDiagnostic with `DiagnosticReconcileSkipped`
      // on the empty-rows branch so the no-op is queryable.
      expect(anthropicStreamSource).toMatch(
        /else\s+if\s*\(\s*reconcileRows\.length\s*===\s*0\s*\)/,
      );
      expect(anthropicStreamSource).toMatch(/error_name:\s*['"]DiagnosticReconcileSkipped['"]/);
    });

    it('DiagnosticReconcileSkipped carries logging_message_id, actual, and tier in metadata', () => {
      // The diagnostic must be queryable by message id to debug the
      // "did reconcile no-op for this stream?" question. Tier + actual
      // are observability signals for the reconcile-already-fired vs
      // ownership-mismatch sub-cases.
      //
      // Scope the regex to the writeDiagnostic call site — `error_name:`
      // anchors past any prose mentioning the name (e.g. in comments) and
      // captures up to ~1500 chars of metadata after.
      const skippedBlock = /error_name:\s*['"]DiagnosticReconcileSkipped['"][\s\S]{0,1500}/.exec(
        anthropicStreamSource,
      );
      expect(skippedBlock).not.toBeNull();
      const slice = skippedBlock![0];
      expect(slice).toMatch(/logging_message_id/);
      expect(slice).toMatch(/actual_micro_usd|actualMicro/);
      expect(slice).toMatch(/tier/);
    });
  });

  // ---------------------------------------------------------------------
  // In-mirror cross-check: the mirror's `appliedRows` discriminator
  // (added 2026-05-17 alongside Finding A) reports the CTE's outer
  // RETURNING row count. This gives the file-local algebra mirror parity
  // with the production code's gate input. Tests below pin that the
  // mirror produces appliedRows=0 in the same cases the production CTE
  // would (already-reconciled, foreign user), and appliedRows=1 on the
  // happy path. Together with the structural pins above, this catches
  // both mirror drift and production-source regression.
  // ---------------------------------------------------------------------
  describe('reconcile mirror: appliedRows discriminator matches production CTE row count', () => {
    it('happy path: appliedRows=1 when row was found + locked + updated', () => {
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
      const result = reconcile({
        loggingMessageId: 'msg_x',
        actorId: 'auth0|alice',
        projected: 100_000n,
        actualMicro: 300_000n,
        accumulator: ZERO_ACC,
      });
      expect(result.appliedRows).toBe(1);
      expect(state.message.reconciled_at).not.toBeNull();
    });

    it('already reconciled: appliedRows=0 (matches CTE RETURNING empty)', () => {
      const { state, reconcile } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 500_000n,
          cost_settled_micro_usd: 500_000n,
          reconciled_at: new Date('2026-05-17T09:00:00Z'),
        },
        user_usage: {
          user_id: 'auth0|alice',
          cost_micro_usd: 500_000n,
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
        actualMicro: 9_000_000n,
        accumulator: ZERO_ACC,
      });
      expect(result.appliedRows).toBe(0);
      // No state mutation — confirms the row-lock + GREATEST + late-retry
      // lock all held simultaneously.
      expect(state.message.cost_settled_micro_usd).toBe(500_000n);
      expect(state.user_usage.cost_micro_usd).toBe(500_000n);
    });

    it('foreign user (IDOR): appliedRows=0 (matches CTE RETURNING empty)', () => {
      const { reconcile } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 0n,
          cost_settled_micro_usd: 0n,
          reconciled_at: null,
        },
        user_usage: {
          user_id: 'auth0|alice',
          cost_micro_usd: 0n,
          input_tokens: 0,
          output_tokens: 0,
          cache_create_tokens: 0,
          cache_read_tokens: 0,
          web_search_uses: 0,
        },
      });
      const result = reconcile({
        loggingMessageId: 'msg_x',
        actorId: 'auth0|bob',
        projected: 100_000n,
        actualMicro: 9_000_000n,
        accumulator: ZERO_ACC,
      });
      expect(result.appliedRows).toBe(0);
    });
  });
});
