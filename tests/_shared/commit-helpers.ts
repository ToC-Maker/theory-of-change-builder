// Shared test helpers for `firePerUpdateCommit` / `fireAbortCommit` test
// suites (`tests/worker/per-update-write-e2e.test.ts`,
// `tests/worker/abort-commit.test.ts`). Both files drive the same two
// helpers from `worker/api/anthropic-stream.ts` and rely on identical
// scaffolding:
//
//   - `makeCtxStub`: an `ExecutionContext` stand-in whose `waitUntil`
//     pushes each scheduled promise into an array so the test can
//     `await Promise.all(tracker)` before asserting. The real Workers
//     runtime fires waitUntil after handler return; here we make the
//     scheduling observable.
//
//   - `makeDeps`: builds the minimal `PerUpdateCommitDeps`-shaped object
//     both helpers accept. The production helpers take a `SseTeeContext`
//     in real code, but they only read the subset we model here; the
//     deps interface is exported precisely so unit tests don't have to
//     reach into the private `SseTeeContext` shape.
//
// Living in `tests/_shared/` (rather than duplicated in each test file)
// keeps the contract pinned to one place. If `PerUpdateCommitDeps`
// changes, this file is the single failure site instead of two.
import type { NeonQueryFunction } from '@neondatabase/serverless';

/** ExecutionContext stub. `scheduled` carries every promise passed to
 *  waitUntil — the test awaits them before asserting. */
export function makeCtxStub(): {
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

/** Minimal deps object accepted by `firePerUpdateCommit` and
 *  `fireAbortCommit`. Matches the exported `PerUpdateCommitDeps`
 *  interface in `worker/api/anthropic-stream.ts` (kept structural so
 *  this file doesn't need to import the worker module). */
export function makeDeps(
  sql: NeonQueryFunction<false, false>,
  ctx: { waitUntil(p: Promise<unknown>): void },
  overrides: Partial<{
    loggingMessageId: string | null;
    actorId: string;
    projectedMicroUsd: bigint;
    chartId: string | null;
    deploymentHost: string;
    handlerStartedAtMs: number;
    isByok: boolean;
  }> = {},
) {
  // `in` discrimination preserves `null` on the loggingMessageId and
  // chartId fields (vs `??` which would clobber it). Some tests need
  // `loggingMessageId: null` / `chartId: null` to exercise the early-
  // bail / no-chart branches; the defaults for unset are
  // `'msg_x'` / `'chart_x'`.
  return {
    sql,
    ctx,
    loggingMessageId: 'loggingMessageId' in overrides ? overrides.loggingMessageId! : 'msg_x',
    actorId: overrides.actorId ?? 'auth0|alice',
    projectedMicroUsd: overrides.projectedMicroUsd ?? 100_000n,
    chartId: 'chartId' in overrides ? overrides.chartId! : 'chart_x',
    deploymentHost: overrides.deploymentHost ?? 'preview.example.com',
    lifecycle: { handlerStartedAtMs: overrides.handlerStartedAtMs ?? 1_000_000 },
    isByok: overrides.isByok ?? false,
  };
}
