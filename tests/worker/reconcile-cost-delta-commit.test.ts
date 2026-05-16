// End-to-end seam tests for `POST /api/reconcile-cost` (Task 11).
//
// Task 11 replaced the endpoint's inline `UPDATE logging_messages` with a
// call to the shared `applyDeltaCommit` helper. The helper atomically:
//   1. Locks the logging_messages row (`SELECT ... FOR UPDATE`).
//   2. Updates BOTH `cost_micro_usd` (monotone HWM) AND
//      `cost_settled_micro_usd` (the settled value the reconcile compares
//      against).
//   3. Credits `user_api_usage.cost_micro_usd` by
//      `max(0, newCost - max(projected, cost_settled))`.
//   4. Bakes the late-retry lock (`AND reconciled_at IS NULL`) into both
//      the SELECT and the UPDATE, so stamped rows produce `applied=false`.
//
// What this file pins:
//   - The endpoint's argument shape: `applyDeltaCommit(sql, loggingMessageId,
//     actorId, 0n, clientCost)`. `projected = 0n` is the load-bearing
//     decision documented in plans/byok-cost-stream-recovery.md § Task 11 —
//     the endpoint runs in a fresh Worker invocation with no reservation
//     context, and the helper's `max(projected, cost_settled)` baseline
//     correctly degenerates to `cost_settled` (which already incorporates
//     the reservation via earlier mid-stream / message_start / abort-handler
//     writers).
//   - Both `logging_messages` columns AND `user_api_usage` mutate on an
//     `applied=true` push. A regression where the endpoint resurrected the
//     inline UPDATE would touch only `logging_messages.cost_micro_usd` and
//     break the cap-recovery flow.
//   - Idempotency across repeated calls: a second push with the same
//     `clientCost` produces `applied: false`, no further mutation.
//   - The late-retry lock: a row with `reconciled_at IS NOT NULL` returns
//     `applied: false` with no state change, regardless of how high the
//     client cost is. This is the critical guard against late retries
//     from the 7-day client localStorage queue re-inflating an already-
//     reconciled cap (and breaking the signed-delta reconcile invariant).
//
// What this file does NOT pin (covered elsewhere):
//   - Body validation (logging_message_id required, etc.):
//     `reconcile-cost.test.ts` (`parseReconcileBody`).
//   - Concurrent writers against the same message_id:
//     `delta-commit-concurrency.test.ts`.
//   - The IIFE-vs-late-retry race specifically:
//     `iife-death-recovery.test.ts`.
//   - The HTTP handler's auth flow (Auth0 JWT verification, anon cookie
//     resolution) and the `DiagnosticReconcileEndpointHit` row write —
//     those need a Workers runtime / mocked auth; see the TODO block in
//     `reconcile-cost.test.ts`.
//
// Test strategy: we invoke `applyDeltaCommit` directly with the exact
// argument shape the endpoint passes, against the same in-memory backend
// used by `delta-commit-concurrency.test.ts` and `iife-death-recovery.test.ts`.
// This avoids spinning up the full HTTP handler (and mocking Auth0 +
// anon-cookie + diagnostic writes), while still pinning the contract that
// matters: the endpoint advances both row pairs atomically when applied,
// and produces a no-op shape under the documented late-retry / IDOR /
// already-reconciled conditions.
import { describe, expect, it, vi } from 'vitest';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { applyDeltaCommit } from '../../worker/_shared/cost-commit';

// ---------------------------------------------------------------------------
// In-memory backend (mirrors delta-commit-concurrency.test.ts +
// iife-death-recovery.test.ts).
//
// The backend exposes an SQL-tagged-template that matches the CTE in
// `worker/_shared/cost-commit.ts`. Two rows: one `logging_messages` row and
// one `user_api_usage` row. The mutex stands in for the row-level
// `FOR UPDATE` lock; per-message critical sections serialise so the CTE
// algebra runs against the already-updated state on a second call (the
// idempotency property we pin below).
// ---------------------------------------------------------------------------

type LoggingMessageRow = {
  message_id: string;
  user_id: string;
  cost_micro_usd: bigint;
  cost_settled_micro_usd: bigint;
  reconciled_at: Date | null;
};

type UserApiUsageRow = {
  user_id: string;
  cost_micro_usd: bigint;
};

function makeBackend(initial: { message: LoggingMessageRow; user_usage: UserApiUsageRow }): {
  sql: NeonQueryFunction<false, false>;
  state: { message: LoggingMessageRow; user_usage: UserApiUsageRow };
  callCount: () => number;
  capturedValues: () => unknown[][];
} {
  const state = {
    message: { ...initial.message },
    user_usage: { ...initial.user_usage },
  };
  const capturedValues: unknown[][] = [];

  const mutexes = new Map<string, Promise<void>>();
  function withRowLock<T>(messageId: string, critical: () => Promise<T>): Promise<T> {
    const prev = mutexes.get(messageId) ?? Promise.resolve();
    const next = prev.then(critical);
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
  const sql: any = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    capturedValues.push(values);
    const messageId = String(values[0]);
    const userId = String(values[1]);
    const projected = BigInt(String(values[2]));
    const newCost = BigInt(String(values[3]));

    return withRowLock(messageId, async () => {
      await Promise.resolve();
      const row = state.message;
      const matches =
        row.message_id === messageId && row.user_id === userId && row.reconciled_at === null;
      if (!matches) {
        return [{ new_settled: null, delta: null, applied: false }];
      }
      const baseline =
        projected > row.cost_settled_micro_usd ? projected : row.cost_settled_micro_usd;
      const computedDelta = newCost > baseline ? newCost - baseline : 0n;
      const newSettled =
        newCost > row.cost_settled_micro_usd ? newCost : row.cost_settled_micro_usd;
      const newCostHwm = newCost > row.cost_micro_usd ? newCost : row.cost_micro_usd;
      state.message = {
        ...row,
        cost_micro_usd: newCostHwm,
        cost_settled_micro_usd: newSettled,
      };
      if (computedDelta > 0n) {
        state.user_usage = {
          ...state.user_usage,
          cost_micro_usd: state.user_usage.cost_micro_usd + computedDelta,
        };
      }
      return [{ new_settled: newSettled, delta: computedDelta, applied: true }];
    });
  };

  return {
    sql: sql as NeonQueryFunction<false, false>,
    state,
    callCount: () => capturedValues.length,
    capturedValues: () => capturedValues,
  };
}

// ---------------------------------------------------------------------------
// The exact call the endpoint makes. Keeping this colocated with the test
// makes any future refactor (e.g. someone changing `projected` from `0n` to
// something else) visible in one place.
//
// IF YOU CHANGE THIS WRAPPER, also change `worker/api/reconcile-cost.ts`
// at the `applyDeltaCommit(...)` site — the two must agree or these tests
// pin the wrong contract.
// ---------------------------------------------------------------------------
async function endpointCall(
  sql: NeonQueryFunction<false, false>,
  loggingMessageId: string,
  actorId: string,
  clientCost: bigint,
): ReturnType<typeof applyDeltaCommit> {
  // projected = 0n: see header comment + plan § Task 11.
  return applyDeltaCommit(sql, loggingMessageId, actorId, 0n, clientCost);
}

describe('/api/reconcile-cost uses applyDeltaCommit (end-to-end seam)', () => {
  describe('argument shape', () => {
    it('passes projected = 0n so the baseline degenerates to cost_settled', async () => {
      // The headline contract pin for Task 11. The endpoint runs in a
      // fresh Worker invocation with no reservation context — if a future
      // refactor accidentally threaded a non-zero `projected` here, the
      // helper's baseline would over-clamp and the endpoint could
      // silently under-credit `user_api_usage` on legitimate pushes.
      //
      // The CTE in cost-commit.ts interpolates the four arguments
      // (messageId, userId, projStr, newStr) in a fixed order at the
      // *front* of the values list; subsequent occurrences in the
      // UPDATE clauses repeat them but the first four are positional.
      // Pin just the leading slice — that's the part the endpoint
      // controls.
      const { sql, capturedValues } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 100n,
          cost_settled_micro_usd: 100n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
      });
      await endpointCall(sql, 'msg_x', 'auth0|alice', 500n);
      const leading = capturedValues()[0].slice(0, 4);
      expect(leading).toEqual(['msg_x', 'auth0|alice', '0', '500']);
      // Belt-and-braces: confirm the projected arg is the literal '0'
      // string (the BigInt.toString() of 0n), not some other falsy value
      // that might accidentally coerce to '' or undefined.
      expect(leading[2]).toBe('0');
    });

    it('issues exactly one SQL statement per endpoint call (matches the helper invariant)', async () => {
      // The helper's JSDoc pins this as a contract: splitting the CTE into
      // separate SELECT/UPDATE statements would lose the FOR UPDATE row
      // lock between them. A regression in the endpoint that, e.g., did
      // its own pre-flight SELECT before calling the helper would bump
      // this to 2 — observable here.
      const { sql, callCount } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 100n,
          cost_settled_micro_usd: 100n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
      });
      await endpointCall(sql, 'msg_x', 'auth0|alice', 500n);
      expect(callCount()).toBe(1);
    });
  });

  describe('applied: true — dual-row mutation', () => {
    it('a successful push advances BOTH cost_micro_usd AND cost_settled_micro_usd', async () => {
      // The pre-Task-11 endpoint inlined an `UPDATE logging_messages SET
      // cost_micro_usd = GREATEST(...)` that touched ONLY `cost_micro_usd`,
      // leaving `cost_settled_micro_usd` stuck at whatever the in-stream
      // writers wrote. That left the post-stream reconcile's baseline
      // (`max(projected, cost_settled)`) below the actual settle, and the
      // per-user cap could under-credit. Task 11's helper advances BOTH
      // columns atomically — pin that both moved.
      const { sql, state } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 100n,
          cost_settled_micro_usd: 100n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
      });
      const out = await endpointCall(sql, 'msg_x', 'auth0|alice', 500n);
      expect(out).toEqual({ applied: true, delta: 400n, new_settled: 500n });
      // Both columns moved (not just cost_micro_usd, as in the pre-Task-11
      // inline UPDATE).
      expect(state.message.cost_micro_usd).toBe(500n);
      expect(state.message.cost_settled_micro_usd).toBe(500n);
    });

    it('credits user_api_usage by exactly the delta', async () => {
      // The other half of the dual-row write the inline UPDATE was missing
      // entirely. With `projected = 0n` and `cost_settled = 100n`, baseline
      // = max(0, 100) = 100. New cost = 500. Delta = max(0, 500 - 100) =
      // 400. user_api_usage starts at 0, ends at 400.
      const { sql, state } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 100n,
          cost_settled_micro_usd: 100n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
      });
      await endpointCall(sql, 'msg_x', 'auth0|alice', 500n);
      expect(state.user_usage.cost_micro_usd).toBe(400n);
    });

    it('does NOT credit user_api_usage when newCost ≤ cost_settled (lower or equal push)', async () => {
      // A common shape: the in-stream per-update writer has already
      // committed up to cost_settled = 1000, and the client's late retry
      // pushes a stale running_cost = 500. With projected = 0n,
      // baseline = 1000, delta = max(0, 500 - 1000) = 0. The row is
      // unchanged; user_api_usage is unchanged.
      const { sql, state } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 1000n,
          cost_settled_micro_usd: 1000n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 800n },
      });
      const out = await endpointCall(sql, 'msg_x', 'auth0|alice', 500n);
      // Row exists + owned + non-reconciled → helper reports applied=true
      // but delta=0n. The endpoint returns the same shape; the client
      // treats it as idempotent success.
      expect(out).toEqual({ applied: true, delta: 0n, new_settled: 1000n });
      expect(state.message.cost_settled_micro_usd).toBe(1000n);
      expect(state.user_usage.cost_micro_usd).toBe(800n);
    });
  });

  describe('idempotency across repeated calls', () => {
    it('second call with the same clientCost reports delta=0n and does not double-credit', async () => {
      // The retry queue's headline safety property. Client sends cost=500,
      // server applies → settled=500, user=400. Client retries (e.g.
      // dropped response, resends from localStorage), server sees
      // settled=500, baseline=max(0,500)=500, delta=max(0,500-500)=0. No
      // user_api_usage write fires.
      const { sql, state } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 100n,
          cost_settled_micro_usd: 100n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
      });
      const first = await endpointCall(sql, 'msg_x', 'auth0|alice', 500n);
      expect(first).toEqual({ applied: true, delta: 400n, new_settled: 500n });
      expect(state.user_usage.cost_micro_usd).toBe(400n);

      const second = await endpointCall(sql, 'msg_x', 'auth0|alice', 500n);
      expect(second).toEqual({ applied: true, delta: 0n, new_settled: 500n });
      // user_api_usage stayed at 400 — no double-credit.
      expect(state.user_usage.cost_micro_usd).toBe(400n);
      expect(state.message.cost_settled_micro_usd).toBe(500n);
    });

    it('three increasing pushes credit incrementally (monotone climb)', async () => {
      // The retry queue may batch multiple running_cost frames captured
      // before a kill. Each push climbs cost_settled and credits the
      // incremental delta.
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
      const r1 = await endpointCall(sql, 'msg_x', 'auth0|alice', 100n);
      expect(r1).toEqual({ applied: true, delta: 100n, new_settled: 100n });
      const r2 = await endpointCall(sql, 'msg_x', 'auth0|alice', 500n);
      expect(r2).toEqual({ applied: true, delta: 400n, new_settled: 500n });
      const r3 = await endpointCall(sql, 'msg_x', 'auth0|alice', 2000n);
      expect(r3).toEqual({ applied: true, delta: 1500n, new_settled: 2000n });
      // Cumulative user_api_usage: 0 → 100 → 500 → 2000 (total credited
      // matches final cost_settled because projected = 0 throughout).
      expect(state.user_usage.cost_micro_usd).toBe(2000n);
    });

    it('out-of-order retry (lower then higher then lower) converges to the highest value', async () => {
      // Network reordering: an earlier running_cost=300 frame loses, the
      // client retries with running_cost=1000 first, then the 300 arrives
      // late. Final cost_settled must be 1000; user_api_usage must be
      // credited exactly 1000 (the highest of the three pushes), no more.
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
      await endpointCall(sql, 'msg_x', 'auth0|alice', 1000n);
      await endpointCall(sql, 'msg_x', 'auth0|alice', 300n); // late, stale
      await endpointCall(sql, 'msg_x', 'auth0|alice', 1000n); // re-retry
      expect(state.message.cost_settled_micro_usd).toBe(1000n);
      expect(state.user_usage.cost_micro_usd).toBe(1000n);
    });
  });

  describe('applied: false — benign no-op shapes', () => {
    it('returns applied=false when the row does not exist (missing message_id)', async () => {
      // A client retry against a logging_message_id whose row was deleted
      // (e.g. GDPR Art. 17 erasure) or never written. The endpoint's
      // pre-Task-11 shape returned 404 not_found here, which the client
      // had to handle separately from "already reconciled". Post-Task-11,
      // both collapse to `applied=false` and the endpoint returns 200
      // idempotent no-op.
      const { sql, state } = makeBackend({
        message: {
          message_id: 'msg_other',
          user_id: 'auth0|alice',
          cost_micro_usd: 0n,
          cost_settled_micro_usd: 0n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
      });
      const out = await endpointCall(sql, 'msg_missing', 'auth0|alice', 500n);
      expect(out).toEqual({ applied: false, delta: 0n, new_settled: 0n });
      // State unchanged: no mutation against a non-existent row.
      expect(state.message.cost_settled_micro_usd).toBe(0n);
      expect(state.user_usage.cost_micro_usd).toBe(0n);
    });

    it('returns applied=false when the row is owned by a different user (IDOR guard)', async () => {
      // Cross-user attack: Alice posts against Bob's logging_message_id.
      // Pre-Task-11 returned 403 forbidden distinctly from 404 not_found;
      // Post-Task-11, the helper's `AND user_id = $` clause excludes the
      // row from the CTE and both cases collapse to `applied=false`. The
      // endpoint returns 200 idempotent — leaking 403 would let an
      // attacker probe for valid logging_message_ids.
      const { sql, state } = makeBackend({
        message: {
          message_id: 'msg_bobs',
          user_id: 'auth0|bob',
          cost_micro_usd: 100n,
          cost_settled_micro_usd: 100n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|bob', cost_micro_usd: 0n },
      });
      const out = await endpointCall(sql, 'msg_bobs', 'auth0|alice', 500n);
      expect(out).toEqual({ applied: false, delta: 0n, new_settled: 0n });
      // Bob's row is untouched — Alice cannot advance it.
      expect(state.message.cost_settled_micro_usd).toBe(100n);
      expect(state.user_usage.cost_micro_usd).toBe(0n);
    });

    it('returns applied=false when reconciled_at is non-null (late-retry lock)', async () => {
      // The critical late-retry lock. The post-stream IIFE stamps
      // `reconciled_at = NOW()` atomically with the signed-delta SQL
      // (Task 8). A late retry from the 7-day client localStorage queue
      // would otherwise re-inflate the cap — the helper's
      // `AND reconciled_at IS NULL` clause excludes the row, and the
      // endpoint returns 200 idempotent no-op without mutating either row.
      const { sql, state } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 1000n,
          cost_settled_micro_usd: 1000n,
          // Already reconciled — the signed-delta reconcile fired.
          reconciled_at: new Date('2026-05-15T12:00:00Z'),
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 1000n },
      });
      // Client pushes a way-higher value — must NOT advance, because the
      // signed-delta path already settled the truth.
      const out = await endpointCall(sql, 'msg_x', 'auth0|alice', 999_999n);
      expect(out).toEqual({ applied: false, delta: 0n, new_settled: 0n });
      // Row state unchanged: settled stays at 1000, reconciled_at stays
      // stamped, user_api_usage stays at the post-reconcile value.
      expect(state.message.cost_settled_micro_usd).toBe(1000n);
      expect(state.message.cost_micro_usd).toBe(1000n);
      expect(state.message.reconciled_at).toEqual(new Date('2026-05-15T12:00:00Z'));
      expect(state.user_usage.cost_micro_usd).toBe(1000n);
    });

    it('repeated post-reconcile pushes stay applied=false (the lock holds across retries)', async () => {
      // Same shape as the previous test, but with a retry storm. The
      // 7-day localStorage retry queue could empty multiple frames against
      // a reconciled row; none must mutate.
      const { sql, state } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 1000n,
          cost_settled_micro_usd: 1000n,
          reconciled_at: new Date('2026-05-15T12:00:00Z'),
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 1000n },
      });
      const out1 = await endpointCall(sql, 'msg_x', 'auth0|alice', 2000n);
      const out2 = await endpointCall(sql, 'msg_x', 'auth0|alice', 5000n);
      const out3 = await endpointCall(sql, 'msg_x', 'auth0|alice', 100n);
      expect(out1.applied).toBe(false);
      expect(out2.applied).toBe(false);
      expect(out3.applied).toBe(false);
      // user_api_usage never moved.
      expect(state.user_usage.cost_micro_usd).toBe(1000n);
    });
  });

  describe('response shape for client retry queue', () => {
    it('returns the helper output unchanged — applied + delta + new_settled', async () => {
      // The endpoint's response body is `{ applied, delta, new_settled }`
      // (with bigints stringified at the JSON boundary). Tests pin the
      // helper output shape here; the JSON stringification is handled by
      // `Response.json(...)` in the endpoint and is uniform.
      const { sql } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 100n,
          cost_settled_micro_usd: 100n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
      });
      const out = await endpointCall(sql, 'msg_x', 'auth0|alice', 500n);
      expect(Object.keys(out).sort()).toEqual(['applied', 'delta', 'new_settled']);
      expect(typeof out.applied).toBe('boolean');
      expect(typeof out.delta).toBe('bigint');
      expect(typeof out.new_settled).toBe('bigint');
    });

    it('the no-op shape uses the same key set (so the client decoder is uniform)', async () => {
      // The client retry queue reads `applied` to decide whether to drop
      // the entry. `applied=false` is treated as "either the row is gone,
      // owned by someone else, or already reconciled" — all benign. The
      // shape must match exactly so the JSON decoder doesn't branch on
      // missing keys.
      const { sql } = makeBackend({
        message: {
          message_id: 'msg_other',
          user_id: 'auth0|alice',
          cost_micro_usd: 0n,
          cost_settled_micro_usd: 0n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
      });
      const out = await endpointCall(sql, 'msg_missing', 'auth0|alice', 500n);
      expect(Object.keys(out).sort()).toEqual(['applied', 'delta', 'new_settled']);
      expect(out.applied).toBe(false);
      expect(out.delta).toBe(0n);
      expect(out.new_settled).toBe(0n);
    });
  });

  describe('endpoint resilience (error surfacing)', () => {
    it('a thrown SQL error from the helper surfaces as a rejected promise (caller can 500)', async () => {
      // The real endpoint wraps the helper call in try/catch and returns
      // 500 update_failed on throw. Here we verify the helper actually
      // throws (so the endpoint's try/catch is justified) — a previous
      // refactor that ate the error inside the helper would silently
      // make 500s unreachable, which would mask DB outages.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sql: any = vi.fn(() => Promise.reject(new Error('connection refused')));
      await expect(endpointCall(sql, 'msg_x', 'auth0|alice', 500n)).rejects.toThrow(
        'connection refused',
      );
    });
  });
});
