import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { resolveAnonActor } from '../_shared/anon-id';
import { toBigInt } from '../_shared/bigint';

/**
 * Client-side reconcile fallback. The streaming worker's post-stream IIFE
 * (anthropic-stream.ts ctx.waitUntil) is the primary path that writes
 * cost_micro_usd to logging_messages, but it can be killed by Cloudflare's
 * waitUntil time budget on streams whose tracked.done hangs (typical when
 * the user's connection drops mid-stream and the abort doesn't propagate
 * cleanly). When that happens, the per-chart pill stays at whatever the
 * message_start floor wrote (input cost only), which under-reports the
 * actual cost.
 *
 * This endpoint lets the client push its own running_cost figure (already
 * received via SSE during streaming) so the row gets reconciled in a fresh
 * worker invocation with its own waitUntil budget.
 *
 * Scope: phase 1 — only updates logging_messages.cost_micro_usd. Does NOT
 * update user_api_usage; the cap was already enforced by the pre-stream
 * reservation, and the projected reservation amount stays in user_api_usage
 * regardless of the reconcile path. A future refund/topup phase can be
 * layered on top.
 *
 * Trust model: the value is clamped to GREATEST(existing, client_value),
 * so the client can only push the cost up, never down. Combined with the
 * server-side message_start floor (anthropic-stream.ts), the existing value
 * is at least the input cost we observed Anthropic charge — so a client
 * lying low (cost=0) cannot bypass the floor. Lying high is a self-imposed
 * harm: the user fills their own free-tier cap faster, no harm to us.
 *
 * Idempotency: GREATEST makes repeated calls safe. Multiple invocations
 * with the same value are no-ops; with increasing values, the column
 * monotonically rises.
 */

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests).
//
// The handler below threads identity → DB row lookup → cost-clamp → DB write.
// Identity and the DB are environment-bound and exercised manually + via
// integration tests; the bits below are the call's data-shape decisions and
// are pure (no I/O), so they're the part we lock down with unit tests.
// ---------------------------------------------------------------------------

/** Discriminated result of `parseReconcileBody`. Either a parsed value, or a
 * ready-to-return `{ status, body }` 4xx tuple. The handler converts the 4xx
 * tuple to `Response.json(body, { status })`. */
export type ParseReconcileResult =
  | { ok: true; loggingMessageId: string; clientCost: bigint }
  | { ok: false; status: number; body: { error: string; detail?: string } };

/**
 * Validate the JSON body of a `POST /api/reconcile-cost` request.
 *
 * Acceptance rules (mirror the historical contract; tests pin these so a
 * silent loosening here would be visible):
 *  - `logging_message_id` must be a non-empty string.
 *  - `cost_micro_usd` may be a string (parsed via BigInt) or a finite
 *    number (truncated then BigInt-coerced). Anything else is rejected.
 *  - The resulting bigint must not be negative.
 *
 * Returning a discriminated union (rather than throwing) keeps the handler
 * branch-free at this step: ok → use the value, !ok → forward `body` and
 * `status` straight into `Response.json`.
 */
export function parseReconcileBody(raw: unknown): ParseReconcileResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, status: 400, body: { error: 'logging_message_id_required' } };
  }
  const body = raw as { logging_message_id?: unknown; cost_micro_usd?: unknown };

  const loggingMessageId = body.logging_message_id;
  if (typeof loggingMessageId !== 'string' || loggingMessageId.length === 0) {
    return { ok: false, status: 400, body: { error: 'logging_message_id_required' } };
  }

  // cost_micro_usd is sent as string by the client (BigInt round-trip via
  // SSE running_cost frames) but we accept number too in case a future
  // client changes encoding.
  let clientCost: bigint;
  const cost = body.cost_micro_usd;
  try {
    if (typeof cost === 'string') {
      clientCost = BigInt(cost);
    } else if (typeof cost === 'number' && Number.isFinite(cost)) {
      clientCost = BigInt(Math.trunc(cost));
    } else {
      return {
        ok: false,
        status: 400,
        body: { error: 'cost_micro_usd_required', detail: 'must be a string or number' },
      };
    }
  } catch {
    return { ok: false, status: 400, body: { error: 'cost_micro_usd_invalid_integer' } };
  }
  if (clientCost < 0n) {
    return { ok: false, status: 400, body: { error: 'cost_micro_usd_negative' } };
  }

  return { ok: true, loggingMessageId, clientCost };
}

/** Discriminated outcome of `computeReconcileOutcome`. */
export type ReconcileOutcome =
  | { kind: 'forbidden' }
  | { kind: 'apply'; previousCost: bigint; newCost: bigint; applied: boolean };

/**
 * Decide what (if anything) to do with a reconcile request that has already
 * passed body validation and located its `logging_messages` row.
 *
 *  - If the row's `user_id` does not match the caller, return `forbidden`.
 *    A NULL `user_id` (deleted chart / GDPR-erased row) never matches any
 *    caller, so it's also rejected here.
 *  - Otherwise, clamp `clientCost` against the row's existing cost using the
 *    GREATEST monotonic-floor rule, and report whether the new value would
 *    actually change the row (`applied`). Equal values short-circuit to
 *    `applied: false` so the handler can skip the UPDATE.
 *
 * The function is total over its inputs and bigint-clean (no Number → bigint
 * coercions inside), so the GREATEST + idempotency invariants are testable
 * without spinning up a database.
 */
export function computeReconcileOutcome(
  actorId: string,
  row: { user_id: string | null; cost_micro_usd: bigint | number },
  clientCost: bigint,
): ReconcileOutcome {
  if (row.user_id !== actorId) {
    return { kind: 'forbidden' };
  }
  // Driver-version-tolerant coerce: see worker/_shared/bigint.ts. Tests
  // exercise both `bigint` and `number` row shapes (Neon legacy rows).
  const previousCost = toBigInt(row.cost_micro_usd);
  const newCost = clientCost > previousCost ? clientCost : previousCost;
  const applied = newCost > previousCost;
  return { kind: 'apply', previousCost, newCost, applied };
}

export async function handler(request: Request, env: Env): Promise<Response> {
  // Step 1: resolve actor (auth0 JWT, else anon cookie).
  let actorId: string;
  let authenticated: boolean;

  const token = extractToken(request.headers.get('authorization'));
  if (token) {
    try {
      const decoded = await verifyToken(token, env);
      actorId = decoded.sub;
      authenticated = true;
    } catch (err) {
      if (err instanceof JWKSFetchError) {
        return Response.json({ error: 'auth_service_unavailable' }, { status: 503 });
      }
      return Response.json({ error: 'invalid_token' }, { status: 401 });
    }
  } else {
    try {
      const resolved = await resolveAnonActor(request, env);
      actorId = resolved.userId;
      authenticated = false;
    } catch (e) {
      console.error('[reconcile-cost] anon actor resolve failed:', e);
      return Response.json({ error: 'actor_unavailable' }, { status: 503 });
    }
  }

  // Step 2: parse + validate body.
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = parseReconcileBody(raw);
  if (!parsed.ok) {
    return Response.json(parsed.body, { status: parsed.status });
  }
  const { loggingMessageId, clientCost } = parsed;

  const sql = getDb(env);
  const url = new URL(request.url);

  // Step 3: load the row, verify ownership.
  const rows = (await sql`
    SELECT message_id, user_id, chart_id, cost_micro_usd
    FROM logging_messages
    WHERE message_id = ${loggingMessageId}
  `) as {
    message_id: string;
    user_id: string | null;
    chart_id: string | null;
    cost_micro_usd: bigint | number;
  }[];

  if (rows.length === 0) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  const row = rows[0];
  const outcome = computeReconcileOutcome(actorId, row, clientCost);
  if (outcome.kind === 'forbidden') {
    // Authoritative reject: only the row owner can reconcile its cost.
    // Includes the case where row.user_id is NULL (chart deleted / data
    // erased) — no caller can match a NULL.
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  const { previousCost, newCost, applied } = outcome;

  // Telemetry log (PR-preview-friendly: this lands in `wrangler tail` if
  // attached, plus the diagnostic row below is queryable from the DB).
  console.log(
    JSON.stringify({
      event: 'reconcile_cost_endpoint_hit',
      logging_message_id: loggingMessageId,
      chart_id: row.chart_id,
      actor_id: actorId,
      authenticated,
      previous_cost_micro_usd: previousCost.toString(),
      client_cost_micro_usd: clientCost.toString(),
      new_cost_micro_usd: newCost.toString(),
      applied,
    }),
  );

  // Step 4: apply the floor-or-client max. UPDATE only if it changes
  // anything; saves a write when the row was already fully reconciled by
  // the streaming worker's IIFE.
  if (applied) {
    try {
      await sql`
        UPDATE logging_messages
        SET cost_micro_usd = GREATEST(cost_micro_usd, ${newCost.toString()}::bigint)
        WHERE message_id = ${loggingMessageId}
      `;
    } catch (e) {
      console.error('[reconcile-cost] UPDATE failed:', e);
      return Response.json({ error: 'update_failed' }, { status: 500 });
    }
  }

  // Step 5: diagnostic row — one per call, including no-op calls. Lets us
  // count how often clients reach this endpoint and whether they push
  // values that the streaming worker's reconcile already wrote.
  try {
    await sql`
      INSERT INTO logging_errors (
        error_id, error_name, error_message, user_id, chart_id,
        request_metadata
      )
      VALUES (
        ${crypto.randomUUID()},
        'DiagnosticReconcileEndpointHit',
        ${`prev=${previousCost.toString()} client=${clientCost.toString()} new=${newCost.toString()} µUSD applied=${applied}`},
        ${actorId},
        ${row.chart_id ?? null},
        ${JSON.stringify({
          logging_message_id: loggingMessageId,
          authenticated,
          previous_cost_micro_usd: previousCost.toString(),
          client_cost_micro_usd: clientCost.toString(),
          new_cost_micro_usd: newCost.toString(),
          applied,
          deployment_host: url.hostname,
          fired_at_ms: Date.now(),
        })}
      )
      ON CONFLICT (error_id) DO NOTHING
    `;
  } catch (e) {
    console.error('[reconcile-cost] diagnostic insert failed:', e);
  }

  return Response.json({
    previous_cost_micro_usd: previousCost.toString(),
    new_cost_micro_usd: newCost.toString(),
    applied,
  });
}
