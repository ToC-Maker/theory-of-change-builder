// End-to-end seam tests for `POST /api/reconcile-cost`.
//
// An earlier shape of this endpoint inlined an `UPDATE logging_messages`
// and a JS-side ownership check; both were replaced by a call to the
// shared `applyDeltaCommit` helper. The helper atomically:
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
//     decision: the endpoint runs in a fresh Worker invocation with no
//     reservation context, and the helper's `max(projected, cost_settled)`
//     baseline correctly degenerates to `cost_settled` (which already
//     incorporates the reservation via earlier mid-stream / message_start /
//     abort-handler writers).
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
import { makeBackend } from '../_shared/in-memory-cost-backend';
// Raw source import — used by the Finding C structural pin to assert the
// production catch block in `/api/reconcile-cost` writes a
// `DiagnosticReconcileEndpointFailed` row before returning 500. Same
// pattern as `cost-commit-sql-invariants.test.ts` and the Finding A
// pins in `iife-death-recovery.test.ts`: pulls file bytes without
// evaluating the module (the handler depends on Workers globals the
// test runtime doesn't have).
import reconcileCostSource from '../../worker/api/reconcile-cost.ts?raw';

// In-memory backend lives in `tests/_shared/in-memory-cost-backend.ts`.
// This file pins the endpoint-specific contract on top of the shared
// algebra — `callCount` and `capturedValues` from the backend let us
// assert the exact leading-argument shape `/api/reconcile-cost` passes
// to `applyDeltaCommit` (in particular: projected = 0n).

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
  // BYOK routing flag (default false). The endpoint resolves this from
  // the actor's stored BYOK key at request time (see
  // `worker/api/reconcile-cost.ts`); tests pass it explicitly to pin the
  // routing into either cost_micro_usd (free) or byok_cost_micro_usd (BYOK).
  isByok: boolean = false,
): ReturnType<typeof applyDeltaCommit> {
  // projected = 0n: see file-header rationale (the endpoint runs in a
  // fresh Worker invocation with no reservation context, so the helper's
  // baseline degenerates to `cost_settled`).
  return applyDeltaCommit(sql, loggingMessageId, actorId, 0n, clientCost, isByok);
}

// ---------------------------------------------------------------------------
// Extended endpoint mirror: applyDeltaCommit + read-back SELECT + response
// build. Mirrors the handler's full sequence so the new response fields
// (`cost_settled_micro_usd` + `reconciled`) can be pinned in isolation.
//
// The handler reads the current row state AFTER applyDeltaCommit regardless
// of `applied`, so a client polling the endpoint can observe the
// post-stream IIFE's signed-delta updates by watching `reconciled:true`.
// `applied=false` collapses three cases (row missing, foreign, already
// reconciled) into a uniform shape from the helper; the SELECT
// disambiguates them via `cost_settled_micro_usd` (any value) +
// `reconciled` (true if reconciled_at IS NOT NULL).
//
// IF YOU CHANGE THIS WRAPPER, also change the post-applyDeltaCommit SELECT
// + response build in `worker/api/reconcile-cost.ts` — the two must agree.
// ---------------------------------------------------------------------------
type ReconcileResponseJson = {
  applied: boolean;
  delta: string;
  new_settled: string;
  cost_settled_micro_usd: string;
  reconciled: boolean;
};

async function endpointCallFull(
  sql: NeonQueryFunction<false, false>,
  loggingMessageId: string,
  actorId: string,
  clientCost: bigint,
  isByok: boolean = false,
): Promise<ReconcileResponseJson> {
  const out = await applyDeltaCommit(sql, loggingMessageId, actorId, 0n, clientCost, isByok);
  // SELECT the current state regardless of whether applyDeltaCommit
  // mutated. Lets the client distinguish "row missing" / "already
  // reconciled" / "applied" from a single response.
  const stateRows = (await sql`
    SELECT cost_settled_micro_usd, (reconciled_at IS NOT NULL) AS reconciled
    FROM logging_messages
    WHERE message_id = ${loggingMessageId} AND user_id = ${actorId}
  `) as { cost_settled_micro_usd: bigint | string | null; reconciled: boolean }[];
  const currentSettledRaw = stateRows.length > 0 ? stateRows[0].cost_settled_micro_usd : null;
  const currentSettled =
    currentSettledRaw === null || currentSettledRaw === undefined
      ? 0n
      : typeof currentSettledRaw === 'bigint'
        ? currentSettledRaw
        : BigInt(currentSettledRaw);
  const reconciled = stateRows.length > 0 ? stateRows[0].reconciled : false;
  return {
    applied: out.applied,
    delta: out.delta.toString(),
    new_settled: out.new_settled.toString(),
    cost_settled_micro_usd: currentSettled.toString(),
    reconciled,
  };
}

describe('/api/reconcile-cost uses applyDeltaCommit (end-to-end seam)', () => {
  describe('argument shape', () => {
    it('passes projected = 0n so the baseline degenerates to cost_settled', async () => {
      // The headline contract pin for the endpoint: it must call
      // `applyDeltaCommit` with `projected = 0n`. The endpoint runs in a
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
      // An earlier shape of this endpoint inlined an `UPDATE
      // logging_messages SET cost_micro_usd = GREATEST(...)` that touched
      // ONLY `cost_micro_usd`, leaving `cost_settled_micro_usd` stuck at
      // whatever the in-stream writers wrote. That left the post-stream
      // reconcile's baseline (`max(projected, cost_settled)`) below the
      // actual settle, and the per-user cap could under-credit. The
      // current `applyDeltaCommit` helper advances BOTH columns
      // atomically — pin that both moved.
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
      expect(state.message?.cost_micro_usd).toBe(500n);
      expect(state.message?.cost_settled_micro_usd).toBe(500n);
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
      expect(state.message?.cost_settled_micro_usd).toBe(1000n);
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
      expect(state.message?.cost_settled_micro_usd).toBe(500n);
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
      expect(state.message?.cost_settled_micro_usd).toBe(1000n);
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
      expect(out).toEqual({
        applied: false,
        reason: 'row_not_found_or_foreign_or_reconciled',
        delta: 0n,
        new_settled: 0n,
      });
      // State unchanged: no mutation against a non-existent row.
      expect(state.message?.cost_settled_micro_usd).toBe(0n);
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
      expect(out).toEqual({
        applied: false,
        reason: 'row_not_found_or_foreign_or_reconciled',
        delta: 0n,
        new_settled: 0n,
      });
      // Bob's row is untouched — Alice cannot advance it.
      expect(state.message?.cost_settled_micro_usd).toBe(100n);
      expect(state.user_usage.cost_micro_usd).toBe(0n);
    });

    it('returns applied=false when reconciled_at is non-null (late-retry lock)', async () => {
      // The critical late-retry lock. The post-stream reconcile IIFE
      // stamps `reconciled_at = NOW()` atomically with the signed-delta
      // SQL. A late retry from the 7-day client localStorage queue
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
      expect(out).toEqual({
        applied: false,
        reason: 'row_not_found_or_foreign_or_reconciled',
        delta: 0n,
        new_settled: 0n,
      });
      // Row state unchanged: settled stays at 1000, reconciled_at stays
      // stamped, user_api_usage stays at the post-reconcile value.
      expect(state.message?.cost_settled_micro_usd).toBe(1000n);
      expect(state.message?.cost_micro_usd).toBe(1000n);
      expect(state.message?.reconciled_at).toEqual(new Date('2026-05-15T12:00:00Z'));
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
    it('happy path returns { applied, delta, new_settled }', async () => {
      // The endpoint's response body is `{ applied, delta, new_settled }`
      // on the happy path (with bigints stringified at the JSON boundary).
      // Tests pin the helper output shape here; the JSON stringification
      // is handled by `Response.json(...)` in the endpoint and is uniform.
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

    it('no-op shape carries the reason discriminator alongside applied/delta/new_settled', async () => {
      // The client retry queue reads `applied` to decide whether to drop
      // the entry — `applied=false` is treated as "either the row is gone,
      // owned by someone else, or already reconciled" (all benign). The
      // `reason` discriminator adds a fourth key on the no-op arm so the
      // server-side diagnostic + analytics can distinguish the no-SQL
      // fast-path (`missing_id`) from the SQL-ran-but-empty case
      // (`row_not_found_or_foreign_or_reconciled`). The client decoder
      // ignores `reason` — it only branches on `applied` — so the extra
      // key is purely server-side observability.
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
      expect(Object.keys(out).sort()).toEqual(['applied', 'delta', 'new_settled', 'reason']);
      expect(out.applied).toBe(false);
      expect(out.delta).toBe(0n);
      expect(out.new_settled).toBe(0n);
      if (!out.applied) {
        // SQL-ran-empty bucket — the endpoint is called with a real
        // (non-empty) loggingMessageId, so the missing_id fast-path is
        // unreachable from here.
        expect(out.reason).toBe('row_not_found_or_foreign_or_reconciled');
      }
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

  // ---------------------------------------------------------------------
  // Finding C: catch block on applyDeltaCommit must writeDiagnostic
  // before returning 500.
  //
  // Pre-fix: the catch around `applyDeltaCommit` in
  // `worker/api/reconcile-cost.ts` only `console.error`ed and returned
  // 500 — asymmetric with every analogous in-stream reconcile path
  // (which all `writeDiagnostic` on failure). A DB outage during the
  // helper call left only a `wrangler tail` log, not a queryable
  // `logging_errors` row, so post-mortem from the DB was blind.
  //
  // Post-fix: catch must call `writeDiagnostic` with
  // `error_name: 'DiagnosticReconcileEndpointFailed'` and metadata that
  // mirrors the success-path `DiagnosticReconcileEndpointHit` row's
  // shape (so analytics can JOIN/UNION across both event names by
  // `logging_message_id`).
  //
  // Same structural-pin approach as Finding A: the production handler
  // isn't easily testable without booting Workers (auth, anon cookie,
  // DB binding), so the test asserts the production source contains the
  // load-bearing tokens. Each landmark was confirmed to fail loudly
  // when the corresponding source was temporarily reverted (recorded
  // 2026-05-17 — revert before committing the regression verification).
  // ---------------------------------------------------------------------
  describe('Finding C: catch block writes DiagnosticReconcileEndpointFailed before returning 500', () => {
    it('catch block calls writeDiagnostic with DiagnosticReconcileEndpointFailed', () => {
      // The exact error_name matters: dashboards/queries that union on
      // event names need to key off this string. A rename would break
      // them silently if we didn't pin it here.
      expect(reconcileCostSource).toMatch(
        /error_name:\s*['"]DiagnosticReconcileEndpointFailed['"]/,
      );
    });

    it('writeDiagnostic appears BEFORE the 500 response in the catch block', () => {
      // Ordering matters: returning 500 without first emitting the
      // diagnostic would re-introduce the bug. Scope the regex to the
      // catch block by anchoring on `console.error.*applyDeltaCommit`
      // and asserting writeDiagnostic appears before the
      // `return Response.json` with status 500.
      //
      // The slice spans from the console.error landmark through the
      // 500 return — must include the writeDiagnostic call in between.
      const catchSlice =
        /console\.error\(['"]\[reconcile-cost\][\s\S]{0,2000}?return\s+Response\.json\(\s*\{\s*error:\s*['"]update_failed['"]\s*\}\s*,\s*\{\s*status:\s*500\s*\}/.exec(
          reconcileCostSource,
        );
      expect(catchSlice).not.toBeNull();
      const slice = catchSlice![0];
      // The diagnostic write must appear inside this slice (between the
      // console.error log and the 500 return). If it doesn't, either
      // the diagnostic was dropped or the ordering was swapped — both
      // would silently regress the fix.
      expect(slice).toMatch(/await\s+writeDiagnostic\(/);
      expect(slice).toMatch(/DiagnosticReconcileEndpointFailed/);
    });

    it('diagnostic metadata carries logging_message_id, authenticated, is_byok, and client cost', () => {
      // Match the success-path `DiagnosticReconcileEndpointHit` row's
      // shape — analytics depend on a uniform metadata schema across
      // both event names so JOIN/UNION queries don't have to special-case.
      const diagSlice =
        /error_name:\s*['"]DiagnosticReconcileEndpointFailed['"][\s\S]{0,2000}/.exec(
          reconcileCostSource,
        );
      expect(diagSlice).not.toBeNull();
      const slice = diagSlice![0];
      expect(slice).toMatch(/logging_message_id/);
      expect(slice).toMatch(/authenticated/);
      expect(slice).toMatch(/is_byok/);
      expect(slice).toMatch(/client_cost_micro_usd/);
    });

    it('diagnostic metadata captures the error message (for replay / debugging)', () => {
      // The error message is the single most useful field for diagnosing
      // why applyDeltaCommit threw (connection refused, lock timeout, etc.).
      // Pin that it lands in the metadata so the failure surface is
      // queryable end-to-end from the DB.
      const diagSlice =
        /error_name:\s*['"]DiagnosticReconcileEndpointFailed['"][\s\S]{0,2000}/.exec(
          reconcileCostSource,
        );
      expect(diagSlice).not.toBeNull();
      const slice = diagSlice![0];
      expect(slice).toMatch(/error_message/);
    });
  });

  describe('BYOK routing (regression fix 2026-05-17)', () => {
    // The endpoint resolves `isByok` from whether the actor has a stored
    // BYOK key (see worker/api/reconcile-cost.ts step 2.5). These tests
    // pin the routing at the `applyDeltaCommit` boundary: when `isByok=true`
    // is threaded through, the delta lands in `byok_cost_micro_usd` and
    // the free-cap column `cost_micro_usd` is left untouched.
    //
    // Headline invariant: a user with $4.50 of pre-existing free spend
    // who then issues a BYOK reconcile must not see their free cap
    // depleted. Pre-fix this exact scenario was the Critical regression:
    // `cost_micro_usd + projected <= LIFETIME_CAP_MICRO_USD` would fail
    // after BYOK spend pushed the column past $5.
    it('isByok=true: credits byok_cost_micro_usd, leaves cost_micro_usd untouched (cap preserved)', async () => {
      const { sql, state } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 0n,
          cost_settled_micro_usd: 0n,
          reconciled_at: null,
        },
        // Pre-existing free spend: $4.50 of the $5 free cap already used.
        user_usage: {
          user_id: 'auth0|alice',
          cost_micro_usd: 4_500_000n,
          byok_cost_micro_usd: 0n,
        },
      });
      // BYOK push of $2.00 worth of running cost.
      const out = await endpointCall(sql, 'msg_x', 'auth0|alice', 2_000_000n, true);
      expect(out).toEqual({ applied: true, delta: 2_000_000n, new_settled: 2_000_000n });
      // Free cap UNCHANGED — user can still spend their remaining $0.50.
      expect(state.user_usage.cost_micro_usd).toBe(4_500_000n);
      // BYOK column carries the new spend.
      expect(state.user_usage.byok_cost_micro_usd).toBe(2_000_000n);
      // logging_messages.cost_settled_micro_usd still records the truth
      // regardless of routing (it's the per-message attribution key).
      expect(state.message?.cost_settled_micro_usd).toBe(2_000_000n);
    });

    it('isByok=false: credits cost_micro_usd (default behavior, BYOK column untouched)', async () => {
      // The pre-fix behavior, now made explicit via the `isByok` flag.
      // Confirms the routing genuinely diverges based on the flag.
      const { sql, state } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 0n,
          cost_settled_micro_usd: 0n,
          reconciled_at: null,
        },
        user_usage: {
          user_id: 'auth0|alice',
          cost_micro_usd: 0n,
          byok_cost_micro_usd: 100n, // pre-existing BYOK spend; should stay
        },
      });
      const out = await endpointCall(sql, 'msg_x', 'auth0|alice', 500n, false);
      expect(out).toEqual({ applied: true, delta: 500n, new_settled: 500n });
      // Free cap column got the credit.
      expect(state.user_usage.cost_micro_usd).toBe(500n);
      // BYOK column unchanged.
      expect(state.user_usage.byok_cost_micro_usd).toBe(100n);
    });
  });

  // ---------------------------------------------------------------------
  // Polling-friendly response: cost_settled_micro_usd + reconciled
  //
  // The endpoint extends its response with two new fields so the client
  // can poll until the post-stream IIFE has stamped `reconciled_at`. The
  // helper's `new_settled` is `0n` when `applied=false` (the CTE's
  // RETURNING is empty when `WHERE reconciled_at IS NULL` excludes the
  // row), so the client previously couldn't distinguish "row missing"
  // from "already reconciled" from the response. A second SELECT after
  // the applyDeltaCommit call reads the actual current state:
  //
  //   - `cost_settled_micro_usd`: the live `cost_settled_micro_usd`
  //     column value (post-IIFE if it ran, post-applyDeltaCommit
  //     otherwise). Stringified bigint, matches the wire convention.
  //   - `reconciled`: true iff `reconciled_at IS NOT NULL`. The client
  //     polls until this flips to true, then reads
  //     `cost_settled_micro_usd` for the final settled value.
  //
  // Edge cases collapse to a uniform shape:
  //   - Row missing (SELECT returns no rows) → "0" + false → client
  //     keeps polling because the row may land later.
  //   - Ownership mismatch (SELECT's `AND user_id = ${actor}` excludes)
  //     → "0" + false → same shape as row-missing. Idempotent-no-op
  //     security model: the endpoint never distinguishes "yours and
  //     not-found" from "not yours" (see the file-header rationale on
  //     200 idempotent no-op for the u2-silent finding).
  //   - applied=false + reconciled=true → final settled value already
  //     in `cost_settled_micro_usd`; client should stop polling.
  //
  // Test seam: these tests use `endpointCallFull` (defined above), which
  // mirrors the handler's exact post-applyDeltaCommit SELECT. The
  // in-memory backend dispatches the SELECT pattern to a separate branch
  // that reads `state.message` directly (no mutex needed — read-only,
  // and the JS event loop already serialises with any concurrent
  // applyDeltaCommit calls that share the same backend instance).
  // ---------------------------------------------------------------------
  describe('response includes cost_settled_micro_usd + reconciled (polling support)', () => {
    it('applied=true: cost_settled_micro_usd matches new_settled, reconciled=false', async () => {
      // Happy path — applyDeltaCommit advanced the row, the SELECT reads
      // the updated value (because the in-memory backend's SELECT branch
      // reads `state.message` post-mutation), and reconciled is still
      // false (this endpoint never stamps reconciled_at — only the
      // post-stream IIFE does).
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
      const out = await endpointCallFull(sql, 'msg_x', 'auth0|alice', 500n);
      expect(out).toEqual({
        applied: true,
        delta: '400',
        new_settled: '500',
        cost_settled_micro_usd: '500',
        reconciled: false,
      });
    });

    it('applied=false + already-reconciled: SELECT exposes the IIFE-settled value with reconciled=true', async () => {
      // The headline use case for the new fields. The post-stream IIFE
      // has already stamped reconciled_at and committed the final settle
      // (e.g. 1234µUSD). A late client retry pushes its running_cost
      // (could be lower or higher than the IIFE value). applyDeltaCommit
      // returns applied=false + new_settled=0 (the CTE's WHERE clause
      // excluded the reconciled row), so without the SELECT the client
      // would see "0" and never know the actual value. With the SELECT,
      // the response carries cost_settled_micro_usd='1234' + reconciled=true,
      // and the client can stop polling + render the final value.
      const { sql } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 1234n,
          cost_settled_micro_usd: 1234n,
          reconciled_at: new Date('2026-05-18T12:00:00Z'),
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 1234n },
      });
      const out = await endpointCallFull(sql, 'msg_x', 'auth0|alice', 999n);
      expect(out.applied).toBe(false);
      // Helper returned the CTE-empty shape, so these two are zero.
      expect(out.new_settled).toBe('0');
      expect(out.delta).toBe('0');
      // The new fields disambiguate: the row IS reconciled, the actual
      // settled value is 1234µUSD.
      expect(out.cost_settled_micro_usd).toBe('1234');
      expect(out.reconciled).toBe(true);
    });

    it('applied=false + row-missing: cost_settled_micro_usd="0", reconciled=false (client keeps polling)', async () => {
      // The row hasn't been written yet (race with loggingService.saveMessage).
      // The SELECT returns no rows; we map to cost_settled_micro_usd="0"
      // + reconciled=false so the client keeps polling. Eventually the
      // row lands and the client gets a real value.
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
      const out = await endpointCallFull(sql, 'msg_missing', 'auth0|alice', 500n);
      expect(out.applied).toBe(false);
      expect(out.cost_settled_micro_usd).toBe('0');
      expect(out.reconciled).toBe(false);
    });

    it('applied=false + ownership mismatch: same uniform "0" + false shape (no 403 leak)', async () => {
      // Same response shape as row-missing — the SELECT's `AND user_id =
      // ${actor}` excludes Bob's row from Alice's request. Idempotent
      // no-op rather than 403; an attacker can't probe for valid
      // logging_message_ids by toggling the response shape.
      const { sql } = makeBackend({
        message: {
          message_id: 'msg_bobs',
          user_id: 'auth0|bob',
          cost_micro_usd: 100n,
          cost_settled_micro_usd: 100n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|bob', cost_micro_usd: 0n },
      });
      const out = await endpointCallFull(sql, 'msg_bobs', 'auth0|alice', 500n);
      expect(out.applied).toBe(false);
      expect(out.cost_settled_micro_usd).toBe('0');
      expect(out.reconciled).toBe(false);
    });

    it('applied=true + not-yet-reconciled: SELECT reads the freshly-bumped value', async () => {
      // Sanity check that the SELECT runs AFTER applyDeltaCommit
      // (otherwise it'd read the pre-mutation value). With initial
      // settled=100 and a push of 800, the SELECT must report 800,
      // not 100 — confirming the order-of-operations contract.
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
      const out = await endpointCallFull(sql, 'msg_x', 'auth0|alice', 800n);
      expect(out.applied).toBe(true);
      expect(out.cost_settled_micro_usd).toBe('800');
      expect(out.reconciled).toBe(false);
    });

    it('response includes the existing applied + delta + new_settled fields (no regression)', async () => {
      // Belt-and-braces: the new fields must not displace the existing
      // ones. Pin the full key set so any future refactor that drops a
      // legacy field fails loudly here.
      const { sql } = makeBackend({
        message: {
          message_id: 'msg_x',
          user_id: 'auth0|alice',
          cost_micro_usd: 0n,
          cost_settled_micro_usd: 0n,
          reconciled_at: null,
        },
        user_usage: { user_id: 'auth0|alice', cost_micro_usd: 0n },
      });
      const out = await endpointCallFull(sql, 'msg_x', 'auth0|alice', 100n);
      expect(Object.keys(out).sort()).toEqual([
        'applied',
        'cost_settled_micro_usd',
        'delta',
        'new_settled',
        'reconciled',
      ]);
    });
  });

  // ---------------------------------------------------------------------
  // Structural pins: production source has the new SELECT + response
  // fields + diagnostic-metadata updates. Same approach as Finding C
  // above — the production handler isn't easily testable without booting
  // Workers (auth, anon cookie, DB binding), so we assert the production
  // source contains the load-bearing tokens.
  // ---------------------------------------------------------------------
  describe('production source: SELECT after applyDeltaCommit + new response fields', () => {
    it('source contains a SELECT reading cost_settled_micro_usd + reconciled_at IS NOT NULL', () => {
      // The SELECT shape pins the contract: it reads the column we need
      // for the pill display AND the reconciled flag. A regression that
      // dropped the SELECT (e.g. someone "simplifying" the response build)
      // would re-introduce the bug where the client can't observe the
      // post-stream IIFE's settled value.
      expect(reconcileCostSource).toMatch(/SELECT\s+cost_settled_micro_usd/);
      expect(reconcileCostSource).toMatch(
        /\(\s*reconciled_at\s+IS\s+NOT\s+NULL\s*\)\s+AS\s+reconciled/,
      );
    });

    it('SELECT is scoped by user_id (IDOR-safe; uniform with the helper)', () => {
      // The SELECT must NOT leak cost data for a foreign message_id —
      // its WHERE clause includes `AND user_id = ${actorId}` (mirroring
      // applyDeltaCommit's ownership guard). If the SELECT ever dropped
      // the user_id filter, the endpoint would become a probing oracle.
      const selectSlice =
        /SELECT\s+cost_settled_micro_usd[\s\S]{0,500}?WHERE[\s\S]{0,500}?AND\s+user_id\s*=/.exec(
          reconcileCostSource,
        );
      expect(selectSlice).not.toBeNull();
    });

    it('response body includes cost_settled_micro_usd + reconciled keys', () => {
      // The final return Response.json(...) must carry both new keys.
      // Regex anchors on `applied: out.applied` — the unique opener of
      // the final response object — to disambiguate from earlier error
      // returns (e.g. 503 auth_service_unavailable) that match the
      // generic `return Response.json(` prefix.
      const responseSlice =
        /Response\.json\(\s*\{\s*applied:\s*out\.applied[\s\S]{0,800}?\}\s*\)/.exec(
          reconcileCostSource,
        );
      expect(responseSlice).not.toBeNull();
      const slice = responseSlice![0];
      expect(slice).toMatch(/cost_settled_micro_usd:/);
      expect(slice).toMatch(/reconciled[,:]/);
    });

    it('existing response fields (applied, delta, new_settled) remain in the body (no regression)', () => {
      // Belt-and-braces against a refactor that replaced the legacy
      // fields instead of adding alongside.
      const responseSlice =
        /Response\.json\(\s*\{\s*applied:\s*out\.applied[\s\S]{0,800}?\}\s*\)/.exec(
          reconcileCostSource,
        );
      expect(responseSlice).not.toBeNull();
      const slice = responseSlice![0];
      expect(slice).toMatch(/applied:/);
      expect(slice).toMatch(/delta:/);
      expect(slice).toMatch(/new_settled:/);
    });

    it('DiagnosticReconcileEndpointHit metadata includes current_settled + reconciled (audit trail)', () => {
      // The diagnostic row must capture the response audit trail —
      // dashboards keying on `current_settled` + `reconciled` need them
      // in `request_metadata` to track the post-stream IIFE convergence.
      const diagSlice = /error_name:\s*['"]DiagnosticReconcileEndpointHit['"][\s\S]{0,2000}/.exec(
        reconcileCostSource,
      );
      expect(diagSlice).not.toBeNull();
      const slice = diagSlice![0];
      expect(slice).toMatch(/current_settled/);
      expect(slice).toMatch(/reconciled/);
    });
  });
});
