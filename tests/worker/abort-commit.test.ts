// Tests for `fireAbortCommit` (worker/api/anthropic-stream.ts).
//
// SCOPE NOTE — read this before adding cases:
//
// What `fireAbortCommit` guarantees: when `request.signal.abort` fires
// (user clicked Stop, or the connection dropped), schedule a final
// `applyDeltaCommit` via `ctx.waitUntil` AT THE MOMENT OF ABORT — earlier
// than the post-stream reconcile IIFE actually starts running. The
// reconcile IIFE awaits `tracked.done` and may not start its commit for
// many ms after abort (especially if `ctx.waitUntil`'s budget is
// contended); pre-scheduling a snapshot-and-commit gives the running
// cost its own slot in the queue, so it lands even if the reconcile IIFE
// dies before its commit.
//
// The production wiring lives inside the `abortController.signal`
// addEventListener at the bottom of the handler (the same place that
// already records `lifecycle.abortFiredAtMs`). It snapshots
// `teeCtx.accumulator` synchronously into a fresh object, computes a snap
// µUSD via `computeCostMicroUsd(model, accumulatorToUsage(snap))`, and
// passes the bigint into `fireAbortCommit` — exactly mirroring the
// `firePerUpdateCommit` discipline (synchronous snapshot before
// fire-and-forget, because the closure may not run for many ms after
// this point).
//
// Testing approach: HYBRID, identical to `per-update-write-e2e.test.ts`.
//   - `applyDeltaCommit` is exercised against an in-memory simulation backend
//     (mirrors `tests/worker/delta-commit-concurrency.test.ts`).
//   - `fireAbortCommit` is exported from `anthropic-stream.ts` and called
//     directly with a synthetic deps object. The `ExecutionContext` is
//     stubbed with a tracked `waitUntil` so the test can await all
//     scheduled work before asserting.
//
// What this file pins that nothing else does:
//   1. The fire-and-forget IIFE inside `fireAbortCommit` writes a
//      `DiagnosticAbortCommit` diagnostic with the snap value and applied flag.
//   2. The snapshot rule: mutating the caller's binding after the call
//      does not affect what lands in the DB (the IIFE captures the
//      snapshotted value, not the live binding).
//   3. The early-bail branches (snap = 0n, loggingMessageId null) do not
//      schedule a no-op IIFE.
//   4. Idempotency: an abort-commit at snap=X followed by a reconcile-commit
//      at snap=X (same-message) does NOT double-credit user_api_usage —
//      verifies the GREATEST + delta-clamp semantics hold across both
//      writers.
//   5. The IIFE swallows applyDeltaCommit failures via try/catch +
//      console.error so a Neon outage does not surface as an
//      unhandled-rejection in the runtime.
//
// What this file does NOT pin (covered elsewhere):
//   - The actual `addEventListener('abort', ...)` wiring inside the
//     handler. That requires running the full SSE harness and is more
//     practical to assert via the integration tests in
//     `iife-death-recovery.test.ts`. The acceptance gate for the wiring
//     is a grep-count check: every abort path is required to emit at
//     least one `DiagnosticAbortCommit` row
//     (`grep -c "DiagnosticAbortCommit" worker/api/anthropic-stream.ts` ≥ 1).
//   - Real Postgres `FOR UPDATE` lock semantics
//     (`delta-commit-concurrency.test.ts` covers that).
import { describe, expect, it, vi } from 'vitest';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { fireAbortCommit } from '../../worker/api/anthropic-stream';
import { makeBackend } from '../_shared/in-memory-cost-backend';
import { makeCtxStub, makeDeps } from '../_shared/commit-helpers';

describe('fireAbortCommit — final commit on request.signal.abort', () => {
  it('headline: a snap > 0 with loggingMessageId set commits and writes a DiagnosticAbortCommit row', async () => {
    // The regression target of `fireAbortCommit`: a stream that gets
    // aborted mid-flight (Stop button, browser close, network drop) should
    // still leave user_api_usage at the last-known running cost — even if
    // the post-stream reconcile IIFE dies before its commit. This test
    // pins the happy path: snap > 0n, loggingMessageId set, applyDeltaCommit
    // runs and credits the delta.
    const { sql, state, diagnosticInserts } = makeBackend({
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

    fireAbortCommit(deps, 450_000n);

    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);

    // delta = max(0, 450k - max(projected=100k, settled=100k)) = 350k.
    expect(state.message?.cost_settled_micro_usd).toBe(450_000n);
    expect(state.user_usage.cost_micro_usd).toBe(350_000n);

    // Diagnostic row carries the snap value, applied flag, and message id.
    expect(diagnosticInserts).toHaveLength(1);
    const diag = diagnosticInserts[0];
    expect(diag.error_name).toBe('DiagnosticAbortCommit');
    expect(diag.metadata.applied).toBe(true);
    expect(diag.metadata.cost_micro_usd).toBe('450000');
    expect(diag.metadata.logging_message_id).toBe('msg_x');
  });

  it('snap = 0n: no waitUntil scheduled (early bail before scheduling)', async () => {
    // No usage observed yet — abort fires before message_start. There's
    // nothing to commit; scheduling a no-op IIFE that still writes a
    // diagnostic would be log-noise.
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

    expect(() => fireAbortCommit(deps, 0n)).not.toThrow();
    expect(scheduled).toHaveLength(0);
    expect(diagnosticInserts).toHaveLength(0);
  });

  it('loggingMessageId null: no waitUntil scheduled (no row to commit against)', async () => {
    // Anonymous-without-message-id flow, or pre-stream abort before the
    // header was set. The helper must bail silently — no IIFE, no
    // diagnostic, no throw.
    const { sql, diagnosticInserts } = makeBackend({
      message: null,
      user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
    });
    const { ctx, scheduled } = makeCtxStub();
    const deps = makeDeps(sql, ctx, { loggingMessageId: null });

    expect(() => fireAbortCommit(deps, 250_000n)).not.toThrow();
    expect(scheduled).toHaveLength(0);
    expect(diagnosticInserts).toHaveLength(0);
  });

  it('closure-snapshot rule: mutation of caller binding after the call cannot leak into the DB', async () => {
    // Mirrors the matching closure-snapshot test in
    // `per-update-write-e2e.test.ts`. The abort handler snapshots the
    // live accumulator's cost into a `const snap` before invoking
    // `fireAbortCommit`. Because bigint is a primitive and `snap` is
    // passed by value, any subsequent mutation of the caller's local
    // binding is invisible to the IIFE.
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

    let liveFinalMicro = 250_000n;
    const snap = liveFinalMicro;
    fireAbortCommit(deps, snap);
    // Concurrent stream mutation simulating a late message_delta arrival.
    liveFinalMicro = 9_999_999_999n;

    await Promise.all(scheduled);

    expect(state.message?.cost_settled_micro_usd).toBe(250_000n);
    expect(state.user_usage.cost_micro_usd).toBe(250_000n);
    // Sanity: the post-call mutation actually landed locally — guards
    // against a "snapshot worked" pass that's really a "mutation didn't
    // happen" false pass.
    expect(liveFinalMicro).toBe(9_999_999_999n);
  });

  it('idempotency with reconcile: abort-commit + reconcile-commit at same snap → no double-credit', async () => {
    // Models the abort-vs-reconcile overlap: the abort-commit IIFE
    // schedules at abort time; the reconcile IIFE schedules at
    // end-of-handler-body. Both eventually fire `applyDeltaCommit`
    // against the same row. GREATEST + delta-clamp means whichever runs
    // second sees baseline=settled=snap and contributes a delta of 0 —
    // user_api_usage stays at the first commit's value, not 2× it.
    const { sql, state, diagnosticInserts } = makeBackend({
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

    // First: the abort-commit (fires at the moment of abort).
    fireAbortCommit(deps, 450_000n);
    // Second: a follow-up commit modelling the reconcile IIFE's own
    // applyDeltaCommit at the same snap (the reconcile may converge to
    // the same value if no further usage frames arrived after abort).
    fireAbortCommit(deps, 450_000n);

    expect(scheduled).toHaveLength(2);
    await Promise.all(scheduled);

    // First commit: delta = 450k - max(100k, 100k) = 350k. User cap = 350k.
    // Second commit: delta = 450k - max(100k, 450k) = 0. User cap stays at 350k.
    expect(state.message?.cost_settled_micro_usd).toBe(450_000n);
    expect(state.user_usage.cost_micro_usd).toBe(350_000n);

    // Both diagnostic rows fired (observability of the idempotency).
    expect(diagnosticInserts).toHaveLength(2);
    expect(diagnosticInserts.map((d) => d.metadata.applied)).toEqual([true, true]);
    // First applied delta = 350k; second is a no-op delta = 0.
    expect(diagnosticInserts[0].metadata.delta_micro_usd).toBe('350000');
    expect(diagnosticInserts[1].metadata.delta_micro_usd).toBe('0');
  });

  it('row already reconciled: late abort no-ops without re-inflating the cap', async () => {
    // Symmetric to the per-update-write reconciled-row test. If reconcile
    // got there first and stamped reconciled_at, a late abort-commit
    // (e.g. abort fired between reconcile finishing and the IIFE
    // returning) must not re-credit user_api_usage.
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

    fireAbortCommit(deps, 9_000_000n);
    await Promise.all(scheduled);

    expect(state.user_usage.cost_micro_usd).toBe(500_000n);
    expect(state.message?.cost_settled_micro_usd).toBe(500_000n);
    expect(diagnosticInserts).toHaveLength(1);
    expect(diagnosticInserts[0].metadata.applied).toBe(false);
  });

  it('swallows applyDeltaCommit failures so the IIFE does not crash the runtime', async () => {
    // Recovery-of-recovery: the IIFE lives inside ctx.waitUntil. A throw
    // would surface as an unhandled-rejection. The helper wraps in
    // try/catch + console.error.
    const sql = (() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn: any = () => Promise.reject(new Error('simulated neon outage'));
      return fn as NeonQueryFunction<false, false>;
    })();
    const { ctx, scheduled } = makeCtxStub();
    const deps = makeDeps(sql, ctx);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    fireAbortCommit(deps, 250_000n);
    await expect(Promise.all(scheduled)).resolves.toBeDefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
