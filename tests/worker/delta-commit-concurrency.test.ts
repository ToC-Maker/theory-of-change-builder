// Concurrency simulation for `applyDeltaCommit` (worker/_shared/cost-commit.ts).
//
// SCOPE NOTE — read this before adding cases or trusting these tests:
//
// This file is an in-memory simulation, NOT a real Postgres test. The
// helper's contract depends on a Postgres invariant the simulation does
// not exercise: a single SQL statement with `SELECT ... FOR UPDATE`
// holds a row-level exclusive lock for the duration of that statement,
// which serialises concurrent writers against the same `message_id`.
// Trusting the lock semantics is reasonable here — they are well-defined
// in the Postgres docs and the helper is one CTE statement (the JSDoc
// at the top of cost-commit.ts pins this) — but the simulation cannot
// catch a regression where, e.g., the CTE accidentally became two
// statements (which Neon HTTP would silently allow with no error, and
// the lock would expire between them, allowing concurrent writers to
// see stale `cost_settled` and double-count the delta).
//
// What the simulation DOES exercise (worth pinning):
//   1. The CTE algebra: baseline = max(projected, settled); delta =
//      max(0, newCost - baseline); new_settled = max(settled, newCost).
//   2. Order-independence: under serialised execution, the final
//      `cost_settled` and the total `user_api_usage` delta are
//      deterministic regardless of which writer commits first.
//   3. The `reconciled_at` lock: a stamped row produces `applied:false`
//      with no state change, even mid-flight.
//
// What the simulation DOES NOT exercise (deferred):
//   - Real `FOR UPDATE` row-lock acquisition / blocking semantics.
//   - Single-statement vs multi-statement Neon HTTP behaviour.
//   - Postgres NULL/CHECK/PK constraint interactions.
//
// For real-Postgres coverage, the project would need either a Neon test
// branch with credentials provisioned in the Workers test runtime
// (`@cloudflare/vitest-pool-workers` runs inside workerd, which can't
// reach a local Docker postgres via raw TCP) or a dedicated integration
// suite outside the current vitest harness. The plan's
// `tests/worker/delta-commit-concurrency.test.ts` entry was specced
// against real Postgres; this file is the acceptable Option B fallback
// (see the Task 5 Decision Record / "concurrency simulation (in-memory)"
// note in the prompt that introduced this file).
//
// If real-Postgres coverage is added later, this file should stay —
// it remains a fast unit-level pin on the algebra. The integration
// suite is complementary.
import { describe, expect, it } from 'vitest';
import { applyDeltaCommit } from '../../worker/_shared/cost-commit';
import { makeBackend } from '../_shared/in-memory-cost-backend';

describe('applyDeltaCommit — concurrency simulation (in-memory)', () => {
  // ---------------------------------------------------------------------
  // Headline scenario from the plan (Test Design § Integration tests):
  //   Initial: cost_settled = $0.20 (200k µUSD), projected = $0.10 (100k).
  //   Two writers: newCost = $0.30 (300k) and $0.50 (500k).
  //   Expected: final settled = $0.50, total user_api_usage delta = $0.30.
  //   Trace (regardless of order):
  //     order [0.30, 0.50]:
  //       1) baseline=max(0.10, 0.20)=0.20, delta=max(0,0.30-0.20)=0.10, settled→0.30
  //       2) baseline=max(0.10, 0.30)=0.30, delta=max(0,0.50-0.30)=0.20, settled→0.50
  //       sum delta = 0.30
  //     order [0.50, 0.30]:
  //       1) baseline=max(0.10, 0.20)=0.20, delta=max(0,0.50-0.20)=0.30, settled→0.50
  //       2) baseline=max(0.10, 0.50)=0.50, delta=max(0,0.30-0.50)=0,    settled→0.50
  //       sum delta = 0.30
  // ---------------------------------------------------------------------
  it('two concurrent writers against the same message_id converge to the deterministic final state', async () => {
    const { sql, state } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 200_000n,
        cost_settled_micro_usd: 200_000n,
        reconciled_at: null,
      },
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
    });

    const [a, b] = await Promise.all([
      applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 100_000n, 300_000n),
      applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 100_000n, 500_000n),
    ]);

    // Both writers report applied:true; the order of which produces the
    // larger delta depends on lock-acquisition order (whichever runs
    // first sees the lower baseline). The invariants below are what the
    // plan pins: deterministic final state regardless of order.
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(true);

    expect(state.message.cost_settled_micro_usd).toBe(500_000n);
    expect(state.user_usage.cost_micro_usd).toBe(300_000n);
    expect(a.delta + b.delta).toBe(300_000n);
  });

  it('reverse-ordered concurrent writers converge to the same deterministic state', async () => {
    // Identical to the previous test but with the writer arguments swapped.
    // The mutex serialises the calls in some order; either way the
    // post-condition is identical (300k user_api_usage delta, 500k settled).
    const { sql, state } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 200_000n,
        cost_settled_micro_usd: 200_000n,
        reconciled_at: null,
      },
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
    });

    const [a, b] = await Promise.all([
      applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 100_000n, 500_000n),
      applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 100_000n, 300_000n),
    ]);

    expect(a.applied).toBe(true);
    expect(b.applied).toBe(true);
    expect(state.message.cost_settled_micro_usd).toBe(500_000n);
    expect(state.user_usage.cost_micro_usd).toBe(300_000n);
    expect(a.delta + b.delta).toBe(300_000n);
  });

  it('three concurrent writers in a long stream converge to the highest newCost', async () => {
    // Models a stream that fires running_cost emits at 5s/10s/15s; under
    // serialised execution, the cost_settled monotone-climbs and the
    // user_api_usage total is exactly (final - initial settled).
    const { sql, state } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 100_000n,
        cost_settled_micro_usd: 100_000n,
        reconciled_at: null,
      },
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
    });
    const projected = 100_000n;

    const results = await Promise.all([
      applyDeltaCommit(sql, 'msg_x', 'auth0|alice', projected, 250_000n),
      applyDeltaCommit(sql, 'msg_x', 'auth0|alice', projected, 400_000n),
      applyDeltaCommit(sql, 'msg_x', 'auth0|alice', projected, 700_000n),
    ]);

    expect(state.message.cost_settled_micro_usd).toBe(700_000n);
    // Total credited to user = 700k - max(projected, initial settled) = 700k - 100k = 600k.
    expect(state.user_usage.cost_micro_usd).toBe(600_000n);
    expect(results.reduce((acc, r) => acc + r.delta, 0n)).toBe(600_000n);
  });

  it('a reconciled_at-stamped row produces applied:false with no state change', async () => {
    // The post-stream reconcile (Task 8) stamps reconciled_at = NOW();
    // late retries from the localStorage queue must no-op. The simulated
    // backend mirrors the real `WHERE reconciled_at IS NULL` behaviour by
    // falling through to the CTE-empty shape.
    const { sql, state } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 500_000n,
        cost_settled_micro_usd: 500_000n,
        reconciled_at: new Date('2026-05-16T12:00:00Z'),
      },
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 500_000n },
    });

    const result = await applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 100_000n, 9_000_000n);

    expect(result).toEqual({
      applied: false,
      reason: 'row_not_found_or_foreign_or_reconciled',
      delta: 0n,
      new_settled: 0n,
    });
    // State is untouched: cost_settled stays at 500k, user_api_usage at 500k.
    expect(state.message.cost_settled_micro_usd).toBe(500_000n);
    expect(state.user_usage.cost_micro_usd).toBe(500_000n);
  });

  it('an ownership mismatch produces applied:false with no state change', async () => {
    // The real CTE's `AND user_id = $3` excludes the row when the caller
    // doesn't own it; the simulated backend's `row.user_id === userId`
    // check mirrors that. This covers the IDOR (insecure direct object
    // reference) attack surface at the helper level — even if a caller
    // somehow guessed a logging_message_id, the user_id pin prevents
    // them from inflating the cap on someone else's row.
    const { sql, state } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 100_000n,
        cost_settled_micro_usd: 100_000n,
        reconciled_at: null,
      },
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
    });

    const result = await applyDeltaCommit(
      sql,
      'msg_x',
      'auth0|bob', // wrong user
      0n,
      9_000_000n,
    );

    expect(result).toEqual({
      applied: false,
      reason: 'row_not_found_or_foreign_or_reconciled',
      delta: 0n,
      new_settled: 0n,
    });
    expect(state.message.cost_settled_micro_usd).toBe(100_000n);
    expect(state.user_usage.cost_micro_usd).toBe(0n);
  });
});
