import type { NeonQueryFunction } from '@neondatabase/serverless';
import { toBigInt } from './bigint';

/**
 * Discriminated return shape of `applyDeltaCommit`.
 *
 * The `applied: true` arm is the happy path: the row existed, was owned
 * by the caller, was not already reconciled, and the helper credited
 * (or no-op'd-with-delta-0) `user_api_usage` based on the GREATEST clamp.
 *
 * The `applied: false` arm covers every "we couldn't write" branch. It
 * carries a `reason` discriminator so callers (and diagnostic queries)
 * can distinguish the two coarse-grained no-op buckets:
 *
 *   - `'missing_id'` — the helper short-circuited before issuing any SQL
 *     because the caller passed a null / undefined / empty `messageId`.
 *     Typical in the pre-message_start window where the row identifier
 *     is not yet known. No DB round-trip happens.
 *
 *   - `'row_not_found_or_foreign_or_reconciled'` — SQL executed but the
 *     CTE returned zero rows. Three sub-causes collapse into this bucket
 *     because the CTE itself cannot distinguish them (all three look
 *     identical to the `EXISTS(SELECT 1 FROM msg_upd)` scalar):
 *       1. Row not found by `message_id` (e.g. cross-Worker race).
 *       2. Row found but `user_id` mismatch (IDOR guard).
 *       3. Row found but `reconciled_at` is non-null (post-stream
 *          reconcile stamped it; late client retries from the 7-day
 *          localStorage queue must not re-inflate the cap).
 *     Distinguishing 1/2/3 would require a second SELECT after the
 *     update fails, which would defeat the single-statement lock-
 *     acquisition invariant. The labeled bucket is still better than
 *     the previous undifferentiated `applied: false` because the
 *     `missing_id` short-circuit is now visibly distinct from the
 *     post-DB-call no-ops.
 */
export type ApplyDeltaCommitResult =
  | { applied: true; delta: bigint; new_settled: bigint }
  | {
      applied: false;
      reason: 'missing_id' | 'row_not_found_or_foreign_or_reconciled';
      delta: 0n;
      new_settled: 0n;
    };

/**
 * Atomic in-stream delta-commit.
 *
 * Single SQL statement issued via Neon HTTP. The CTE bakes ownership
 * (`AND user_id = $3`) into both the `SELECT ... FOR UPDATE` and the
 * `UPDATE`, and the late-retry lock (`AND reconciled_at IS NULL`) into
 * both as well. The two `applied: false` buckets — the `missing_id`
 * short-circuit and the SQL-returned-zero-rows path — are documented
 * on `ApplyDeltaCommitResult` above. The `reason` discriminator on the
 * `applied: false` arm lets diagnostics + downstream gating distinguish
 * the no-SQL fast-path from the lock-out cases (row missing, IDOR, or
 * already reconciled).
 *
 * Idempotency: the row UPDATE uses
 * `cost_settled_micro_usd = GREATEST(cost_settled_micro_usd, $newCost)`,
 * which is safe against concurrent writers; the user_api_usage UPDATE
 * is gated by `WHERE (SELECT delta FROM computed) > 0`, so a no-op
 * commit doesn't double-credit. Combined with the `FOR UPDATE` row
 * lock, two concurrent writers against the same `message_id` converge
 * to a deterministic final state regardless of acquisition order:
 * final settled = max(newCost values), total user_api_usage delta =
 * final settled - max(projected, initial settled).
 *
 * Refund handling: this helper NEVER decreases `user_api_usage`.
 * `GREATEST(0, ...)` clamps the delta to non-negative, so a newCost
 * lower than the existing settled or projected baseline is a no-op
 * cost write. Refunds (when the post-stream reconcile observes that
 * the reservation was higher than the actual final cost) happen via
 * the signed-delta CTE in the post-stream reconcile block of
 * `worker/api/anthropic-stream.ts` (and the `/api/reconcile-cost`
 * endpoint that mirrors it) — separate from this helper precisely
 * so the in-stream writes never have to think about negative deltas.
 *
 * Why one SQL statement (NOT a TS transaction over multiple calls):
 * Neon HTTP rows-of-flight do not span statement boundaries — the
 * `FOR UPDATE` lock acquired in a SELECT releases at statement end.
 * Splitting the CTE into separate SELECT + UPDATE round-trips would
 * silently allow two concurrent writers to both read the same
 * `cost_settled`, both compute deltas against it, and both credit
 * the user (double-counting). A future refactor that splits this
 * statement breaks the concurrency invariant; the single-call
 * assertion in the unit test catches that drift.
 *
 * isByok routing (BYOK regression fix, 2026-05-17):
 *
 * Pre-PR, the per-stream BYOK reconcile path was gated by
 * `if (isCapped(tier))`, so BYOK never wrote to `user_api_usage` at all.
 * This PR's per-update writer (`firePerUpdateCommit`) and post-stream
 * signed-delta reconcile dropped that gate (both now write to
 * user_api_usage unconditionally for cost-accuracy reasons), which
 * inadvertently coupled BYOK spend to the free cap: `reserveCost`
 * (the cap-check pre-flight in `anthropic-stream.ts`) still reads
 * `cost_micro_usd + projected <= LIFETIME_CAP_MICRO_USD`. A user who
 * spent $4 via BYOK, then removed the key, ended up with only $1 of
 * free cap remaining instead of the full $5 — a Critical regression
 * caught in PR #23 review.
 *
 * Fix: split the user_api_usage column. `isByok=true` routes the delta
 * into `byok_cost_micro_usd` (independent of cap, visible in
 * `/api/usage` as `byok_used_usd`). `isByok=false` keeps writing to
 * `cost_micro_usd` (the column reserveCost checks against
 * `LIFETIME_CAP_MICRO_USD`). The CASE-WHEN form keeps the dual-row
 * write inside the same atomic CTE so cap-check / display invariants
 * survive concurrent writers.
 *
 * @returns `ApplyDeltaCommitResult` (discriminated union):
 *   - `{applied: true, delta, new_settled}` — the row was updated (delta
 *     may be `0n` when newCost ≤ max(projected, settled); `applied: true`
 *     still holds because the SQL ran and the row was settled monotonically).
 *     The delta lands in `byok_cost_micro_usd` when `isByok=true`,
 *     otherwise `cost_micro_usd`.
 *   - `{applied: false, reason: 'missing_id', delta: 0n, new_settled: 0n}`
 *     when the helper short-circuited before SQL (null/undefined/empty
 *     messageId). No DB round-trip happens.
 *   - `{applied: false, reason: 'row_not_found_or_foreign_or_reconciled',
 *     delta: 0n, new_settled: 0n}` when SQL ran but the CTE matched no
 *     rows. The three sub-causes (row missing, IDOR, already reconciled)
 *     are not individually distinguishable from a single CTE result;
 *     callers needing finer granularity must SELECT separately.
 */
export async function applyDeltaCommit(
  sql: NeonQueryFunction<false, false>,
  messageId: string | null | undefined,
  userId: string,
  projectedMicroUsd: bigint,
  newCostMicroUsd: bigint,
  isByok: boolean,
): Promise<ApplyDeltaCommitResult> {
  if (!messageId) {
    return { applied: false, reason: 'missing_id', delta: 0n, new_settled: 0n };
  }
  // Neon's tagged-template serialises numeric interpolations through its
  // own type-tagging pipeline; stringifying first + casting via
  // `::bigint` is the canonical "definitely a bigint, not a JSON number"
  // path (see `worker/_shared/bigint.ts` for the read-side dual).
  const projStr = projectedMicroUsd.toString();
  const newStr = newCostMicroUsd.toString();
  const result = (await sql`
    WITH locked AS (
      SELECT cost_settled_micro_usd, reconciled_at
      FROM logging_messages
      WHERE message_id = ${messageId} AND user_id = ${userId} AND reconciled_at IS NULL
      FOR UPDATE
    ),
    baseline AS (
      SELECT GREATEST(${projStr}::bigint, cost_settled_micro_usd) AS bl FROM locked
    ),
    computed AS (
      SELECT GREATEST(0::bigint, ${newStr}::bigint - (SELECT bl FROM baseline)) AS delta FROM locked
    ),
    msg_upd AS (
      UPDATE logging_messages
      SET cost_micro_usd = GREATEST(cost_micro_usd, ${newStr}::bigint),
          cost_settled_micro_usd = GREATEST(cost_settled_micro_usd, ${newStr}::bigint)
      WHERE message_id = ${messageId} AND user_id = ${userId} AND reconciled_at IS NULL
      RETURNING cost_settled_micro_usd AS new_settled
    ),
    user_upd AS (
      UPDATE user_api_usage
      SET cost_micro_usd = cost_micro_usd + CASE WHEN ${isByok}::bool THEN 0::bigint ELSE (SELECT delta FROM computed) END,
          byok_cost_micro_usd = byok_cost_micro_usd + CASE WHEN ${isByok}::bool THEN (SELECT delta FROM computed) ELSE 0::bigint END
      WHERE user_id = ${userId} AND (SELECT delta FROM computed) > 0
      RETURNING cost_micro_usd
    )
    SELECT
      (SELECT new_settled FROM msg_upd) AS new_settled,
      (SELECT delta FROM computed) AS delta,
      EXISTS(SELECT 1 FROM msg_upd) AS applied
  `) as {
    new_settled: bigint | number | string | null;
    delta: bigint | number | string | null;
    applied: boolean;
  }[];
  const row = result[0];
  if (!row || !row.applied) {
    return {
      applied: false,
      reason: 'row_not_found_or_foreign_or_reconciled',
      delta: 0n,
      new_settled: 0n,
    };
  }
  return {
    applied: true,
    new_settled: toBigInt(row.new_settled),
    delta: toBigInt(row.delta),
  };
}
