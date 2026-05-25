// Structural pin test for the post-stream reconcile SQL in
// `worker/api/anthropic-stream.ts`.
//
// SCOPE NOTE — read this before adding cases:
//
// `iife-death-recovery.test.ts` mirrors the reconcile CTE's algebra against
// an in-memory row pair. That test verifies *semantics* — what the SQL means
// when run against well-formed inputs. It does NOT pin the actual SQL string,
// because the test's reconcile helper is a hand-written JS implementation,
// not the live tagged-template invocation. A refactor that rewrites the SQL
// without changing the algebra (e.g. swaps `EXISTS(SELECT 1 FROM msg_upd)`
// for a join, drops `reconciled_at = NOW()`, or replaces
// `GREATEST(0::bigint, ...)` with a CASE) would slip past the simulation.
//
// This file plugs that gap by reading the production source via Vite's
// `?raw` import and asserting that the reconcile CTE — keyed off the unique
// `WITH msg_upd AS (` landmark inside the post-stream IIFE — contains every
// structural invariant the simulation relies on. The two together form a
// load-bearing contract:
//
//   - `iife-death-recovery.test.ts` pins MEANING (algebra under inputs).
//   - This file pins SHAPE (the SQL string literal contains each landmark).
//
// If you change the reconcile SQL, expect this file to fail loudly with a
// diff between the expected landmark and the actual production string. Fix
// the landmark list here AND update the simulation in
// `iife-death-recovery.test.ts` in the same commit. The two are intentionally
// coupled — silently divergent semantics is the failure mode we're guarding
// against.
//
// Why not assert against the entire CTE string? Whitespace and reformatting
// would create churn. Each landmark is a minimal, semantically-meaningful
// fragment — `signed_d`, `reconciled_at = NOW()`, the `EXISTS` guard.
// Add more landmarks if a regression survives the current set; do not
// substitute a full-string equality.
//
// SHAPE NOTE: this file was updated 2026-05-25 to pin the new
// `UPDATE m FROM (SELECT ... FOR NO KEY UPDATE) AS old` pattern. The
// previous shape used a `locked AS (SELECT ... FOR UPDATE)` sibling CTE,
// which on PG 17 caused LockRows to silently filter the row via
// EvalPlanQual against the same-statement msg_upd UPDATE — the signed
// delta evaluated to NULL, and the BYOK column was reset to 0 on every
// reconcile (latent because BYOK column was also broken from the same
// quirk in cost-commit.ts). See the inline note in anthropic-stream.ts
// for the diagnosis.
import { describe, expect, it } from 'vitest';
// @ts-expect-error - Vite/vitest resolve `?raw` at build time to a string.
// The worker tsconfig does not include `vite/client` types (which declares
// `*?raw`), so TypeScript can't see the module declaration. Suppressing the
// import error is the established trade-off — see `src/services/chatService.ts`
// for the same `?raw` pattern in production code.
import streamSource from '../../worker/api/anthropic-stream.ts?raw';

// Locate the reconcile CTE. The string `WITH msg_upd AS (` appears exactly
// once in `anthropic-stream.ts` — inside the post-stream reconcile block.
// The tail landmark `RETURNING cost_micro_usd, (SELECT signed_d FROM
// msg_upd) AS applied_signed_delta` is unique to the same statement and
// closes the slice.
function extractReconcileCte(): string {
  const source = streamSource as string;
  const start = source.indexOf('WITH msg_upd AS (');
  if (start === -1) {
    throw new Error(
      'Reconcile CTE start landmark "WITH msg_upd AS (" not found in ' +
        'anthropic-stream.ts. The reconcile SQL has been moved or rewritten. ' +
        'Update the landmark or this file.',
    );
  }
  const tailNeedle =
    'RETURNING cost_micro_usd, (SELECT signed_d FROM msg_upd) AS applied_signed_delta';
  const tail = source.indexOf(tailNeedle, start);
  if (tail === -1) {
    throw new Error(
      'Reconcile CTE tail landmark not found after "WITH msg_upd AS (". ' +
        'The reconcile SQL terminator has been changed. Update the landmark.',
    );
  }
  // Include the tail landmark in the returned slice so RETURNING-clause
  // invariants can be asserted by `toContain`.
  return source.slice(start, tail + tailNeedle.length);
}

describe('reconcile SQL structural invariants — pins production CTE shape', () => {
  // -------------------------------------------------------------------------
  // The reconcile CTE has these invariants, all load-bearing for the
  // algebra mirrored in `iife-death-recovery.test.ts`. Each entry below
  // names the property being pinned and what regression it catches.
  // -------------------------------------------------------------------------
  it('extracts a non-empty reconcile CTE slice from the production source', () => {
    const cte = extractReconcileCte();
    expect(cte.length).toBeGreaterThan(200);
    expect(cte).toMatch(/^WITH msg_upd AS \(/);
  });

  it('locks the row with FOR NO KEY UPDATE in the FROM subquery filtered by reconciled_at IS NULL', () => {
    // Lock semantics: row-level lock against concurrent writers + a guard
    // that prevents re-reconciling an already-settled row. The lock lives
    // in the UPDATE's FROM subquery (NOT a sibling locked CTE) per the
    // 2026-05-25 PG-quirk fix; the strength is FOR NO KEY UPDATE to match
    // what UPDATE takes implicitly so there's no upgrade-then-recheck
    // conflict with msg_upd in the same statement.
    // Regression A: dropping the lock permits late retries from
    // /api/reconcile-cost to race the post-stream IIFE.
    // Regression B: using FOR UPDATE (stronger than the implicit UPDATE
    // lock) triggers the EvalPlanQual quirk again — signed_d goes NULL,
    // byok_cost_micro_usd gets reset to 0 every reconcile.
    const cte = extractReconcileCte();
    expect(cte).toContain('FOR NO KEY UPDATE');
    expect(cte).toMatch(/reconciled_at IS NULL/);
  });

  it('captures old cost_settled via FROM subquery aliased as old.old_cs', () => {
    // OLD value capture: the FROM subquery selects
    // `cost_settled_micro_usd AS old_cs` so RETURNING can reference
    // `old.old_cs` to compute the signed delta. Without this rename, the
    // RETURNING expression would have to reference `cost_settled_micro_usd`
    // bare, which would be ambiguous with the column on the UPDATE target
    // (and resolve to the NEW value, breaking signed-delta semantics).
    const cte = extractReconcileCte();
    expect(cte).toMatch(/SELECT cost_settled_micro_usd AS old_cs/);
  });

  it('computes signed_d = actual - GREATEST(projected, old.old_cs) in RETURNING (SIGNED, allows refunds)', () => {
    // Signed-delta algebra: refund direction (delta < 0) and excess
    // direction (delta > 0) are both flowed through to user_api_usage in
    // the same atomic statement. The expression is now inline in
    // RETURNING (post-2026-05-25 shape change), computed off old.old_cs
    // captured by the FOR NO KEY UPDATE subquery.
    // Regression: clamping the delta to non-negative (e.g. GREATEST(0, ...))
    // here would silently disable refunds, leaving over-reserved cost
    // stuck in user_api_usage. The user_api_usage UPDATE's outer
    // GREATEST(0::bigint, prev + signed_d) is the negative-clamp safety
    // net, not the algebra.
    const cte = extractReconcileCte();
    expect(cte).toMatch(
      /\$\{actualStr\}::bigint - GREATEST\(\$\{projStr\}::bigint,\s*old\.old_cs\)\s+AS signed_d/,
    );
  });

  it('updates logging_messages with HWM-clamped cost_micro_usd + actualStr cost_settled + NOW() reconciled_at', () => {
    // Logging row update: HWM-monotone on cost_micro_usd, settles
    // cost_settled to truth, stamps reconciled_at exactly once.
    // Regression A: dropping GREATEST allows cost_micro_usd to regress.
    // Regression B: dropping `reconciled_at = NOW()` defeats the late-
    // retry lock and the IIFE-death-recovery test will pass falsely
    // because the lock-out path never engages.
    // Regression C: filtering on something other than reconciled_at IS NULL
    // permits double-stamping.
    // Note: `m.` prefix is mandatory in UPDATE..FROM since both
    // `logging_messages m` and the FROM subquery `old` are in scope.
    const cte = extractReconcileCte();
    expect(cte).toMatch(/UPDATE logging_messages m/);
    expect(cte).toMatch(/cost_micro_usd = GREATEST\(m\.cost_micro_usd, \$\{actualStr\}::bigint\)/);
    expect(cte).toMatch(/cost_settled_micro_usd = \$\{actualStr\}::bigint/);
    expect(cte).toContain('reconciled_at = NOW()');
    expect(cte).toContain('RETURNING');
    expect(cte).toMatch(/m\.cost_settled_micro_usd/);
  });

  it('updates user_api_usage with GREATEST(0::bigint, prev + signed_d) negative-clamp on both cost columns', () => {
    // Negative-clamp: refunds larger than the current user balance must
    // not push it below zero. Pinned because the simulation in
    // `iife-death-recovery.test.ts` mirrors this clamp via a JS ternary,
    // and a refactor that swaps it for an unclamped `prev + delta` would
    // pass the simulation while breaking real Postgres semantics
    // (negative bigint stored). Both `cost_micro_usd` (free) and
    // `byok_cost_micro_usd` (BYOK) must wear the clamp — see BYOK
    // regression note in `worker/_shared/cost-commit.ts`.
    const cte = extractReconcileCte();
    expect(cte).toMatch(/UPDATE user_api_usage/);
    expect(cte).toMatch(
      /cost_micro_usd = GREATEST\(0::bigint, cost_micro_usd \+ CASE WHEN \$\{tierIsByok\}::bool THEN 0::bigint ELSE \(SELECT signed_d FROM msg_upd\) END\)/,
    );
    expect(cte).toMatch(
      /byok_cost_micro_usd = GREATEST\(0::bigint, byok_cost_micro_usd \+ CASE WHEN \$\{tierIsByok\}::bool THEN \(SELECT signed_d FROM msg_upd\) ELSE 0::bigint END\)/,
    );
  });

  it('routes the signed_d via CASE WHEN tierIsByok to exactly one of the two cost columns', () => {
    // BYOK regression fix (2026-05-17): the signed_d lands in
    // `cost_micro_usd` (free cap) OR `byok_cost_micro_usd` (BYOK), never
    // both. The CASE-WHEN arms are mirror images: each column's `0::bigint`
    // arm corresponds to the other column's signed_d arm. A regression
    // that swapped the THEN/ELSE on either side would silently couple BYOK
    // spend back into the free cap (the original bug).
    const cte = extractReconcileCte();
    // free arm: free-tier writes signed_d to cost_micro_usd; BYOK
    // contributes 0.
    expect(cte).toMatch(
      /cost_micro_usd \+ CASE WHEN \$\{tierIsByok\}::bool THEN 0::bigint ELSE \(SELECT signed_d FROM msg_upd\) END/,
    );
    // BYOK arm: BYOK writes signed_d to byok_cost_micro_usd; free
    // contributes 0.
    expect(cte).toMatch(
      /byok_cost_micro_usd \+ CASE WHEN \$\{tierIsByok\}::bool THEN \(SELECT signed_d FROM msg_upd\) ELSE 0::bigint END/,
    );
  });

  it('gates user_api_usage UPDATE behind EXISTS(SELECT 1 FROM msg_upd)', () => {
    // EXISTS-guard: when the logging_messages UPDATE matches zero rows
    // (already reconciled, ownership mismatch, missing row), the
    // user_api_usage UPDATE must skip.
    // Regression: dropping the EXISTS clause causes a wrong-actorId
    // request to mutate user_api_usage even though logging_messages
    // refused the update, breaking the ownership pin in
    // `iife-death-recovery.test.ts` ("a wrong actorId no-ops both rows").
    const cte = extractReconcileCte();
    expect(cte).toContain('EXISTS(SELECT 1 FROM msg_upd)');
    expect(cte).toMatch(/WHERE user_id = \$\{actorId\} AND EXISTS\(SELECT 1 FROM msg_upd\)/);
  });

  it('accumulates token counters additively on user_api_usage', () => {
    // Token accumulation pin: the signed-delta SQL increments token
    // counters regardless of cost direction. The simulation's
    // "token counters incremented additively" test relies on these five
    // lines being present and using `+=` semantics (not assignment).
    // Regression: gating token writes on `signed_d > 0` (e.g. in a
    // CASE) would silently drop tokens for refund-direction reconciles.
    const cte = extractReconcileCte();
    expect(cte).toMatch(/input_tokens = input_tokens \+ \$\{reconciledAccumulator\.input_tokens\}/);
    expect(cte).toMatch(
      /output_tokens = output_tokens \+ \$\{reconciledAccumulator\.output_tokens\}/,
    );
    expect(cte).toMatch(
      /cache_create_tokens = cache_create_tokens \+ \$\{reconciledAccumulator\.cache_creation_input_tokens\}/,
    );
    expect(cte).toMatch(
      /cache_read_tokens = cache_read_tokens \+ \$\{reconciledAccumulator\.cache_read_input_tokens\}/,
    );
    expect(cte).toMatch(
      /web_search_uses = web_search_uses \+ \$\{reconciledAccumulator\.web_search_requests\}/,
    );
  });

  it('stamps last_activity_at = NOW() on user_api_usage', () => {
    // Sanity pin: every cost write touches `last_activity_at` so the
    // observability column stays fresh. Catches a refactor that drops
    // the column from the SET list.
    const cte = extractReconcileCte();
    expect(cte).toContain('last_activity_at = NOW()');
  });

  it('keys both UPDATEs on the same (message_id, user_id, reconciled_at IS NULL) triple', () => {
    // Ownership pin: the FROM subquery and the msg_upd UPDATE both key on
    // the same (loggingMessageId, actorId) pair AND both filter on
    // `reconciled_at IS NULL` — the lock against late retries.
    // Regression: dropping the WHERE on msg_upd's UPDATE collapses the
    // late-retry lock semantically while leaving the FOR NO KEY UPDATE
    // in place, so the row could be re-stamped.
    const cte = extractReconcileCte();
    const messageIdWhereCount = (cte.match(/message_id = \$\{loggingMessageId\}/g) ?? []).length;
    expect(messageIdWhereCount).toBeGreaterThanOrEqual(2); // FROM subquery + msg_upd
    const reconciledNullCount = (cte.match(/reconciled_at IS NULL/g) ?? []).length;
    expect(reconciledNullCount).toBeGreaterThanOrEqual(2); // FROM subquery + msg_upd
  });
});
