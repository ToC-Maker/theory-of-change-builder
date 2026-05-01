// Tests for `POST /api/reconcile-cost` (worker/api/reconcile-cost.ts).
//
// The endpoint accepts a client-supplied bigint cost value and clamps it
// against the existing `logging_messages.cost_micro_usd` via GREATEST. Two
// invariants make this safe to expose publicly:
//   1. Ownership: only the row's `user_id` can reconcile its own cost.
//      The DB write is gated by the in-handler check; the same check is
//      mirrored here in `computeReconcileOutcome` so we cover it in
//      isolation without spinning up a DB.
//   2. Monotonicity: client values can only push the cost up, never down.
//      Equal values short-circuit to `applied: false` (no UPDATE issued).
//      This makes repeated retries from the client's localStorage queue
//      idempotent.
//
// Coverage strategy: the endpoint splits into one I/O-bound shell (auth +
// SQL SELECT/UPDATE/INSERT) and two pure helpers (body validation, cost
// outcome). The helpers are the part where regressions would silently
// break the security/idempotency guarantees, so we exhaustively cover
// them here. The I/O shell is exercised via integration testing in dev;
// see the TODO block at the bottom of this file for the integration test
// list (404 not_found and the DiagnosticReconcileEndpointHit insert).
import { describe, expect, it } from 'vitest';
import { parseReconcileBody, computeReconcileOutcome } from '../../worker/api/reconcile-cost';

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

describe('computeReconcileOutcome', () => {
  describe('ownership check', () => {
    it('returns forbidden when row.user_id is a different auth user (cross-user attack)', () => {
      // Caller `auth0|alice` posting against `auth0|bob`'s row. This is the
      // canonical IDOR (insecure direct object reference) attack vector
      // the endpoint guards against — an attacker who guesses or scrapes
      // a logging_message_id must still match its user_id to push cost.
      const result = computeReconcileOutcome(
        'auth0|alice',
        { user_id: 'auth0|bob', cost_micro_usd: 100n },
        500n,
      );
      expect(result).toEqual({ kind: 'forbidden' });
    });

    it('returns forbidden when row.user_id is a different anon (cross-anon attack)', () => {
      // Same shape as the auth case but with `anon-<uuid>` ids. After
      // 76b5aa5 (logging-saveMessage pins anon user_id), cross-anon IDOR
      // is also actively guarded — without the user_id pin, the row's
      // user_id was NULL and any caller would fail the check (the safe
      // path), but with the pin we now actively reject mismatches.
      const result = computeReconcileOutcome(
        'anon-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        {
          user_id: 'anon-bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',
          cost_micro_usd: 0n,
        },
        500n,
      );
      expect(result).toEqual({ kind: 'forbidden' });
    });

    it('returns forbidden when row.user_id is NULL (chart deleted / data erased)', () => {
      // GDPR Art. 17 erasure orphans charts to user_id=NULL. The reconcile
      // endpoint must still return forbidden — `null === any_string` is
      // false, so the JS `===` check naturally covers this case. Pin so a
      // refactor to `== ` (loose equality) would be visible.
      const result = computeReconcileOutcome(
        'auth0|alice',
        { user_id: null, cost_micro_usd: 100n },
        500n,
      );
      expect(result).toEqual({ kind: 'forbidden' });
    });

    it('returns forbidden when caller is anon but row is auth (logged-out attempt to reconcile auth row)', () => {
      // After logout, the auth-link cookie may still resolve to the auth
      // sub via the tocb_auth_link cookie path — but a freshly-cleared
      // browser would resolve to a brand new anon-<uuid>. That anon must
      // not match `auth0|alice`'s row. The check is purely structural
      // (string equality), so this is more of a "read this and confirm
      // the equality semantics" test than a behavioral test.
      const result = computeReconcileOutcome(
        'anon-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
        { user_id: 'auth0|alice', cost_micro_usd: 100n },
        500n,
      );
      expect(result).toEqual({ kind: 'forbidden' });
    });

    it('allows an anon caller to reconcile their own row (matching anon-<uuid>)', () => {
      // The headline regression test for commit 76b5aa5 — before that
      // commit, anon rows had user_id=NULL and the ownership check
      // unconditionally failed, silently dropping the entire anon
      // reconcile path. After the commit, anon callers carry the same
      // `anon-<uuid>` identity that wrote the row.
      const anonId = 'anon-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
      const result = computeReconcileOutcome(
        anonId,
        { user_id: anonId, cost_micro_usd: 100n },
        500n,
      );
      expect(result).toEqual({
        kind: 'apply',
        previousCost: 100n,
        newCost: 500n,
        applied: true,
      });
    });

    it('allows an authenticated caller to reconcile their own row', () => {
      const authId = 'auth0|alice';
      const result = computeReconcileOutcome(
        authId,
        { user_id: authId, cost_micro_usd: 100n },
        500n,
      );
      expect(result).toEqual({
        kind: 'apply',
        previousCost: 100n,
        newCost: 500n,
        applied: true,
      });
    });
  });

  describe('GREATEST monotonicity (the cost-clamp invariant)', () => {
    it('client cost lower than existing row → no-op (applied: false)', () => {
      // Trust model: client values can only push the cost up. A lower
      // client value gets clamped to the previous (server-floor) value
      // and the handler skips the UPDATE. This is what stops a malicious
      // client from setting their cost to 0 to bypass the per-user cap.
      const result = computeReconcileOutcome(
        'auth0|alice',
        { user_id: 'auth0|alice', cost_micro_usd: 1000n },
        500n,
      );
      expect(result).toEqual({
        kind: 'apply',
        previousCost: 1000n,
        newCost: 1000n,
        applied: false,
      });
    });

    it('client cost higher than existing row → applied + new value persisted', () => {
      // The primary recovery path: streaming worker's IIFE was killed by
      // the waitUntil budget, the row still reads the message_start
      // floor, and the client pushes the full running_cost it observed
      // via SSE.
      const result = computeReconcileOutcome(
        'auth0|alice',
        { user_id: 'auth0|alice', cost_micro_usd: 100n },
        5000n,
      );
      expect(result).toEqual({
        kind: 'apply',
        previousCost: 100n,
        newCost: 5000n,
        applied: true,
      });
    });

    it('client cost equal to existing row → no-op (applied: false)', () => {
      // Equality short-circuits to no-op so the UPDATE is skipped on a
      // retry. The handler reads `applied` to decide whether to issue
      // the UPDATE statement, so a wrong `applied: true` here would
      // generate a redundant write per retry.
      const result = computeReconcileOutcome(
        'auth0|alice',
        { user_id: 'auth0|alice', cost_micro_usd: 500n },
        500n,
      );
      expect(result).toEqual({
        kind: 'apply',
        previousCost: 500n,
        newCost: 500n,
        applied: false,
      });
    });

    it('previous cost = 0n, client cost > 0 → applied with full client value', () => {
      // The fresh-row case: a kill so early in the stream that even the
      // message_start floor didn't write yet (or wrote 0). The client
      // value is the full reconciled value.
      const result = computeReconcileOutcome(
        'auth0|alice',
        { user_id: 'auth0|alice', cost_micro_usd: 0n },
        12345n,
      );
      expect(result).toEqual({
        kind: 'apply',
        previousCost: 0n,
        newCost: 12345n,
        applied: true,
      });
    });

    it('coerces cost_micro_usd from number column type to bigint (Neon legacy rows)', () => {
      // Older logging_messages rows may serialize cost_micro_usd as a
      // JS number (not a bigint) depending on the Neon driver version.
      // The helper converts via `BigInt(row.cost_micro_usd)`, which is
      // only safe inside Number.MAX_SAFE_INTEGER — but the column has a
      // BIGINT type so the driver yields bigint for values past 2^53.
      // Pin both code paths.
      const fromNumber = computeReconcileOutcome(
        'auth0|alice',
        { user_id: 'auth0|alice', cost_micro_usd: 100 }, // number
        500n,
      );
      expect(fromNumber).toMatchObject({ previousCost: 100n, newCost: 500n, applied: true });

      const fromBigInt = computeReconcileOutcome(
        'auth0|alice',
        { user_id: 'auth0|alice', cost_micro_usd: 100n }, // bigint
        500n,
      );
      expect(fromBigInt).toMatchObject({ previousCost: 100n, newCost: 500n, applied: true });
    });

    it('handles bigint values past Number.MAX_SAFE_INTEGER without precision loss', () => {
      // 2^60 + 1 is past 2^53. BigInt arithmetic stays exact; if a
      // refactor accidentally went through Number we'd lose the bottom
      // bit and `applied` would flip incorrectly.
      const huge = (1n << 60n) + 1n;
      const result = computeReconcileOutcome(
        'auth0|alice',
        { user_id: 'auth0|alice', cost_micro_usd: 1n << 60n },
        huge,
      );
      expect(result).toMatchObject({
        previousCost: 1n << 60n,
        newCost: huge,
        applied: true,
      });
    });
  });

  describe('idempotency (the retry safety invariant)', () => {
    it('a second call with the same value after the first applied → applied: false', () => {
      // Simulates: client posts cost=500, server sees prev=100, applies →
      // row is now at 500. Client retries (e.g. lost connection on
      // response, retries from localStorage queue), server sees prev=500,
      // doesn't apply.
      const first = computeReconcileOutcome(
        'auth0|alice',
        { user_id: 'auth0|alice', cost_micro_usd: 100n },
        500n,
      );
      expect(first).toMatchObject({ applied: true, newCost: 500n });

      // After the UPDATE, the row's cost is now 500n. Re-call with the
      // same client value.
      const second = computeReconcileOutcome(
        'auth0|alice',
        { user_id: 'auth0|alice', cost_micro_usd: 500n }, // post-update
        500n,
      );
      expect(second).toMatchObject({ applied: false, newCost: 500n });
    });

    it('three increasing pushes: applied / applied / applied (monotone climb)', () => {
      // A long-running stream emits running_cost multiple times before
      // the kill; the client's localStorage retry queue batches them.
      // Each push climbs monotonically.
      let prev = 0n;
      const r1 = computeReconcileOutcome('a', { user_id: 'a', cost_micro_usd: prev }, 100n);
      expect(r1).toMatchObject({ applied: true, newCost: 100n });
      prev = (r1 as { newCost: bigint }).newCost;

      const r2 = computeReconcileOutcome('a', { user_id: 'a', cost_micro_usd: prev }, 500n);
      expect(r2).toMatchObject({ applied: true, newCost: 500n });
      prev = (r2 as { newCost: bigint }).newCost;

      const r3 = computeReconcileOutcome('a', { user_id: 'a', cost_micro_usd: prev }, 2000n);
      expect(r3).toMatchObject({ applied: true, newCost: 2000n });
    });

    it('an out-of-order retry pushing a lower value after a higher one applied → no-op', () => {
      // Network reordering: client emits running_cost=2000 first, server
      // applies; then a delayed running_cost=500 retry arrives. We must
      // not regress.
      const r1 = computeReconcileOutcome('a', { user_id: 'a', cost_micro_usd: 0n }, 2000n);
      expect(r1).toMatchObject({ applied: true, newCost: 2000n });

      const r2 = computeReconcileOutcome('a', { user_id: 'a', cost_micro_usd: 2000n }, 500n);
      expect(r2).toMatchObject({ applied: false, newCost: 2000n });
    });
  });
});

// ---------------------------------------------------------------------------
// TODO: Integration tests that need a real Workers runtime + Neon DB.
//
// The pure-helper coverage above pins the validation, ownership, and GREATEST
// invariants without I/O. The remaining behaviors below need a database to
// observe row state; they're exercised manually + via dev-environment
// integration testing today, and should move here once the project's test
// harness gains DB fixtures.
//
// Outstanding integration coverage:
//  1. Auth flow: a valid Auth0 JWT → 200 with applied/newCost. (Mocks the
//     JWKS fetch or uses a test-fixture token signed with a fixture key.)
//  2. Anon flow: a valid `tocb_actor_id` cookie (UUIDv4) → 200, ownership
//     matches the row written by `logging-saveMessage`.
//  3. JWKS fetch failure → 503 auth_service_unavailable (vs 401
//     invalid_token for actual bad tokens — that distinction matters for
//     the client's retry behavior).
//  4. Anon-actor-resolve failure → 503 actor_unavailable.
//  5. Unknown logging_message_id → 404 not_found. (The handler queries
//     logging_messages and returns 404 on zero rows; testable only against
//     a real or stubbed DB.)
//  6. DiagnosticReconcileEndpointHit row insertion: every successful call
//     (including no-op `applied: false` calls) must insert one row into
//     logging_errors with error_name='DiagnosticReconcileEndpointHit'.
//     This is the observability backbone for "is the client-side reconcile
//     fallback actually firing?" — a regression here would silently break
//     the metric without tripping any other test.
//  7. UPDATE failure → 500 update_failed (vs the diagnostic insert
//     failure which is swallowed and logged; the response shape differs).
//  8. JSON parse failure (malformed body) → 400 invalid_json.
//
// The shape of those tests should mirror the pure-helper tests above:
// one `it` per response-shape invariant, with the comment block
// explaining what regression class it locks down.
// ---------------------------------------------------------------------------
