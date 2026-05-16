import type { NeonQueryFunction } from '@neondatabase/serverless';
import { toBigInt } from './bigint';

/**
 * Atomic in-stream delta-commit.
 *
 * Single SQL statement issued via Neon HTTP. The CTE bakes ownership
 * (`AND user_id = $3`) into both the `SELECT ... FOR UPDATE` and the
 * `UPDATE`, and the late-retry lock (`AND reconciled_at IS NULL`) into
 * both as well. Three "no-op" conditions collapse into a single return
 * shape (`{applied: false, delta: 0n, new_settled: 0n}`):
 *
 *   1. Row not found by message_id.
 *   2. Row found, but user_id mismatch (IDOR guard).
 *   3. Row found, but `reconciled_at` is non-null (post-stream reconcile
 *      stamped it; late client retries from the localStorage queue
 *      must not re-inflate the cap).
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
 * the signed-delta SQL in Task 8's `/api/reconcile-cost` path —
 * separate from this helper precisely so the in-stream writes never
 * have to think about negative deltas.
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
 * @returns `{applied, delta, new_settled}`:
 *   - `applied`: true iff the row exists, is owned by `userId`, and
 *     `reconciled_at` is null. False on any no-op condition.
 *   - `delta`: bigint µUSD credited to `user_api_usage` this call;
 *     `0n` when newCost ≤ max(projected, settled).
 *   - `new_settled`: the row's `cost_settled_micro_usd` after the
 *     UPDATE; `0n` on no-op.
 */
export async function applyDeltaCommit(
  sql: NeonQueryFunction<false, false>,
  messageId: string | null | undefined,
  userId: string,
  projectedMicroUsd: bigint,
  newCostMicroUsd: bigint,
): Promise<{ applied: boolean; delta: bigint; new_settled: bigint }> {
  if (!messageId) return { applied: false, delta: 0n, new_settled: 0n };
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
      SET cost_micro_usd = cost_micro_usd + (SELECT delta FROM computed)
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
  if (!row || !row.applied) return { applied: false, delta: 0n, new_settled: 0n };
  return {
    applied: true,
    new_settled: toBigInt(row.new_settled),
    delta: toBigInt(row.delta),
  };
}
