// Tests for `firePerUpdateCommit` (worker/api/anthropic-stream.ts).
//
// SCOPE NOTE — read this before adding cases:
//
// Goal of Task 7: every `running_cost` SSE emit on the server should fire a
// fire-and-forget `applyDeltaCommit` so the DB tracks running cost
// continuously, surviving stream abort or isolate death.
//
// The production code paths (parseFrame's message_start / message_delta
// branches, plus `pollCostEstimate`) all funnel through a shared helper —
// `firePerUpdateCommit` — that takes a synchronously-snapshotted cost
// value, schedules the per-update commit via `ctx.waitUntil`, and writes a
// `DiagnosticPerUpdateCommit` row. Exporting that helper from
// anthropic-stream.ts is what makes this test possible without spinning up
// the full transform stream / fetch upstream / parsing harness.
//
// Testing approach: HYBRID.
//
//   - The `applyDeltaCommit` helper itself is exercised against an in-memory
//     simulation backend (mirrors the pattern in
//     `tests/worker/delta-commit-concurrency.test.ts`). That backend pins
//     the algebra: `cost_settled = max(prev, newCost)` and
//     `user_api_usage += max(0, newCost - max(projected, prev_settled))`.
//   - `firePerUpdateCommit` calls into `applyDeltaCommit` via the live
//     import; we route those calls into the in-memory backend via the
//     `sql` we pass on the deps object (no module mocks needed — the
//     helper itself takes `sql` from the deps, not from a static binding).
//   - The `ExecutionContext` is stubbed with a tracked `waitUntil` that
//     stores the awaited promise so the test can await all scheduled work
//     before asserting.
//
// What this file pins that nothing else does:
//   1. The fire-and-forget IIFE inside `firePerUpdateCommit` calls
//      `applyDeltaCommit` with the **snapshot** value — i.e. mutating the
//      caller's `let` binding after the call does not change what
//      eventually lands in the DB. This is the C2 closure-snapshot rule.
//   2. The `DiagnosticPerUpdateCommit` row is written with the correct
//      `source` label ('poll' / 'message_start' / 'message_delta') and
//      contains the snap value, projected, new_settled, and applied flag.
//   3. `applied=false` paths (row missing, row reconciled, ownership
//      mismatch) do not throw; the helper logs but completes.
//   4. Successive emits at simulated 5s / 10s / 15s converge to the
//      last-seen value for both `cost_settled_micro_usd` and
//      `user_api_usage.cost_micro_usd` — the headline scenario from the
//      Task 7 plan section.
//
// What this file does NOT pin (covered elsewhere):
//   - Real Postgres `FOR UPDATE` lock semantics
//     (`delta-commit-concurrency.test.ts` notes the same gap).
//   - parseFrame / pollCostEstimate driving the helper from real SSE
//     bytes — we trust the integration via the helper-extraction.
//     Acceptance gate for the wiring is the grep-count check in the
//     plan: `grep -c "DiagnosticPerUpdateCommit" worker/api/anthropic-stream.ts` ≥ 3.
import { describe, expect, it, vi } from 'vitest';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { firePerUpdateCommit } from '../../worker/api/anthropic-stream';
import { makeBackend } from '../_shared/in-memory-cost-backend';

// ExecutionContext stub: tracks every promise passed to waitUntil so the
// test can `await Promise.all(tracker)` before asserting. The real Worker
// runtime runs them in the background after handler return; here we make
// the scheduling observable.
function makeCtxStub(): {
  ctx: { waitUntil(p: Promise<unknown>): void };
  scheduled: Promise<unknown>[];
} {
  const scheduled: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(p: Promise<unknown>): void {
        scheduled.push(p);
      },
    },
    scheduled,
  };
}

// Build the minimal deps object that `firePerUpdateCommit` accepts. The
// production helper takes a `SseTeeContext`, but the parameter only reads
// the subset we model here.
function makeDeps(
  sql: NeonQueryFunction<false, false>,
  ctx: { waitUntil(p: Promise<unknown>): void },
  overrides: Partial<{
    loggingMessageId: string | null;
    actorId: string;
    projectedMicroUsd: bigint;
    chartId: string | null;
    deploymentHost: string;
    handlerStartedAtMs: number;
  }> = {},
) {
  // `in` discrimination preserves `null` (vs `??` which would clobber it).
  // Some tests need `loggingMessageId: null` to exercise the early-bail
  // branch; the default for unset is `'msg_x'`.
  return {
    sql,
    ctx,
    loggingMessageId: 'loggingMessageId' in overrides ? overrides.loggingMessageId! : 'msg_x',
    actorId: overrides.actorId ?? 'auth0|alice',
    projectedMicroUsd: overrides.projectedMicroUsd ?? 100_000n,
    chartId: 'chartId' in overrides ? overrides.chartId! : 'chart_x',
    deploymentHost: overrides.deploymentHost ?? 'preview.example.com',
    lifecycle: { handlerStartedAtMs: overrides.handlerStartedAtMs ?? 1_000_000 },
  };
}

describe('firePerUpdateCommit — per-update commit on running_cost emit', () => {
  it('headline: emits at simulated 5s/10s/15s converge cost_settled and user_api_usage to the last value', async () => {
    // Models a stream that fires `running_cost` at 5s / 10s / 15s with
    // monotone-increasing snap values, then aborts. The post-condition
    // is independent of which IIFE runs first (verified in
    // delta-commit-concurrency.test.ts too); here we additionally
    // pin that the helper actually schedules a commit on every emit
    // — the regression target of Task 7 is "a stream that dies mid-flight
    // still leaves user_api_usage at the last-known running cost".
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
    const { ctx, scheduled } = makeCtxStub();
    const deps = makeDeps(sql, ctx, { projectedMicroUsd: 100_000n });

    // Three emits — order matches typical stream cadence (poll -> poll -> message_delta).
    firePerUpdateCommit(deps, 250_000n, 'poll');
    firePerUpdateCommit(deps, 400_000n, 'poll');
    firePerUpdateCommit(deps, 700_000n, 'message_delta');

    expect(scheduled).toHaveLength(3);
    await Promise.all(scheduled);

    // After all three commits, settled climbs to the max (700k) and
    // user_api_usage carries the total above-baseline delta:
    // 700k - max(projected=100k, settled=100k) = 600k.
    expect(state.message?.cost_settled_micro_usd).toBe(700_000n);
    expect(state.user_usage.cost_micro_usd).toBe(600_000n);
  });

  it('applied=true path: a single emit credits user_api_usage by the snap delta', async () => {
    const { sql, state, diagnosticInserts } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 0n,
        cost_settled_micro_usd: 0n,
        reconciled_at: null,
      },
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
    });
    const { ctx, scheduled } = makeCtxStub();
    const deps = makeDeps(sql, ctx, { projectedMicroUsd: 50_000n });

    firePerUpdateCommit(deps, 250_000n, 'message_start');

    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);

    // delta = max(0, 250k - max(50k, 0)) = 200k.
    expect(state.user_usage.cost_micro_usd).toBe(200_000n);
    expect(state.message?.cost_settled_micro_usd).toBe(250_000n);

    // Exactly one diagnostic row, with applied=true and the correct source.
    expect(diagnosticInserts).toHaveLength(1);
    const diag = diagnosticInserts[0];
    expect(diag.error_name).toBe('DiagnosticPerUpdateCommit');
    expect(diag.metadata.source).toBe('message_start');
    expect(diag.metadata.applied).toBe(true);
    expect(diag.metadata.cost_micro_usd).toBe('250000');
    expect(diag.metadata.projected_micro_usd).toBe('50000');
    expect(diag.metadata.new_settled_micro_usd).toBe('250000');
    expect(diag.metadata.delta_micro_usd).toBe('200000');
    expect(diag.metadata.logging_message_id).toBe('msg_x');
  });

  it('applied=false path: row missing produces no state change, no throw, diagnostic still logs', async () => {
    // Models a per-update write firing before saveMessage's INSERT has
    // landed. The CTE's `WHERE message_id = $1` matches nothing; the
    // helper returns `applied: false` and the IIFE completes cleanly.
    const { sql, state, diagnosticInserts } = makeBackend({
      message: null, // no logging_messages row yet
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
    });
    const { ctx, scheduled } = makeCtxStub();
    const deps = makeDeps(sql, ctx);

    expect(() => firePerUpdateCommit(deps, 250_000n, 'poll')).not.toThrow();
    await Promise.all(scheduled);

    expect(state.user_usage.cost_micro_usd).toBe(0n);
    expect(diagnosticInserts).toHaveLength(1);
    expect(diagnosticInserts[0].metadata.applied).toBe(false);
    expect(diagnosticInserts[0].metadata.source).toBe('poll');
    // delta and new_settled both 0 on no-op (helper returns shape).
    expect(diagnosticInserts[0].metadata.delta_micro_usd).toBe('0');
    expect(diagnosticInserts[0].metadata.new_settled_micro_usd).toBe('0');
  });

  it('applied=false path: reconciled_at non-null no-ops late emits without re-inflating', async () => {
    // The post-stream reconcile (Task 8) stamps reconciled_at = NOW().
    // A late running_cost emit (e.g. retried IIFE from a 7-day localStorage
    // queue, or a poll-in-flight that returns after reconcile) must not
    // re-credit user_api_usage. The `WHERE reconciled_at IS NULL` guard
    // in the CTE collapses to a no-op.
    const { sql, state, diagnosticInserts } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 500_000n,
        cost_settled_micro_usd: 500_000n,
        reconciled_at: new Date('2026-05-16T12:00:00Z'),
      },
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 500_000n },
    });
    const { ctx, scheduled } = makeCtxStub();
    const deps = makeDeps(sql, ctx);

    firePerUpdateCommit(deps, 9_000_000n, 'message_delta');
    await Promise.all(scheduled);

    // State unchanged: cap stays at 500k, settled stays at 500k.
    expect(state.user_usage.cost_micro_usd).toBe(500_000n);
    expect(state.message?.cost_settled_micro_usd).toBe(500_000n);
    expect(diagnosticInserts).toHaveLength(1);
    expect(diagnosticInserts[0].metadata.applied).toBe(false);
  });

  it('source labels propagate to diagnostic metadata (poll / message_start / message_delta)', async () => {
    const { sql, diagnosticInserts } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 0n,
        cost_settled_micro_usd: 0n,
        reconciled_at: null,
      },
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
    });
    const { ctx, scheduled } = makeCtxStub();
    const deps = makeDeps(sql, ctx);

    firePerUpdateCommit(deps, 100_000n, 'poll');
    firePerUpdateCommit(deps, 200_000n, 'message_start');
    firePerUpdateCommit(deps, 300_000n, 'message_delta');
    await Promise.all(scheduled);

    expect(diagnosticInserts).toHaveLength(3);
    expect(diagnosticInserts.map((d) => d.metadata.source)).toEqual([
      'poll',
      'message_start',
      'message_delta',
    ]);
  });

  it('C2 closure-snapshot rule: post-call mutation of the caller binding does not change what gets committed', async () => {
    // The plan calls this out explicitly: the caller must snapshot
    // `finalMicro` synchronously into a `const snap` BEFORE the IIFE
    // closure runs. The helper takes `snap` as a value-type bigint
    // parameter, so even a caller that reassigns the outer `let
    // finalMicro` between the helper call and the awaited IIFE
    // settling cannot affect what lands in the DB.
    const { sql, state } = makeBackend({
      message: {
        message_id: 'msg_x',
        user_id: 'auth0|alice',
        cost_micro_usd: 0n,
        cost_settled_micro_usd: 0n,
        reconciled_at: null,
      },
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
    });
    const { ctx, scheduled } = makeCtxStub();
    const deps = makeDeps(sql, ctx, { projectedMicroUsd: 0n });

    // Simulate the production call pattern: a `let` binding that gets
    // mutated by the surrounding stream-handling code between the helper
    // invocation and the IIFE actually running.
    let liveFinalMicro = 250_000n;
    const snap = liveFinalMicro; // synchronous snapshot
    firePerUpdateCommit(deps, snap, 'poll');
    // Concurrent stream mutation — a subsequent message_delta event has
    // arrived and bumped the local binding. If the helper's IIFE
    // captured the binding instead of the snapshot, this value would
    // leak into the DB.
    liveFinalMicro = 9_999_999_999n;

    await Promise.all(scheduled);

    // The DB sees the snapshot value (250k), not the post-mutation value.
    expect(state.message?.cost_settled_micro_usd).toBe(250_000n);
    expect(state.user_usage.cost_micro_usd).toBe(250_000n);
    // Sanity: the post-mutation value really did land in the local
    // binding (i.e. we actually tested mutation-after-call, not a
    // mutation that silently failed). Differentiates a "snapshot
    // worked" pass from a "mutation didn't happen" false pass.
    expect(liveFinalMicro).toBe(9_999_999_999n);
  });

  it('does not throw or schedule when loggingMessageId is null (no row to commit against)', async () => {
    // Before the X-Logging-Message-Id header lands, per-update writes
    // have nowhere to commit. The helper's contract: bail silently,
    // do not schedule a no-op IIFE that would still write a diagnostic.
    const { sql, diagnosticInserts } = makeBackend({
      message: null,
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
    });
    const { ctx, scheduled } = makeCtxStub();
    const deps = makeDeps(sql, ctx, { loggingMessageId: null });

    expect(() => firePerUpdateCommit(deps, 250_000n, 'poll')).not.toThrow();
    expect(scheduled).toHaveLength(0);
    expect(diagnosticInserts).toHaveLength(0);
  });

  it('swallows applyDeltaCommit failures so the stream IIFE does not crash the runtime', async () => {
    // Recovery-of-recovery: the per-update write lives inside ctx.waitUntil.
    // A throw inside the IIFE would surface as an unhandled-rejection in
    // the Workers runtime. The helper wraps applyDeltaCommit in try/catch
    // and falls back to console.error.
    const sql = (() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn: any = () => Promise.reject(new Error('simulated neon outage'));
      return fn as NeonQueryFunction<false, false>;
    })();
    const { ctx, scheduled } = makeCtxStub();
    const deps = makeDeps(sql, ctx);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    firePerUpdateCommit(deps, 250_000n, 'poll');
    // Awaiting the scheduled promise must not throw — the IIFE swallowed it.
    await expect(Promise.all(scheduled)).resolves.toBeDefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
