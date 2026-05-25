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
// TDD verification (recorded 2026-05-17, updated 2026-05-25 for the
// FOR UPDATE → UPDATE..FROM pattern fix):
//
// Each landmark was confirmed to fail loudly when the corresponding
// production-side invariant was temporarily mutated. Specific
// verifications (revert all before committing):
//
//   - Dropping the `FOR NO KEY UPDATE` from the FROM subquery failed
//     the "locks the row before computing OLD" assertion (concurrent
//     writers could read stale old_cs and double-credit).
//   - Removing `AND reconciled_at IS NULL` from the msg_upd UPDATE
//     failed the "late-retry lock baked into both" assertion (count
//     drops from 2 to 1).
//   - Swapping `GREATEST(m.cost_micro_usd, …)` for plain `=` failed
//     the "monotone cost_micro_usd" assertion.
//   - Swapping the CASE-WHEN arms on `byok_cost_micro_usd` failed the
//     "byok arm routes delta when isByok=true" assertion.
//   - Splitting the CTE into two `sql\`` invocations failed the
//     "single tagged-template call" assertion.
//
// All five mutations were reverted before commit; the test file in its
// current form passes against the current production source.
//
// SHAPE NOTE: this file was updated 2026-05-25 to pin the new
// `UPDATE m FROM (SELECT ... FOR NO KEY UPDATE) AS old` pattern. The
// previous shape used a `locked AS (SELECT FOR UPDATE)` sibling CTE,
// which silently returned zero rows on PG 17 due to the LockRows
// EvalPlanQual quirk with same-statement UPDATEs. See cost-commit.ts
// inline comment for the PG-quirk diagnosis.
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
  // Lock semantics (UPDATE..FROM pattern, 2026-05-25 PG-quirk fix).
  // The `SELECT cost_settled_micro_usd ... FOR NO KEY UPDATE` lives
  // inside the UPDATE's FROM subquery — NOT in a sibling `locked` CTE
  // (which on PG 17 causes LockRows to silently filter the row via
  // EvalPlanQual against the same-statement msg_upd UPDATE). The lock
  // strength is FOR NO KEY UPDATE (matches what UPDATE takes
  // implicitly so there's no upgrade-then-recheck conflict). Dropping
  // the lock permits two concurrent writers to both read stale
  // `old_cs` and double-credit. The subquery also names its captured
  // column `AS old_cs` so RETURNING can reference it.
  // -------------------------------------------------------------------------
  it('acquires FOR NO KEY UPDATE on cost_settled_micro_usd in the FROM subquery', () => {
    const body = extractApplyDeltaCommit();
    expect(body).toMatch(/FROM \(/);
    expect(body).toMatch(/SELECT cost_settled_micro_usd AS old_cs\s+FROM logging_messages/);
    expect(body).toContain('FOR NO KEY UPDATE');
  });

  // -------------------------------------------------------------------------
  // Late-retry lock: `reconciled_at IS NULL` must be in BOTH the FROM
  // subquery (lock-side) and the msg_upd UPDATE (write-side guard).
  // Reasoning:
  //
  //   - The FROM subquery's `reconciled_at IS NULL` filter is the
  //     fast-path bail (returns an empty row, which makes the outer
  //     UPDATE match zero rows, which makes the helper translate to
  //     `{applied: false}`).
  //   - The msg_upd UPDATE's `reconciled_at IS NULL` is the actual
  //     write-side guard. Without it, a row that just got reconciled
  //     by /api/reconcile-cost could still be updated by a racing
  //     in-stream commit.
  //
  // Dropping either copy collapses the lock against late-retry races.
  // -------------------------------------------------------------------------
  it('filters on reconciled_at IS NULL in BOTH the FROM subquery and the msg_upd UPDATE', () => {
    const body = extractApplyDeltaCommit();
    const reconciledNullCount = (body.match(/reconciled_at IS NULL/g) ?? []).length;
    expect(reconciledNullCount).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Ownership pin: the `AND user_id = ${userId}` filter must be in
  // BOTH the FROM subquery and the msg_upd UPDATE. Baking ownership
  // into the SQL (rather than relying on a JS-side `if (row.user_id ===
  // userId)`) is the IDOR guard — even if a logged-in user crafts a
  // request with a stolen message_id, the row UPDATE refuses to match.
  // The msg_upd UPDATE's ownership filter is independent of the FROM
  // subquery's; dropping either copy opens an IDOR vector.
  // -------------------------------------------------------------------------
  it('bakes ownership (AND user_id = …) into BOTH the FROM subquery and the msg_upd UPDATE', () => {
    const body = extractApplyDeltaCommit();
    const userIdFilterCount = (body.match(/user_id = \$\{userId\}/g) ?? []).length;
    expect(userIdFilterCount).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Delta algebra (computed inline in RETURNING after the 2026-05-25
  // shape change). Two invariants compress into one expression:
  //
  //   - Baseline = GREATEST(projStr, old.old_cs) — "the higher of the
  //     reservation projection and any earlier in-stream settlement";
  //     the floor below which a delta cannot count as new spend.
  //   - Non-negative clamp via GREATEST(0::bigint, newStr - baseline)
  //     — this helper NEVER decreases user_api_usage (refunds flow
  //     through the separate /api/reconcile-cost signed-delta path).
  //
  // Both wrapped together in RETURNING's `AS delta` expression so the
  // user_upd CTE consumes a non-negative number that respects the
  // reservation floor. Dropping either GREATEST corrupts cap-check
  // semantics in `reserveCost`.
  // -------------------------------------------------------------------------
  it('computes delta = GREATEST(0, newStr - GREATEST(projStr, old.old_cs)) in RETURNING', () => {
    const body = extractApplyDeltaCommit();
    expect(body).toMatch(/RETURNING/);
    expect(body).toMatch(
      /GREATEST\(\s*0::bigint\s*,\s*\$\{newStr\}::bigint\s*-\s*GREATEST\(\s*\$\{projStr\}::bigint\s*,\s*old\.old_cs\s*\)\s*\)\s*AS delta/,
    );
  });

  // -------------------------------------------------------------------------
  // High-water-mark (HWM) monotonicity on `logging_messages.cost_micro_usd`
  // AND `cost_settled_micro_usd`. Both columns must be wrapped in
  // `GREATEST(m.<col>, newStr::bigint)` so that a slow / out-of-order
  // commit cannot regress an already-settled row. Plain `=` (without
  // GREATEST) would let a stale callback overwrite the truth with a
  // lower value. The `m.` alias prefix is mandatory in UPDATE..FROM
  // because both `logging_messages m` and the FROM subquery `old` are
  // in scope.
  // -------------------------------------------------------------------------
  it('updates BOTH cost_micro_usd and cost_settled_micro_usd with GREATEST(m.…) in msg_upd', () => {
    const body = extractApplyDeltaCommit();
    expect(body).toMatch(/msg_upd AS \(/);
    expect(body).toMatch(/UPDATE logging_messages m/);
    expect(body).toMatch(/cost_micro_usd = GREATEST\(m\.cost_micro_usd,\s*\$\{newStr\}::bigint\)/);
    expect(body).toMatch(
      /cost_settled_micro_usd = GREATEST\(m\.cost_settled_micro_usd,\s*\$\{newStr\}::bigint\)/,
    );
    expect(body).toMatch(/RETURNING\s+m\.cost_settled_micro_usd AS new_settled/);
  });

  // -------------------------------------------------------------------------
  // BYOK routing (split-column fix, 2026-05-17; CASE-WHEN now references
  // msg_upd.delta after the 2026-05-25 shape change): the delta lands
  // in exactly one of `cost_micro_usd` (free cap, when `isByok=false`)
  // or `byok_cost_micro_usd` (BYOK, when `isByok=true`). The two
  // CASE-WHEN arms must be mirror images:
  //
  //   free arm: ... THEN 0::bigint ELSE (SELECT delta FROM msg_upd) END
  //   byok arm: ... THEN (SELECT delta FROM msg_upd) ELSE 0::bigint END
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
    // Free arm: free-tier writes delta to cost_micro_usd; BYOK contributes 0.
    expect(body).toMatch(
      /cost_micro_usd = cost_micro_usd \+ CASE WHEN \$\{isByok\}::bool THEN 0::bigint ELSE \(SELECT delta FROM msg_upd\) END/,
    );
    // BYOK arm: BYOK writes delta to byok_cost_micro_usd; free-tier contributes 0.
    expect(body).toMatch(
      /byok_cost_micro_usd = byok_cost_micro_usd \+ CASE WHEN \$\{isByok\}::bool THEN \(SELECT delta FROM msg_upd\) ELSE 0::bigint END/,
    );
  });

  // -------------------------------------------------------------------------
  // No-op gate on user_upd: `(SELECT delta FROM msg_upd) > 0`. When
  // the delta clamps to zero (newCost ≤ baseline), the user_api_usage
  // UPDATE must skip entirely — not even touch the row. This pairs
  // with the GREATEST(0, …) clamp in the RETURNING expression;
  // dropping the `> 0` predicate would cause every commit to issue an
  // UPDATE that adds zero, which is wasteful but more importantly
  // would record a `RETURNING` row even when nothing changed.
  // -------------------------------------------------------------------------
  it('gates the user_api_usage UPDATE on (SELECT delta FROM msg_upd) > 0', () => {
    const body = extractApplyDeltaCommit();
    expect(body).toMatch(/WHERE user_id = \$\{userId\} AND \(SELECT delta FROM msg_upd\) > 0/);
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
