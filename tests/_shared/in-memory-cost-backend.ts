// Shared in-memory simulation backend for `applyDeltaCommit`
// (`worker/_shared/cost-commit.ts`).
//
// CAVEAT: This is a *simulation* not a real Postgres test. It mirrors the
// CTE algebra in `applyDeltaCommit` step-by-step, plus a per-message JS
// mutex that stands in for the row-level `SELECT ... FOR UPDATE` lock.
// The mutex gives the same single-writer guarantee per `message_id` at
// the JS level; it does NOT exercise the real lock-acquisition / blocking
// path. See the longer scope note in
// `tests/worker/delta-commit-concurrency.test.ts` for the gap analysis.
//
// WIRE-SHAPE MIRROR: the simulation's success branch returns `new_settled`
// and `delta` as **strings**, mirroring Neon's actual driver contract
// (numerics arrive as `bigint | number | string | null`). The production
// helper coerces via `toBigInt()`; returning bare bigint here would let a
// future refactor that drops `toBigInt` silently pass these tests while
// breaking prod. Stringifying pins the coercion path in the algebra mirror.
//
// CONTRACT: this file is the single source of truth for the CTE algebra
// mirror. When `worker/_shared/cost-commit.ts` evolves, this file must
// be updated in lockstep. The following test files import the mirror
// and assert against it; if they drift apart from the production CTE,
// review #2 (test simulation duplication) re-opens:
//
//   - tests/worker/delta-commit-concurrency.test.ts
//   - tests/worker/iife-death-recovery.test.ts
//   - tests/worker/per-update-write-e2e.test.ts
//   - tests/worker/abort-commit.test.ts
//   - tests/worker/reconcile-cost-delta-commit.test.ts
//
// Two of those (`iife-death-recovery`, `reconcile-cost-delta-commit`) also
// keep file-local helpers (the reconcile-CTE JS mirror, and the
// `endpointCall`/`capturedValues` fixtures) — those are reconcile-specific
// or assertion-specific, NOT shared algebra, and intentionally stay in
// their respective test files.
import type { NeonQueryFunction } from '@neondatabase/serverless';

// In-memory row matching the columns `applyDeltaCommit` touches.
export type LoggingMessageRow = {
  message_id: string;
  user_id: string;
  cost_micro_usd: bigint;
  cost_settled_micro_usd: bigint;
  reconciled_at: Date | null;
};

// Base shape for `user_api_usage` — the cost column is required by the
// helper's CTE. `byok_cost_micro_usd` was added by the BYOK regression
// fix (2026-05-17) to split the routing into two columns. It's *optional*
// at the input boundary so existing tests don't have to add `0n` everywhere;
// `makeBackend` defaults it to 0n and the on-state representation always
// has it set. Tests that also exercise token-counter writes (currently
// only `iife-death-recovery.test.ts`'s reconcile-CTE mirror) extend this
// via the `TUserUsage` generic on `makeBackend`.
export type UserApiUsageRow = {
  user_id: string;
  cost_micro_usd: bigint;
  byok_cost_micro_usd?: bigint;
};

// Shape captured from `writeDiagnostic` INSERTs into `logging_errors`.
// Only the two tests that exercise diagnostic writes
// (`per-update-write-e2e`, `abort-commit`) read this; the others ignore
// the captured-list (it stays empty when the helper-under-test doesn't
// trigger diagnostic writes).
export type DiagnosticInsert = {
  error_name: string;
  metadata: Record<string, unknown>;
};

export type Backend<TUserUsage extends UserApiUsageRow = UserApiUsageRow> = {
  sql: NeonQueryFunction<false, false>;
  state: { message: LoggingMessageRow | null; user_usage: TUserUsage };
  diagnosticInserts: DiagnosticInsert[];
  /** Number of sql-tag calls invoked against this backend (includes both
   *  applyDeltaCommit CTEs and diagnostic INSERTs). */
  callCount: () => number;
  /** The raw `values` array captured from each sql-tag invocation, in
   *  call order. Used by `reconcile-cost-delta-commit.test.ts` to pin
   *  the exact leading-argument shape the endpoint passes. */
  capturedValues: () => unknown[][];
};

/**
 * Build an in-memory backend modelling the two rows
 * `applyDeltaCommit` touches plus a diagnostic-INSERT capture list.
 *
 * The returned `sql` is a tagged-template stub that:
 *
 *   - Sniffs the joined template string for the substring
 *     `logging_errors`. When present, captures the diagnostic INSERT
 *     row (parsing the `request_metadata` JSON column) into
 *     `diagnosticInserts` and resolves with `[]`. This branch only
 *     fires when the helper-under-test writes a diagnostic; tests that
 *     don't exercise that path leave `diagnosticInserts` empty.
 *
 *   - Sniffs for the post-applyDeltaCommit polling SELECT used by
 *     `worker/api/reconcile-cost.ts` (recognized by the literal
 *     `SELECT cost_settled_micro_usd` + `(reconciled_at IS NOT NULL)`
 *     + `FROM logging_messages` tokens together). Returns
 *     `[{cost_settled_micro_usd: string, reconciled: boolean}]` on
 *     `(message_id, user_id)` match, `[]` otherwise. Read-only
 *     branch — no mutex; the JS event loop already serialises against
 *     any preceding applyDeltaCommit on the same backend. Used by
 *     `reconcile-cost-delta-commit.test.ts`'s `endpointCallFull` helper.
 *
 *   - Otherwise treats the call as an `applyDeltaCommit` CTE: looks up
 *     the locking row by `(message_id, user_id, reconciled_at IS NULL)`
 *     and either returns the CTE-empty shape (`applied=false`,
 *     `new_settled=null`, `delta=null`) or computes the CTE algebra:
 *
 *       baseline    = max(projected, cost_settled_micro_usd)
 *       delta       = max(0, newCost - baseline)
 *       new_settled = max(cost_settled_micro_usd, newCost)
 *       new_hwm     = max(cost_micro_usd, newCost)
 *
 *     and applies the writes atomically under a per-`message_id` JS
 *     mutex that mirrors the real `FOR UPDATE` row-level lock's
 *     serialisation contract.
 *
 * @param initial — initial state for the row pair. `message: null` is
 *   supported for tests that exercise the row-missing path
 *   (`per-update-write-e2e.test.ts`, `abort-commit.test.ts`). The
 *   returned `state.message` is always typed `LoggingMessageRow | null`;
 *   callers that pass a non-null `LoggingMessageRow` and want to
 *   dereference without optional chaining should narrow locally (see
 *   `iife-death-recovery.test.ts` for the wrapper pattern) or use `?.`
 *   per the convention in `delta-commit-concurrency.test.ts`.
 */
export function makeBackend<TUserUsage extends UserApiUsageRow = UserApiUsageRow>(initial: {
  message: LoggingMessageRow | null;
  user_usage: TUserUsage;
}): Backend<TUserUsage> {
  const state: { message: LoggingMessageRow | null; user_usage: TUserUsage } = {
    message: initial.message ? { ...initial.message } : null,
    // Default byok_cost_micro_usd to 0n if the input omits it (it's
    // optional on UserApiUsageRow). Keeps existing free-tier tests
    // unchanged — they pass `{user_id, cost_micro_usd}` without the
    // BYOK column, and the backend's on-state representation always
    // has it set.
    user_usage: { byok_cost_micro_usd: 0n, ...initial.user_usage },
  };
  const diagnosticInserts: DiagnosticInsert[] = [];
  const capturedValues: unknown[][] = [];

  // Per-(message_id) mutex: a chain of resolved promises that serialises
  // critical sections. Postgres row locks are per-row; here we pin per
  // message_id (the helper's lookup key) which matches.
  const mutexes = new Map<string, Promise<void>>();
  function withRowLock<T>(messageId: string, critical: () => Promise<T>): Promise<T> {
    const prev = mutexes.get(messageId) ?? Promise.resolve();
    const next = prev.then(critical);
    // Don't reject the chain on individual section failure — store a
    // resolved version so subsequent waiters proceed. A failed section
    // would still throw to its own caller via the `next` return.
    mutexes.set(
      messageId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    capturedValues.push(values);
    const joined = strings.join('');
    if (joined.includes('logging_errors')) {
      // writeDiagnostic shape: values[0]=error_id, [1]=error_name,
      // [2]=error_message, [3]=user_id, [4]=chart_id, [5]=http_status,
      // [6]=JSON-encoded request_metadata
      const error_name = String(values[1]);
      const metadataRaw = String(values[6]);
      const metadata = JSON.parse(metadataRaw) as Record<string, unknown>;
      diagnosticInserts.push({ error_name, metadata });
      return Promise.resolve([]);
    }
    // Polling-friendly SELECT used by `worker/api/reconcile-cost.ts`
    // after `applyDeltaCommit`. The handler reads the current row state
    // (regardless of whether the helper mutated) so the client can poll
    // until `reconciled:true`. Recognized by the literal column tokens —
    // distinct from the CTE which references `cost_settled_micro_usd`
    // inside `UPDATE` / `RETURNING` clauses but not in a top-level
    // `SELECT` projection. The string-projection check (`/^\s*SELECT\b/`-like)
    // disambiguates against the CTE's interior SELECTs.
    //
    // Read-only branch: no mutex needed. The JS event loop already
    // serialises the SELECT against any preceding applyDeltaCommit on
    // the same backend (await chain in `endpointCallFull` / handler).
    if (
      joined.includes('SELECT cost_settled_micro_usd') &&
      joined.includes('(reconciled_at IS NOT NULL)') &&
      joined.includes('FROM logging_messages')
    ) {
      const messageId = String(values[0]);
      const userId = String(values[1]);
      const row = state.message;
      // Mirror the production WHERE clause: `message_id = $ AND user_id = $`.
      // No `reconciled_at IS NULL` here — the SELECT must surface the
      // post-IIFE settled value even on reconciled rows (that's the
      // whole point of adding it to the response).
      const matches = row && row.message_id === messageId && row.user_id === userId;
      if (!matches || !row) {
        return Promise.resolve([]);
      }
      return Promise.resolve([
        {
          // Stringify the bigint to mirror Neon's actual wire contract
          // (numerics arrive as `bigint | number | string | null`).
          // The production handler coerces via `toBigInt()` regardless.
          cost_settled_micro_usd: row.cost_settled_micro_usd.toString(),
          reconciled: row.reconciled_at !== null,
        },
      ]);
    }
    // applyDeltaCommit CTE: the helper interpolates messageId, userId,
    // projected (string), newCost (string), and isByok (boolean) — the
    // CTE references them in the WHERE / UPDATE / CASE clauses, so the
    // captured `values` array has repeated occurrences. We extract the
    // distinct values by name: messageId/userId/projected/newCost are
    // strings; isByok is the only boolean and appears once per CASE arm.
    const messageId = String(values[0]);
    const userId = String(values[1]);
    const projected = BigInt(String(values[2]));
    const newCost = BigInt(String(values[3]));
    // isByok is interpolated as a JS boolean; `Boolean(v) === v` only when
    // v is already true/false. Find the first such value (the CASE
    // expressions interpolate it twice). Default to `false` if absent —
    // pre-fix tests that don't pass isByok still work.
    const isByok = values.find((v) => typeof v === 'boolean') === true;

    return withRowLock(messageId, async () => {
      // Yield a microtask so concurrent callers race for the lock as
      // they would in a real network round-trip. Without this, a
      // synchronous critical section would always observe initial
      // state and the serialisation invariant wouldn't be exercised.
      await Promise.resolve();
      const row = state.message;
      const matches =
        row && row.message_id === messageId && row.user_id === userId && row.reconciled_at === null;
      if (!matches || !row) {
        // CTE-empty shape: no rows matched the WHERE, so msg_upd
        // RETURNING produced zero rows and EXISTS evaluates to false.
        return [{ new_settled: null, delta: null, applied: false }];
      }
      const baseline =
        projected > row.cost_settled_micro_usd ? projected : row.cost_settled_micro_usd;
      const computedDelta = newCost > baseline ? newCost - baseline : 0n;
      const newSettled =
        newCost > row.cost_settled_micro_usd ? newCost : row.cost_settled_micro_usd;
      const newCostHwm = newCost > row.cost_micro_usd ? newCost : row.cost_micro_usd;
      // Apply both writes atomically (the real CTE does this via the
      // composite SQL statement; here we do it under the mutex).
      state.message = {
        ...row,
        cost_micro_usd: newCostHwm,
        cost_settled_micro_usd: newSettled,
      };
      if (computedDelta > 0n) {
        // Route the delta into cost_micro_usd or byok_cost_micro_usd based
        // on `isByok`, mirroring the production CTE's CASE-WHEN arms. The
        // *other* column stays unchanged (the CASE arm contributes 0).
        // `?? 0n` lets the optional `byok_cost_micro_usd` default to 0n
        // for tests that don't initialize it. The state-init constructor
        // already defaults it, so this is belt-and-braces (and silences
        // any "object is possibly undefined" check from a strict
        // typechecker).
        const currentByok = state.user_usage.byok_cost_micro_usd ?? 0n;
        state.user_usage = {
          ...state.user_usage,
          cost_micro_usd: isByok
            ? state.user_usage.cost_micro_usd
            : state.user_usage.cost_micro_usd + computedDelta,
          byok_cost_micro_usd: isByok ? currentByok + computedDelta : currentByok,
        };
      }
      // Stringify the bigint fields to mirror Neon's actual wire contract.
      // The real Neon driver returns numerics as `bigint | number | string |
      // null`, never raw bigint — `worker/_shared/cost-commit.ts` coerces via
      // `toBigInt()` for that reason. Returning bare bigint here would let a
      // future refactor that drops `toBigInt` silently pass tests while
      // breaking prod (cost-commit would suddenly see a string and throw).
      // Stringifying pins the coercion path in the tests' algebra mirror.
      return [
        {
          new_settled: newSettled.toString(),
          delta: computedDelta.toString(),
          applied: true,
        },
      ];
    });
  };

  return {
    sql: sql as NeonQueryFunction<false, false>,
    state: state as { message: LoggingMessageRow | null; user_usage: TUserUsage },
    diagnosticInserts,
    callCount: () => capturedValues.length,
    capturedValues: () => capturedValues,
  };
}
