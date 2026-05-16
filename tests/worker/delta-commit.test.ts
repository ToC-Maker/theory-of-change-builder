// Tests for `applyDeltaCommit` (worker/_shared/cost-commit.ts).
//
// The helper is the single in-stream cost writer used by every per-update
// commit and by the post-stream reconcile. The SQL itself is a single CTE
// statement that bakes ownership (`AND user_id = $3`) and the late-retry
// lock (`AND reconciled_at IS NULL`) into both the SELECT FOR UPDATE and
// the UPDATE; the row's existence + ownership + non-reconciled state is
// observable as a CTE-empty result, and the helper translates that into
// `{applied: false, delta: 0n, new_settled: 0n}` for every caller.
//
// Coverage strategy: we mock the Neon tagged-template returning canned
// rows for each branch we want to exercise. The SQL string itself is not
// asserted character-for-character (that would lock down formatting, not
// behaviour) — the contract being pinned is the helper's input/output
// mapping plus the no-SQL fast-path on null/empty messageId. Concurrent
// row-lock semantics are pinned in the sibling
// `delta-commit-concurrency.test.ts` file.
import { describe, expect, it } from 'vitest';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { applyDeltaCommit } from '../../worker/_shared/cost-commit';

type CapturedCall = {
  strings: TemplateStringsArray;
  values: unknown[];
};

/**
 * Build a tagged-template SQL spy. The spy:
 *   - records every invocation in a `calls[]` array (so tests can assert
 *     "no SQL was issued" on the null-messageId fast-path);
 *   - resolves to whatever row array `responder()` returns for that
 *     invocation index. This lets a single test queue distinct responses
 *     across multiple calls if needed.
 */
function makeSqlSpy(rows: ReadonlyArray<Record<string, unknown>>): {
  sql: NeonQueryFunction<false, false>;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    return Promise.resolve(rows);
  };
  return { sql: sql as NeonQueryFunction<false, false>, calls };
}

describe('applyDeltaCommit', () => {
  describe('null/empty messageId fast-path', () => {
    it('no-ops when messageId is null (no SQL issued)', async () => {
      // The caller is responsible for passing the captured loggingMessageId
      // through to the helper; before message_start the row id is not yet
      // known, so the caller passes null. The helper must not even attempt
      // an SQL roundtrip in that window — it would 1) waste a Neon HTTP
      // request and 2) match nothing anyway.
      const { sql, calls } = makeSqlSpy([]);
      const result = await applyDeltaCommit(sql, null, 'auth0|alice', 100n, 500n);
      expect(result).toEqual({ applied: false, delta: 0n, new_settled: 0n });
      expect(calls).toHaveLength(0);
    });

    it('no-ops when messageId is undefined (no SQL issued)', async () => {
      // `loggingMessageId` is typed `string | null | undefined` in the
      // caller's SseTeeContext; cover the undefined branch too so a future
      // refactor can't silently start issuing SQL for unset ids.
      const { sql, calls } = makeSqlSpy([]);
      const result = await applyDeltaCommit(sql, undefined, 'auth0|alice', 100n, 500n);
      expect(result).toEqual({ applied: false, delta: 0n, new_settled: 0n });
      expect(calls).toHaveLength(0);
    });

    it('no-ops when messageId is empty string (no SQL issued)', async () => {
      // Defensive: an empty string is falsy, so the early-return covers it
      // naturally. Pin this so a future refactor to `messageId == null`
      // (which would treat '' as truthy) wouldn't silently start firing
      // SQL with WHERE message_id = ''.
      const { sql, calls } = makeSqlSpy([]);
      const result = await applyDeltaCommit(sql, '', 'auth0|alice', 100n, 500n);
      expect(result).toEqual({ applied: false, delta: 0n, new_settled: 0n });
      expect(calls).toHaveLength(0);
    });
  });

  describe('row-not-found / ownership / reconciled (CTE produces empty / applied=false)', () => {
    it('returns applied:false when row is missing', async () => {
      // The user-message INSERT in `logging-saveMessage.ts` runs concurrently
      // with the streaming worker; the row may not exist when the first
      // per-update write fires. The CTE's `WHERE message_id = $1` excludes
      // the row, msg_upd RETURNING returns zero rows, and the EXISTS clause
      // produces `applied = false`.
      const { sql } = makeSqlSpy([{ new_settled: null, delta: null, applied: false }]);
      const result = await applyDeltaCommit(sql, 'msg_missing', 'auth0|alice', 100n, 500n);
      expect(result).toEqual({ applied: false, delta: 0n, new_settled: 0n });
    });

    it('returns applied:false when row is owned by a different user (IDOR guard)', async () => {
      // `AND user_id = $3` in both the SELECT FOR UPDATE and the UPDATE
      // means a caller posting against another user's logging_message_id
      // gets a CTE-empty result; the helper reports the same shape as
      // "row missing". The endpoint-level reconcile (`computeReconcileOutcome`)
      // distinguishes these cases for the response status; the helper does
      // not — both produce a no-op cost write.
      const { sql } = makeSqlSpy([{ new_settled: null, delta: null, applied: false }]);
      const result = await applyDeltaCommit(sql, 'msg_bob_owned', 'auth0|alice', 100n, 500n);
      expect(result).toEqual({ applied: false, delta: 0n, new_settled: 0n });
    });

    it('returns applied:false when reconciled_at is non-null (late-retry lock)', async () => {
      // The post-stream reconcile (Task 8) stamps `reconciled_at = NOW()`
      // atomically with the signed-delta SQL. A late retry from the 7-day
      // localStorage retry queue (`chatService.ts` reconcile-cost retry
      // path, see C5 in plan) would otherwise re-inflate the cap. The
      // `WHERE reconciled_at IS NULL` clause causes the CTE to no-op. The
      // mock returns the same empty-row shape as the previous two cases
      // (the helper can't distinguish them — they're all "CTE excluded").
      const { sql } = makeSqlSpy([{ new_settled: null, delta: null, applied: false }]);
      const result = await applyDeltaCommit(sql, 'msg_reconciled', 'auth0|alice', 100n, 500n);
      expect(result).toEqual({ applied: false, delta: 0n, new_settled: 0n });
    });

    it('returns applied:false when SQL returns zero rows (defensive)', async () => {
      // Belt-and-braces: even if a future driver or schema change made the
      // outer SELECT return zero rows instead of one row with `applied=false`,
      // the helper still reports the no-op shape. The plan's CTE is
      // structured to always return one row (the EXISTS scalar wraps the
      // emptiness), but this guard prevents a silent NaN / undefined leak
      // if the contract drifts.
      const { sql } = makeSqlSpy([]);
      const result = await applyDeltaCommit(sql, 'msg_zero_rows', 'auth0|alice', 100n, 500n);
      expect(result).toEqual({ applied: false, delta: 0n, new_settled: 0n });
    });
  });

  describe('GREATEST clamp: no-op when newCost ≤ max(projected, settled)', () => {
    it('reports delta=0n when newCost equals the baseline (CTE GREATEST(0, 0))', async () => {
      // The CTE's `computed = GREATEST(0::bigint, $newCost::bigint - baseline)`
      // returns 0 when the new value matches the baseline. The msg_upd row
      // updates with no-op (GREATEST(cost_settled, newCost) = cost_settled),
      // and user_upd is gated by `WHERE delta > 0`, so no user_api_usage
      // write fires.
      //
      // The helper still reports `applied: true` because the row exists and
      // the UPDATE statement ran (RETURNING produced a row). `delta = 0n`
      // is the signal callers use to decide whether to log the write.
      const { sql } = makeSqlSpy([{ new_settled: '500000', delta: '0', applied: true }]);
      const result = await applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 100_000n, 500_000n);
      expect(result).toEqual({ applied: true, delta: 0n, new_settled: 500_000n });
    });

    it('reports delta=0n when newCost is below the baseline (rare, defensive)', async () => {
      // In normal flow, `newCost` is monotone-up across a stream — the
      // client sends running_cost frames that are non-decreasing, and the
      // mid-stream cost-cap poller computes them too. But a stale client
      // retry from the localStorage queue (or a network reordering) could
      // post a lower value than the row already settled. The CTE's
      // GREATEST(0, ...) clamp is the line of defence; here we pin the
      // helper's output mapping for that case.
      const { sql } = makeSqlSpy([{ new_settled: '500000', delta: '0', applied: true }]);
      const result = await applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 100_000n, 200_000n);
      expect(result).toEqual({ applied: true, delta: 0n, new_settled: 500_000n });
    });
  });

  describe('positive delta: newCost > max(projected, settled)', () => {
    it('reports delta = newCost - max(projected, settled) when newCost wins', async () => {
      // The headline case: a per-update commit observes a higher
      // running_cost than either the reservation projection or the
      // currently-settled value. user_api_usage gets credited the diff
      // (atomically with the row settle).
      //
      // Trace: projected=$0.10 ($100k µUSD), settled=$0.20 ($200k), newCost=$0.50 ($500k).
      // baseline = max(0.10, 0.20) = 0.20; delta = max(0, 0.50 - 0.20) = 0.30.
      // settled becomes 0.50.
      const { sql } = makeSqlSpy([{ new_settled: '500000', delta: '300000', applied: true }]);
      const result = await applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 100_000n, 500_000n);
      expect(result).toEqual({
        applied: true,
        delta: 300_000n,
        new_settled: 500_000n,
      });
    });

    it('coerces string-typed bigints from Neon into bigint return values', async () => {
      // Neon's BIGINT columns deserialize as strings on certain driver
      // configurations (see `worker/_shared/bigint.ts` JSDoc). The helper
      // routes both `delta` and `new_settled` through `toBigInt`, so a
      // stringly-typed result still produces bigint values to callers.
      // Without the coercion, downstream BigInt arithmetic would throw
      // ("Cannot mix BigInt and other types") and the per-update write
      // would silently fail.
      const { sql } = makeSqlSpy([
        { new_settled: '999999999999', delta: '888888888888', applied: true },
      ]);
      const result = await applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 0n, 999_999_999_999n);
      expect(result.delta).toBe(888_888_888_888n);
      expect(result.new_settled).toBe(999_999_999_999n);
    });

    it('coerces number-typed delta/new_settled into bigint', async () => {
      // Smaller values (under Number.MAX_SAFE_INTEGER) may arrive as `number`.
      // The toBigInt helper truncates; pin this so a future refactor that
      // dropped the coercion (returning `row.delta` directly) would fail.
      const { sql } = makeSqlSpy([{ new_settled: 1000, delta: 200, applied: true }]);
      const result = await applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 800n, 1000n);
      expect(result.delta).toBe(200n);
      expect(result.new_settled).toBe(1000n);
    });

    it('handles bigint values past Number.MAX_SAFE_INTEGER without precision loss', async () => {
      // 2^60 is past 2^53. The helper returns bigint either way (Neon may
      // hand back bigint for values past 2^53), and downstream cap math is
      // bigint-native. Pin this so a refactor that funneled through Number
      // would visibly fail.
      const huge = 1n << 60n;
      const { sql } = makeSqlSpy([{ new_settled: huge, delta: huge, applied: true }]);
      const result = await applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 0n, huge);
      expect(result.delta).toBe(huge);
      expect(result.new_settled).toBe(huge);
    });
  });

  describe('SQL invocation shape', () => {
    it('issues exactly one SQL call (the single-statement invariant)', async () => {
      // The JSDoc at the top of cost-commit.ts pins this as a contract:
      // splitting the CTE into two statements would break the FOR UPDATE
      // row-lock invariant on Neon HTTP (locks expire at statement end).
      // A future refactor that, e.g., did a SELECT first and then a
      // separate UPDATE would bump this assertion to 2.
      const { sql, calls } = makeSqlSpy([
        { new_settled: '500000', delta: '300000', applied: true },
      ]);
      await applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 100_000n, 500_000n);
      expect(calls).toHaveLength(1);
    });

    it('passes messageId, projected, newCost, and userId as interpolated values', async () => {
      // We don't pin the SQL string character-for-character (formatting
      // changes shouldn't break tests), but we do pin that the helper's
      // four arguments arrive as interpolated values. The Neon tagged-template
      // captures them in the `values` array. This catches a refactor that
      // accidentally dropped one of the parameters.
      const { sql, calls } = makeSqlSpy([
        { new_settled: '500000', delta: '300000', applied: true },
      ]);
      await applyDeltaCommit(sql, 'msg_x', 'auth0|alice', 100_000n, 500_000n);
      // The tagged-template values are the raw arguments — `messageId` and
      // `userId` interpolate as strings; `projected` and `newCost` as
      // strings (per the plan SQL using `${projStr}::bigint` casts).
      const flat = calls[0].values.map(String);
      expect(flat).toContain('msg_x');
      expect(flat).toContain('auth0|alice');
      expect(flat).toContain('100000');
      expect(flat).toContain('500000');
    });
  });
});
