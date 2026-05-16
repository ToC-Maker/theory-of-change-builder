// Tests for `POST /api/reconcile-cost` body validation
// (worker/api/reconcile-cost.ts).
//
// Endpoint architecture (post-Task 11): body parse → `applyDeltaCommit`
// (worker/_shared/cost-commit.ts) → diagnostic. The previous endpoint
// inlined an `UPDATE logging_messages` plus a JS-side ownership + GREATEST
// clamp via a `computeReconcileOutcome` helper. Task 11 replaced both with
// the shared helper, which bakes ownership (`AND user_id = $`), the
// monotonic clamp (`GREATEST(cost_settled, $)`), and the late-retry lock
// (`AND reconciled_at IS NULL`) into one atomic CTE.
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

describe('parseReconcileBody', () => {
  describe('valid bodies', () => {
    it('accepts a string cost_micro_usd (the production client encoding)', () => {
      // The real client sends `cost_micro_usd` as a stringified bigint —
      // running_cost frames carry bigint via SSE, and JSON.stringify(bigint)
      // throws so the client coerces with `String(bigint)`. Tests pin this
      // happy path so a future refactor doesn't accidentally drop string
      // support.
      const result = parseReconcileBody({
        logging_message_id: 'msg_abc123',
        cost_micro_usd: '12345',
      });
      expect(result).toEqual({
        ok: true,
        loggingMessageId: 'msg_abc123',
        clientCost: 12345n,
      });
    });

    it('accepts a finite number cost_micro_usd (forward-compat for clients that send Number)', () => {
      const result = parseReconcileBody({
        logging_message_id: 'msg_abc',
        cost_micro_usd: 999,
      });
      expect(result).toEqual({
        ok: true,
        loggingMessageId: 'msg_abc',
        clientCost: 999n,
      });
    });

    it('accepts cost_micro_usd = 0 (no-op reconcile after a kill)', () => {
      // A killed stream may have only emitted message_start before the kill;
      // the running_cost the client tracked could legitimately be 0. The
      // server-side floor still wins via GREATEST, so accepting 0 here is
      // a no-op but valid input — rejecting would mean silently dropping
      // these reconciles client-side.
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: '0' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.clientCost).toBe(0n);
    });

    it('truncates floating-point cost_micro_usd (Math.trunc, not round)', () => {
      // 12.9 must produce 12n, not 13n. A naive Number→BigInt would also
      // throw on non-integers, so the explicit Math.trunc here is the bit
      // we're pinning.
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: 12.9 });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.clientCost).toBe(12n);
    });

    it('accepts large bigint values that exceed Number.MAX_SAFE_INTEGER', () => {
      // 2^60 = 1_152_921_504_606_846_976 — well past 2^53. This is the
      // entire reason the parameter is a bigint and not a number; if a
      // refactor accidentally collapsed it to Number we'd silently lose
      // precision on long-running streams.
      const big = '1152921504606846976';
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: big });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.clientCost).toBe(BigInt(big));
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
      const r = parseReconcileBody({ logging_message_id: 'msg_x' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.body.error).toBe('cost_micro_usd_required');
        expect(r.body.detail).toBe('must be a string or number');
      }
    });

    it('rejects boolean cost_micro_usd as non-numeric', () => {
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: true });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('cost_micro_usd_required');
    });

    it('rejects null cost_micro_usd as non-numeric', () => {
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: null });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('cost_micro_usd_required');
    });

    it('rejects non-finite number cost_micro_usd (NaN)', () => {
      // NaN is `typeof === 'number'` but `Number.isFinite(NaN) === false`.
      // Without the explicit isFinite check, BigInt(NaN) would throw and
      // we'd 400 with cost_micro_usd_invalid_integer instead — same status
      // code but different shape. Pin the chosen shape.
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: NaN });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('cost_micro_usd_required');
    });

    it('rejects non-finite number cost_micro_usd (Infinity)', () => {
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: Infinity });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('cost_micro_usd_required');
    });

    it('rejects non-integer string cost_micro_usd with cost_micro_usd_invalid_integer', () => {
      // BigInt('abc') throws SyntaxError. Distinct from "missing" so the
      // client can log the right error class.
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: 'not-a-number' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('cost_micro_usd_invalid_integer');
    });

    it('rejects decimal-string cost_micro_usd with cost_micro_usd_invalid_integer', () => {
      // BigInt('1.5') throws — bigint literal grammar disallows the dot.
      // Floats only round-trip as `number`, not as `string`, by design:
      // a decimal string usually means the client serialized the wrong
      // value (the cost is in *micro*-USD, integer by definition).
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: '1.5' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('cost_micro_usd_invalid_integer');
    });

    it('rejects negative cost_micro_usd from a string', () => {
      // BigInt('-5') succeeds as -5n, then the explicit `< 0n` rejects it.
      // A negative client value would defeat the GREATEST monotonicity
      // guarantee at the SQL layer (GREATEST(prev, -5) is just `prev`,
      // which is fine, but accepting it would let the client mask a real
      // bug — the running_cost frames are always ≥ 0 by construction).
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: '-5' });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(400);
        expect(r.body.error).toBe('cost_micro_usd_negative');
      }
    });

    it('rejects negative cost_micro_usd from a number', () => {
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: -42 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.body.error).toBe('cost_micro_usd_negative');
    });

    it('rejects -0 number as 0 (NOT negative)', () => {
      // -0 is mathematically 0; BigInt(Math.trunc(-0)) === 0n; the negative
      // branch is on `< 0n` not `< 0`, so -0 sneaks past as 0n. Pin this so
      // a future refactor that uses `< 0` on the number wouldn't silently
      // start rejecting -0.
      const r = parseReconcileBody({ logging_message_id: 'msg_x', cost_micro_usd: -0 });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.clientCost).toBe(0n);
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
// endpoint still owns post-Task 11.
//
// TODO: integration tests that need a real Workers runtime + Neon DB
// (mocked JWKS, real-Postgres FOR UPDATE, etc.) — those are spec'd in the
// runbook (Task 12) and tracked outside this file.
// ---------------------------------------------------------------------------
