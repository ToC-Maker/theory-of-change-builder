// Tests for `POST /api/reconcile-cost` body validation
// (worker/api/reconcile-cost.ts).
//
// Endpoint architecture (current shape): body parse → `applyDeltaCommit`
// (worker/_shared/cost-commit.ts) → diagnostic. An earlier shape of this
// endpoint inlined an `UPDATE logging_messages` plus a JS-side ownership
// + GREATEST clamp via a `computeReconcileOutcome` helper; both were
// replaced by the shared helper, which bakes ownership (`AND user_id = $`),
// the monotonic clamp (`GREATEST(cost_settled, $)`), and the late-retry
// lock (`AND reconciled_at IS NULL`) into one atomic CTE.
//
// Wire-shape contract:
//  - `cost_micro_usd` is now STRING-ONLY. The previous contract accepted
//    `string | number` "defensively"; the client always sends string
//    (chatCostTracker.ts::maybePostReconcile), and the loose accept-both
//    masked client-side type drift. See `shared/wire-shapes.ts` for the
//    `ReconcileCostRequest` shape.
//  - `logging_message_id` is now validated as a UUID (8-4-4-4-12 hex).
//    Symmetric with `isUuidish` for `x-idempotency-key` in
//    anthropic-stream.ts. Postgres column is UUID-typed so this catches
//    bad shapes at the wire boundary rather than at the DB layer.
//
// What this file covers: the only remaining pure helper —
// `parseReconcileBody`. The body-validation rules don't depend on the DB,
// and a regression in them would silently change error codes the client
// keys off of (`logging_message_id_required`,
// `cost_micro_usd_invalid_integer`, etc.), so we cover them exhaustively
// in isolation here.
//
// What lives elsewhere:
//   - `applyDeltaCommit` itself: `delta-commit.test.ts` (helper unit) and
//     `delta-commit-concurrency.test.ts` (in-memory CTE simulation).
//   - End-to-end seam tests (handler → helper → in-memory rows):
//     `reconcile-cost-delta-commit.test.ts`.
import { describe, expect, it } from 'vitest';
import { parseReconcileBody } from '../../worker/api/reconcile-cost';

// Reusable valid UUID for tests that don't care about ID-shape variation.
// Picking a v4 so it'd survive a future tightening to v4-only.
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('parseReconcileBody', () => {
  describe('valid bodies', () => {
    it('accepts a string cost_micro_usd + UUID logging_message_id (production shape)', () => {
      // The real client sends `cost_micro_usd` as a stringified bigint —
      // running_cost frames carry bigint via SSE, and JSON.stringify(bigint)
      // throws so the client coerces with `String(bigint)`. Tests pin this
      // happy path so a future refactor doesn't accidentally drop string
      // support.
      const result = parseReconcileBody({
        logging_message_id: VALID_UUID,
        cost_micro_usd: '12345',
      });
      expect(result).toEqual({
        ok: true,
        loggingMessageId: VALID_UUID,
        clientCost: 12345n,
      });
    });

    it('accepts cost_micro_usd = "0" (no-op reconcile after a kill)', () => {
      // A killed stream may have only emitted message_start before the kill;
      // the running_cost the client tracked could legitimately be 0. The
      // server-side floor still wins via GREATEST, so accepting 0 here is
      // a no-op but valid input — rejecting would mean silently dropping
      // these reconciles client-side.
      const r = parseReconcileBody({ logging_message_id: VALID_UUID, cost_micro_usd: '0' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.clientCost).toBe(0n);
    });

    it('accepts large bigint values that exceed Number.MAX_SAFE_INTEGER', () => {
      // 2^60 = 1_152_921_504_606_846_976 — well past 2^53. This is the
      // entire reason the parameter is a bigint and not a number; if a
      // refactor accidentally collapsed it to Number we'd silently lose
      // precision on long-running streams.
      const big = '1152921504606846976';
      const r = parseReconcileBody({ logging_message_id: VALID_UUID, cost_micro_usd: big });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.clientCost).toBe(BigInt(big));
    });

    it('accepts a v1 UUID (schema column is permissive, validator is too)', () => {
      // The Postgres `uuid` column accepts v1-v5 alike; matching that at
      // the validator means a future analytics-side migration to v1
      // wouldn't have to change the wire validator.
      const v1 = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      const r = parseReconcileBody({ logging_message_id: v1, cost_micro_usd: '100' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.loggingMessageId).toBe(v1);
    });
  });

  describe('logging_message_id validation', () => {
    it('rejects missing logging_message_id with 400', () => {
      const r = parseReconcileBody({ cost_micro_usd: '100' });
      expect(r).toEqual({
        ok: false,
        status: 400,
        body: { error: 'logging_message_id_required' },
      });
    });

    it('rejects empty-string logging_message_id with 400', () => {
      const r = parseReconcileBody({ logging_message_id: '', cost_micro_usd: '100' });
      expect(r).toEqual({
        ok: false,
        status: 400,
        body: { error: 'logging_message_id_required' },
      });
    });

    it('rejects non-string logging_message_id with 400', () => {
      // A number `logging_message_id` is the most likely client bug
      // (e.g. forgetting to stringify a row id). Same response as missing.
      const r = parseReconcileBody({ logging_message_id: 42, cost_micro_usd: '100' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.body.error).toBe('logging_message_id_required');
      }
    });

    it('rejects non-UUID-shaped string with logging_message_id_invalid_uuid', () => {
      // Wave 2: validator now requires UUID 8-4-4-4-12. The schema column
      // is UUID-typed; pre-this-fix, a bad shape would pass through to the
      // DB and surface as an opaque "invalid input syntax for type uuid"
      // error. Now it's caught at the wire boundary with a clear code.
      const r = parseReconcileBody({ logging_message_id: 'msg_abc123', cost_micro_usd: '100' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.body.error).toBe('logging_message_id_invalid_uuid');
      }
    });

    it('rejects UUID with wrong dash positions (no dashes)', () => {
      const r = parseReconcileBody({
        logging_message_id: '550e8400e29b41d4a716446655440000',
        cost_micro_usd: '100',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('logging_message_id_invalid_uuid');
    });

    it('rejects UUID with non-hex characters', () => {
      // 'z' is not hex
      const r = parseReconcileBody({
        logging_message_id: '550e8400-e29b-41d4-a716-44665544000z',
        cost_micro_usd: '100',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('logging_message_id_invalid_uuid');
    });

    it('rejects null body with 400', () => {
      const r = parseReconcileBody(null);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    });

    it('rejects non-object body (string, number, array) with 400', () => {
      // Defensive: the handler does `(await request.json())` which can in
      // principle return non-object JSON values. The branches below would
      // crash on `body.logging_message_id` if we treated all of them as
      // objects, so we early-out.
      expect(parseReconcileBody('hello').ok).toBe(false);
      expect(parseReconcileBody(42).ok).toBe(false);
      // Arrays are typeof 'object', so they fall through to the
      // logging_message_id check, which fails because arr.logging_message_id
      // is undefined. Either way: rejected.
      const arrResult = parseReconcileBody([]);
      expect(arrResult.ok).toBe(false);
      if (!arrResult.ok) expect(arrResult.status).toBe(400);
    });
  });

  describe('cost_micro_usd validation', () => {
    it('rejects missing cost_micro_usd with cost_micro_usd_required', () => {
      const r = parseReconcileBody({ logging_message_id: VALID_UUID });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.body.error).toBe('cost_micro_usd_required');
        expect(r.body.detail).toBe('must be a string');
      }
    });

    it('rejects number cost_micro_usd (Wave 2: string-only contract)', () => {
      // The previous contract accepted `string | number` "defensively for
      // forward-compatibility". Wave 2 cross-unit pass tightened this: the
      // client always sends string (chatCostTracker.ts), and accepting
      // number masked client-side type drift. A client mistakenly sending
      // number now fails loudly here rather than silently shipping the
      // wrong shape.
      const r = parseReconcileBody({ logging_message_id: VALID_UUID, cost_micro_usd: 999 });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.body.error).toBe('cost_micro_usd_required');
        expect(r.body.detail).toBe('must be a string');
      }
    });

    it('rejects boolean cost_micro_usd as non-string', () => {
      const r = parseReconcileBody({ logging_message_id: VALID_UUID, cost_micro_usd: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('cost_micro_usd_required');
    });

    it('rejects null cost_micro_usd as non-string', () => {
      const r = parseReconcileBody({ logging_message_id: VALID_UUID, cost_micro_usd: null });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('cost_micro_usd_required');
    });

    it('rejects non-integer string cost_micro_usd with cost_micro_usd_invalid_integer', () => {
      // BigInt('abc') throws SyntaxError. Distinct from "missing" so the
      // client can log the right error class.
      const r = parseReconcileBody({
        logging_message_id: VALID_UUID,
        cost_micro_usd: 'not-a-number',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('cost_micro_usd_invalid_integer');
    });

    it('rejects decimal-string cost_micro_usd with cost_micro_usd_invalid_integer', () => {
      // BigInt('1.5') throws — bigint literal grammar disallows the dot.
      // Floats only round-trip as `number`, not as `string`, by design:
      // a decimal string usually means the client serialized the wrong
      // value (the cost is in *micro*-USD, integer by definition).
      const r = parseReconcileBody({
        logging_message_id: VALID_UUID,
        cost_micro_usd: '1.5',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('cost_micro_usd_invalid_integer');
    });

    it('rejects negative cost_micro_usd from a string', () => {
      // BigInt('-5') succeeds as -5n, then the explicit `< 0n` rejects it.
      // A negative client value would defeat the GREATEST monotonicity
      // guarantee at the SQL layer (GREATEST(prev, -5) is just `prev`,
      // which is fine, but accepting it would let the client mask a real
      // bug — the running_cost frames are always ≥ 0 by construction).
      const r = parseReconcileBody({ logging_message_id: VALID_UUID, cost_micro_usd: '-5' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.body.error).toBe('cost_micro_usd_negative');
      }
    });
  });

  describe('error precedence', () => {
    it('logging_message_id is checked before cost_micro_usd', () => {
      // If both are missing, the user should see logging_message_id_required
      // first — the client typically discovers them in that order while
      // building the request body, and it's a less noisy failure mode.
      const r = parseReconcileBody({});
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('logging_message_id_required');
    });

    it('UUID shape is checked before cost_micro_usd shape (bad ID + bad cost → ID error first)', () => {
      // Same rationale as the "both missing" case: surface the client-side
      // first-noticed error first so debugging stays linear.
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: 999 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('logging_message_id_invalid_uuid');
    });
  });
});

// ---------------------------------------------------------------------------
// Ownership + GREATEST + late-retry coverage moved to:
//   - `delta-commit.test.ts` (helper unit, including the IDOR / row-missing /
//     reconciled-at branches that collapse to `applied: false`).
//   - `delta-commit-concurrency.test.ts` (in-memory CTE simulation pinning
//     the order-independent convergence under concurrent writers).
//   - `reconcile-cost-delta-commit.test.ts` (end-to-end seam: handler call
//     → in-memory backend → both `logging_messages` rows mutated +
//     `user_api_usage` signed delta credited).
// What's left here is just `parseReconcileBody`, the only pure helper the
// endpoint still owns.
//
// TODO: integration tests that need a real Workers runtime + Neon DB
// (mocked JWKS, real-Postgres FOR UPDATE, etc.) — those are tracked in
// the project runbook and live outside this file.
// ---------------------------------------------------------------------------
