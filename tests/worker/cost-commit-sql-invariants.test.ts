// Structural pin test for the `applyDeltaCommit` CTE in
// `worker/_shared/cost-commit.ts`.
//
// SCOPE NOTE — read this before adding cases:
//
// `applyDeltaCommit` has TWO sibling tests covering its semantics:
//
//   - `tests/worker/delta-commit.test.ts` mocks the Neon tagged-template
//     and exercises the helper's input → output mapping (no-op fast-paths,
//     row-not-found, delta clamping, etc.). It pins the BEHAVIOUR of the
//     helper against canned rows.
//   - `tests/worker/delta-commit-concurrency.test.ts` reimplements the
//     CTE's algebra in TypeScript and runs a concurrent-writer simulation
//     to verify convergence. It pins the MEANING of the CTE algebra —
//     "what the SQL would do, if you trust Postgres lock semantics".
//
// Neither sibling pins the SQL STRING SHAPE. A refactor that, e.g.,
// split the CTE into two statements (`WITH locked AS (...) SELECT ...`
// followed by separate `UPDATE`s) would silently pass both — the mocks
// just observe `applied/delta/new_settled` shape, and the simulation
// re-implements the math. But the SQL change would break in production:
//
//   - `SELECT ... FOR UPDATE` releases its row-level exclusive lock at
//     statement end. Splitting the CTE into multiple round-trips
//     dissolves the lock between SELECT and UPDATE, so two concurrent
//     writers against the same `message_id` would both read the same
//     stale `cost_settled_micro_usd`, both compute deltas against it, and
//     both credit `user_api_usage` — double-counting. The simulation
//     can't catch this because it doesn't model statement boundaries.
//   - Likewise, sliding the `AND reconciled_at IS NULL` predicate out of
//     either the SELECT or the UPDATE (e.g. moving it to a TS-side `if`)
//     would break the late-retry lock against /api/reconcile-cost.
//
// This file plugs the gap. It reads `cost-commit.ts` via Vite's `?raw`
// import and asserts the single-statement + lock + GREATEST + ownership
// + CASE-WHEN landmarks the production SQL relies on. Together the
// three files catch both algebra-preserving SQL rewrites AND landmark-
// preserving algebra changes.
//
// Why not full-string equality? Whitespace and reformatting would create
// churn. Each landmark is a minimal, semantically-meaningful fragment.
// Add landmarks if a regression survives the current set; do NOT replace
// with a snapshot test.
//
// TDD verification (recorded 2026-05-17):
//
// Each landmark was confirmed to fail loudly when the corresponding
// production-side invariant was temporarily mutated. Specific
// verifications (revert all before committing):
//
//   - Removing `FOR UPDATE` from the locked CTE failed the "locks the
//     row" assertion.
//   - Removing `AND reconciled_at IS NULL` from the msg_upd UPDATE
//     failed the "late-retry lock baked into both" assertion (count
//     drops from 2 to 1).
//   - Swapping `GREATEST(cost_micro_usd, …)` for plain `=` in the
//     msg_upd UPDATE failed the "monotone cost_micro_usd" assertion.
//   - Swapping the CASE-WHEN arms on `byok_cost_micro_usd` failed the
//     "byok arm routes signed_delta when isByok=true" assertion.
//   - Splitting the CTE into two `sql\`` invocations failed the
//     "single tagged-template call" assertion.
//
// All five mutations were reverted before commit; the test file in its
// current form passes against the current production source.
import { describe, expect, it } from 'vitest';
// @ts-expect-error - Vite/vitest resolve `?raw` at build time to a string.
// The worker tsconfig does not include `vite/client` types (which declares
// `*?raw`), so TypeScript can't see the module declaration. Suppressing the
// import error is the established trade-off — see
// `tests/worker/reconcile-sql-invariants.test.ts` for the same pattern.
import costCommitSource from '../../worker/_shared/cost-commit.ts?raw';

// Locate the applyDeltaCommit function body. The function declaration
// landmark `export async function applyDeltaCommit(` appears exactly
// once in `cost-commit.ts`. We slice from there to the next top-level
// closing brace — finding it by locating the trailing `}` after the
// final `RETURNING cost_micro_usd` (the user_upd RETURNING clause is
// unique to this function), then walking forward to the function's
// outer brace. In practice, the unique `(SELECT delta FROM computed) AS delta`
// landmark inside the final SELECT block is a robust terminator —
// nothing else in the source uses that exact fragment.
function extractApplyDeltaCommit(): string {
  const source = costCommitSource as string;
  const start = source.indexOf('export async function applyDeltaCommit(');
  if (start === -1) {
    throw new Error(
      'Landmark "export async function applyDeltaCommit(" not found in ' +
        'cost-commit.ts. The function has been renamed, moved, or removed. ' +
        'Update the landmark or this file.',
    );
  }
  // Terminator landmark: `EXISTS(SELECT 1 FROM msg_upd) AS applied` is
  // the last line of the final SELECT (before the closing backtick).
  // This fragment is unique to applyDeltaCommit and stable across
  // reformatting; using it as the terminator ensures the slice covers
  // the FULL CTE including every RETURNING / aggregate clause the
  // assertions below match against.
  const tailNeedle = 'EXISTS(SELECT 1 FROM msg_upd) AS applied';
  const tail = source.indexOf(tailNeedle, start);
  if (tail === -1) {
    throw new Error(
      'Tail landmark "EXISTS(SELECT 1 FROM msg_upd) AS applied" not found ' +
        'after applyDeltaCommit declaration. The final SELECT has been ' +
        'restructured. Update the terminator landmark.',
    );
  }
  return source.slice(start, tail + tailNeedle.length);
}

describe('applyDeltaCommit SQL structural invariants — pins production CTE shape', () => {
  it('extracts a non-empty applyDeltaCommit slice from the production source', () => {
    const body = extractApplyDeltaCommit();
    expect(body.length).toBeGreaterThan(400);
    expect(body).toMatch(/^export async function applyDeltaCommit\(/);
  });

  // -------------------------------------------------------------------------
  // Single-statement invariant. The function's atomicity (and the
  // `FOR UPDATE` row-lock duration) hinges on the entire CTE being a
  // SINGLE tagged-template invocation. Splitting it into two `sql\`...\``
  // calls would dissolve the lock between statements — Neon HTTP does
  // not span statements with locks, so two concurrent writers could
  // double-credit `user_api_usage`. See the JSDoc on `applyDeltaCommit`
  // and the SCOPE NOTE at the top of this file.
  // -------------------------------------------------------------------------
  it('issues exactly one tagged-template SQL invocation', () => {
    const body = extractApplyDeltaCommit();
    // Match the Neon tagged-template form `await sql\`` (with optional
    // whitespace between `sql` and the backtick). Any additional matches
    // would indicate the CTE was split into multiple round-trips.
    const taggedTemplateCount = (body.match(/\bsql`/g) ?? []).length;
    expect(taggedTemplateCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Lock semantics. The `SELECT ... FOR UPDATE` inside the locked CTE
  // acquires a row-level exclusive lock for the duration of the
  // statement. Dropping `FOR UPDATE` permits two concurrent writers to
  // race past the SELECT, both compute deltas against the same stale
  // `cost_settled_micro_usd`, and both credit `user_api_usage` (the
  // double-counting failure mode pinned in the sibling concurrency
  // simulation's algebra). The lock is meaningless if it isn't there.
  // -------------------------------------------------------------------------
  it('acquires a SELECT ... FOR UPDATE row-level lock in the locked CTE', () => {
    const body = extractApplyDeltaCommit();
    expect(body).toContain('FOR UPDATE');
    expect(body).toMatch(/WITH locked AS \(/);
  });

  // -------------------------------------------------------------------------
  // Late-retry lock: `reconciled_at IS NULL` must be in BOTH the locked
  // SELECT and the msg_upd UPDATE. Reasoning:
  //
  //   - The locked SELECT's `reconciled_at IS NULL` filter is the
  //     fast-path bail (returns an empty CTE row, which the helper
  //     translates into `{applied: false}`).
  //   - The msg_upd UPDATE's `reconciled_at IS NULL` is the actual
  //     write-side guard. Without it, a row that just got reconciled
  //     by /api/reconcile-cost could still be updated by a racing
  //     in-stream commit — the SELECT FOR UPDATE in the same statement
  //     would catch it, but only if the predicate is on both sides.
  //
  // Dropping either copy collapses the lock against late-retry races.
  // -------------------------------------------------------------------------
  it('filters on reconciled_at IS NULL in BOTH the locked SELECT and the msg_upd UPDATE', () => {
    const body = extractApplyDeltaCommit();
    const reconciledNullCount = (body.match(/reconciled_at IS NULL/g) ?? []).length;
    expect(reconciledNullCount).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Ownership pin: the `AND user_id = ${userId}` filter must also be in
  // BOTH the locked SELECT and the msg_upd UPDATE. Baking ownership
  // into the SQL (rather than relying on a JS-side `if (row.user_id ===
  // userId)`) is the IDOR guard — even if a logged-in user crafts a
  // request with a stolen message_id, the row UPDATE refuses to match.
  // The msg_upd UPDATE's ownership filter is independent of the locked
  // SELECT's (Postgres won't carry the predicate forward); dropping
  // either copy opens an IDOR vector.
  // -------------------------------------------------------------------------
  it('bakes ownership (AND user_id = …) into BOTH the locked SELECT and the msg_upd UPDATE', () => {
    const body = extractApplyDeltaCommit();
    const userIdFilterCount = (body.match(/AND user_id = \$\{userId\}/g) ?? []).length;
    expect(userIdFilterCount).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Baseline algebra: `GREATEST(projStr::bigint, cost_settled_micro_usd)`.
  // This is "the higher of the reservation projection and any earlier
  // in-stream settlement" — the floor below which a delta cannot count
  // as new spend. Replacing it with `cost_settled_micro_usd` alone (no
  // GREATEST) would let a stream that arrives mid-reservation
  // double-credit the projection; replacing with `projStr` alone would
  // discard earlier per-update settlements.
  // -------------------------------------------------------------------------
  it('uses GREATEST(projStr, cost_settled_micro_usd) as the baseline in the baseline CTE', () => {
    const body = extractApplyDeltaCommit();
    expect(body).toMatch(/baseline AS \(/);
    expect(body).toMatch(
      /GREATEST\(\s*\$\{projStr\}::bigint\s*,\s*cost_settled_micro_usd\s*\)\s*AS bl FROM locked/,
    );
  });

  // -------------------------------------------------------------------------
  // Non-negative delta clamp: `GREATEST(0::bigint, newCost - baseline)`.
  // This helper NEVER decreases `user_api_usage` (refunds flow through
  // the separate `/api/reconcile-cost` signed-delta path — see the
  // sibling `reconcile-sql-invariants.test.ts`). Dropping the
  // `GREATEST(0, …)` clamp here would silently let an in-stream commit
  // with `newCost < baseline` push the user's running spend NEGATIVE
  // (or, more subtly, decrement on a high-water mark that should be
  // sticky), corrupting the cap-check semantics in `reserveCost`.
  // -------------------------------------------------------------------------
  it('clamps the computed delta to non-negative via GREATEST(0::bigint, …) in the computed CTE', () => {
    const body = extractApplyDeltaCommit();
    expect(body).toMatch(/computed AS \(/);
    expect(body).toMatch(
      /GREATEST\(\s*0::bigint\s*,\s*\$\{newStr\}::bigint\s*-\s*\(SELECT bl FROM baseline\)\s*\)\s*AS delta/,
    );
  });

  // -------------------------------------------------------------------------
  // High-water-mark (HWM) monotonicity on `logging_messages.cost_micro_usd`
  // AND `cost_settled_micro_usd`. Both columns must be wrapped in
  // `GREATEST(<col>, newStr::bigint)` so that a slow / out-of-order
  // commit cannot regress an already-settled row. Plain `=` (without
  // GREATEST) would let a stale callback overwrite the truth with a
  // lower value.
  // -------------------------------------------------------------------------
  it('updates BOTH cost_micro_usd and cost_settled_micro_usd with GREATEST(…) in msg_upd', () => {
    const body = extractApplyDeltaCommit();
    expect(body).toMatch(/msg_upd AS \(/);
    expect(body).toMatch(/UPDATE logging_messages/);
    expect(body).toMatch(/cost_micro_usd = GREATEST\(cost_micro_usd,\s*\$\{newStr\}::bigint\)/);
    expect(body).toMatch(
      /cost_settled_micro_usd = GREATEST\(cost_settled_micro_usd,\s*\$\{newStr\}::bigint\)/,
    );
    expect(body).toMatch(/RETURNING cost_settled_micro_usd AS new_settled/);
  });

  // -------------------------------------------------------------------------
  // BYOK routing (split-column fix, 2026-05-17): the delta lands in
  // exactly one of `cost_micro_usd` (free cap, applies when `isByok=false`)
  // or `byok_cost_micro_usd` (BYOK, applies when `isByok=true`). The two
  // CASE-WHEN arms must be mirror images:
  //
  //   free arm: ... THEN 0::bigint ELSE (SELECT delta FROM computed) END
  //   byok arm: ... THEN (SELECT delta FROM computed) ELSE 0::bigint END
  //
  // A regression that swapped the THEN/ELSE on either column would
  // silently couple BYOK spend back into the free cap (the original
  // Critical bug from PR #23 review). Both arms are pinned independently
  // so the test catches a one-sided swap.
  // -------------------------------------------------------------------------
  it('routes the delta via CASE WHEN isByok to exactly one of the two user_api_usage cost columns', () => {
    const body = extractApplyDeltaCommit();
    expect(body).toMatch(/user_upd AS \(/);
    expect(body).toMatch(/UPDATE user_api_usage/);
    // Free arm: free-tier writes signed delta to cost_micro_usd;
    // BYOK contributes 0.
    expect(body).toMatch(
      /cost_micro_usd = cost_micro_usd \+ CASE WHEN \$\{isByok\}::bool THEN 0::bigint ELSE \(SELECT delta FROM computed\) END/,
    );
    // BYOK arm: BYOK writes signed delta to byok_cost_micro_usd;
    // free-tier contributes 0.
    expect(body).toMatch(
      /byok_cost_micro_usd = byok_cost_micro_usd \+ CASE WHEN \$\{isByok\}::bool THEN \(SELECT delta FROM computed\) ELSE 0::bigint END/,
    );
  });

  // -------------------------------------------------------------------------
  // No-op gate on user_upd: `(SELECT delta FROM computed) > 0`. When
  // the delta clamps to zero (newCost ≤ baseline), the user_api_usage
  // UPDATE must skip entirely — not even touch the row. This pairs
  // with the GREATEST(0, …) clamp in the computed CTE; dropping the
  // `> 0` predicate would cause every commit to issue an UPDATE that
  // adds zero, which is wasteful but more importantly would record a
  // `RETURNING` row even when nothing changed.
  // -------------------------------------------------------------------------
  it('gates the user_api_usage UPDATE on (SELECT delta FROM computed) > 0', () => {
    const body = extractApplyDeltaCommit();
    expect(body).toMatch(/WHERE user_id = \$\{userId\} AND \(SELECT delta FROM computed\) > 0/);
  });

  // -------------------------------------------------------------------------
  // Final SELECT shape: returns `new_settled`, `delta`, `applied`. The
  // `applied` field is derived from `EXISTS(SELECT 1 FROM msg_upd)` —
  // i.e. "did the msg_upd UPDATE match a row?". This is the helper's
  // signal back to callers that the row exists, is owned by the user,
  // and hasn't been reconciled yet. Replacing the EXISTS guard with a
  // hardcoded `true` would mask all three no-op conditions.
  // -------------------------------------------------------------------------
  it('exposes applied = EXISTS(SELECT 1 FROM msg_upd) in the final SELECT', () => {
    const body = extractApplyDeltaCommit();
    expect(body).toContain('EXISTS(SELECT 1 FROM msg_upd) AS applied');
    expect(body).toMatch(/\(SELECT new_settled FROM msg_upd\) AS new_settled/);
  });
});
