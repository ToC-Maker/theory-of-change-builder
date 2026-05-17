import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { resolveAnonActor } from '../_shared/anon-id';
import { writeDiagnostic } from '../_shared/diagnostics';
import { applyDeltaCommit } from '../_shared/cost-commit';
import { parseLoggingMessageId, type ReconcileCostRequest } from '../../shared/wire-shapes';

/**
 * Client-side reconcile fallback. The streaming worker's post-stream IIFE
 * (anthropic-stream.ts ctx.waitUntil) is the primary path that writes
 * `cost_settled_micro_usd` + `cost_micro_usd` + the user_api_usage delta,
 * but it can be killed by Cloudflare's waitUntil time budget on streams
 * whose tracked.done hangs (typical when the user's connection drops
 * mid-stream and the abort doesn't propagate cleanly). When that happens,
 * the per-chart pill stays at whatever the message_start floor wrote
 * (input cost only), which under-reports the actual cost AND leaves the
 * user_api_usage balance below the projected reservation. (The pre-stream
 * reservation already debited the projection, so a no-reconcile outcome
 * over-charges the cap relative to the real settle figure — refund is
 * handled by the IIFE's signed-delta SQL when it survives.)
 *
 * This endpoint lets the client push its own running_cost figure (already
 * received via SSE during streaming, or estimated locally from
 * content_block_delta frames) so the row gets reconciled in a fresh
 * Worker invocation with its own waitUntil budget.
 *
 * Architecture: the endpoint delegates the dual-row write
 * (logging_messages.cost_settled_micro_usd + cost_micro_usd, user_api_usage
 * delta) to the shared `applyDeltaCommit` helper. `projected = 0n` here
 * because the endpoint has no reservation context (it runs in a fresh
 * Worker invocation, separate from the stream); the helper's
 * `max(projected, cost_settled)` baseline correctly degenerates to
 * `cost_settled`, which already incorporates the reservation via the
 * earlier mid-stream + message_start writers.
 *
 * Trust + idempotency model (see `worker/_shared/cost-commit.ts` for the
 * full CTE; the relevant bits are):
 *  - `WHERE user_id = ${actor}` blocks IDOR — only the row's owner can
 *    advance its cost.
 *  - `cost_settled_micro_usd = GREATEST(cost_settled_micro_usd, ${newCost})`
 *    is monotone: client can only push the cost up, never down. Combined
 *    with the server-side message_start floor (anthropic-stream.ts), the
 *    existing value is at least the input cost we observed Anthropic
 *    charge — so a client lying low (cost=0) cannot bypass the floor.
 *  - `WHERE reconciled_at IS NULL` is the late-retry lock: once the
 *    post-stream IIFE has stamped `reconciled_at`, late retries from the
 *    client's localStorage queue become no-ops, so they cannot
 *    re-inflate the cap (or over-credit it via the signed-delta path).
 *  - `applied=false` collapses three cases into a single benign return
 *    shape: row missing, ownership mismatch, post-reconcile. The
 *    endpoint returns 200 idempotent no-op for all three so the client
 *    retry queue can drop the entry without distinguishing.
 *
 * Lying high (over-reporting cost) is a self-imposed harm: the user
 * fills their own per-user cap faster, no harm to us. The Anthropic
 * Console customer-set cap still applies globally.
 */

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests).
//
// The handler below threads identity → body parse → `applyDeltaCommit` →
// diagnostic. Identity and the DB are environment-bound and exercised via
// integration tests (`reconcile-cost-delta-commit.test.ts` with an
// in-memory backend, plus manual end-to-end testing in dev). The bit
// below is the call's data-shape decision and is pure (no I/O), so it's
// the part we lock down with unit tests.
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
 * Acceptance rules (see `shared/wire-shapes.ts` for the `ReconcileCostRequest`
 * shape; tests pin these so a silent loosening here would be visible):
 *  - `logging_message_id` must be a UUID-shaped string (8-4-4-4-12 hex).
 *    Postgres column is UUID-typed; pre-Wave-2 the validator accepted any
 *    non-empty string and bad shapes failed opaquely at the DB layer.
 *  - `cost_micro_usd` must be a STRING (parsed via BigInt). The pre-Wave-2
 *    `string | number` accept was "defensive forward-compat" but masked
 *    client-side type drift — the production client always sends string
 *    (chatCostTracker.ts::maybePostReconcile).
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
  // Cast to a strict-Partial view of the wire shape; both fields still
  // typed `unknown` because we haven't validated them yet. The cast is
  // shape-narrowing (object), not value-trusting.
  const body = raw as Partial<Record<keyof ReconcileCostRequest, unknown>>;

  // Step 1: logging_message_id presence + UUID shape. Surface presence
  // error before shape error so a client that omitted the field entirely
  // gets the more actionable code.
  const loggingMessageIdRaw = body.logging_message_id;
  if (typeof loggingMessageIdRaw !== 'string' || loggingMessageIdRaw.length === 0) {
    return { ok: false, status: 400, body: { error: 'logging_message_id_required' } };
  }
  let loggingMessageId: string;
  try {
    loggingMessageId = parseLoggingMessageId(loggingMessageIdRaw);
  } catch {
    // parseLoggingMessageId throws on non-UUID; map to the wire error
    // code clients can switch on (distinct from `_required` so retry-queue
    // logic can drop bad-shape entries rather than retrying them).
    return {
      ok: false,
      status: 400,
      body: { error: 'logging_message_id_invalid_uuid' },
    };
  }

  // Step 2: cost_micro_usd MUST be a string (BigInt-precision wire format).
  // The pre-Wave-2 `typeof cost === 'number'` branch was removed — see
  // doc-comment above for rationale.
  let clientCost: bigint;
  const cost = body.cost_micro_usd;
  if (typeof cost !== 'string') {
    return {
      ok: false,
      status: 400,
      body: { error: 'cost_micro_usd_required', detail: 'must be a string' },
    };
  }
  try {
    clientCost = BigInt(cost);
  } catch {
    return { ok: false, status: 400, body: { error: 'cost_micro_usd_invalid_integer' } };
  }
  if (clientCost < 0n) {
    return { ok: false, status: 400, body: { error: 'cost_micro_usd_negative' } };
  }

  return { ok: true, loggingMessageId, clientCost };
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

  // Step 2.5: determine BYOK status for `applyDeltaCommit`'s column-routing
  // parameter. The endpoint receives no BYOK header on retry-queue replays
  // (the client never sends `X-User-Anthropic-Key` to `/api/reconcile-cost`),
  // so we infer `isByok` from whether the user currently has a stored
  // BYOK key. Two consequences worth noting:
  //   - For authenticated users with a stored key, the delta routes to
  //     `user_api_usage.byok_cost_micro_usd` (independent of the free cap).
  //   - For anon users or auth users without a stored key, it routes to
  //     `cost_micro_usd` (the column reserveCost checks against the cap).
  // Edge case (acceptable): if a user toggles BYOK between stream + reconcile
  // retry, the routing matches their *current* state, not the stream's tier.
  // Stream-time tier would require a `logging_messages.was_byok` column;
  // not added in this fix (out of scope).
  let isByok = false;
  if (authenticated) {
    try {
      const rows = (await sql`
        SELECT 1 FROM user_byok_keys WHERE user_id = ${actorId} LIMIT 1
      `) as unknown[];
      isByok = rows.length > 0;
    } catch (e) {
      // BYOK lookup failed — fail closed to the safer routing for the user
      // (don't accidentally inflate their free cap when they have BYOK).
      // Log so the issue is visible; return 500 so the client retries
      // rather than silently routing wrong.
      console.error('[reconcile-cost] BYOK lookup failed:', e);
      return Response.json({ error: 'byok_lookup_failed' }, { status: 503 });
    }
  }

  // Step 3: delegate the dual-row write to `applyDeltaCommit`. The helper
  // atomically:
  //  - Locks the logging_messages row (`SELECT ... FOR UPDATE`) with the
  //    `WHERE user_id = ${actorId} AND reconciled_at IS NULL` guards baked
  //    in (so ownership mismatch and post-reconcile both collapse to
  //    `applied=false`, no row write).
  //  - Advances both `cost_micro_usd` (monotone HWM) AND
  //    `cost_settled_micro_usd` (the authoritative settled value).
  //  - Credits `user_api_usage` by `max(0, newCost - max(projected, cost_settled))`.
  //    With `projected = 0n` here (no reservation context in this fresh Worker
  //    invocation), the baseline is `cost_settled`, which already incorporates
  //    the reservation via the earlier mid-stream / abort handler writers.
  //  - Routes the delta into `cost_micro_usd` or `byok_cost_micro_usd` based
  //    on `isByok` (resolved above). Free-tier deltas land in `cost_micro_usd`
  //    (the column reserveCost checks); BYOK deltas land in the parallel
  //    `byok_cost_micro_usd` column and never inflate the free cap.
  //
  // `applied=false` from the helper is a benign no-op — the row was
  // missing, owned by someone else, or already reconciled. We return 200
  // so the client's retry queue treats it as success (not retry-worthy).
  let out: Awaited<ReturnType<typeof applyDeltaCommit>>;
  try {
    out = await applyDeltaCommit(sql, loggingMessageId, actorId, 0n, clientCost, isByok);
  } catch (e) {
    console.error('[reconcile-cost] applyDeltaCommit failed:', e);
    // Symmetric with every analogous in-stream reconcile path: persist a
    // logging_errors row so the failure is queryable from the DB instead
    // of only visible in `wrangler tail`. Matches the metadata shape of
    // the success-path `DiagnosticReconcileEndpointHit` row written
    // below in Step 4, so analytics can JOIN/UNION across both event
    // names by `logging_message_id`.
    await writeDiagnostic(sql, {
      error_name: 'DiagnosticReconcileEndpointFailed',
      error_message: `applyDeltaCommit threw: ${e instanceof Error ? e.message : String(e)}`,
      user_id: actorId,
      chart_id: null,
      request_metadata: {
        logging_message_id: loggingMessageId,
        authenticated,
        is_byok: isByok,
        client_cost_micro_usd: clientCost.toString(),
        error_message: e instanceof Error ? e.message : String(e),
        error_stack: e instanceof Error ? e.stack : null,
      },
      deployment_host: url.hostname,
      fired_at_ms: Date.now(),
    });
    return Response.json({ error: 'update_failed' }, { status: 500 });
  }

  // Telemetry log (PR-preview-friendly: this lands in `wrangler tail` if
  // attached, plus the diagnostic row below is queryable from the DB).
  console.log(
    JSON.stringify({
      event: 'reconcile_cost_endpoint_hit',
      logging_message_id: loggingMessageId,
      actor_id: actorId,
      authenticated,
      is_byok: isByok,
      client_cost_micro_usd: clientCost.toString(),
      new_settled_micro_usd: out.new_settled.toString(),
      delta_micro_usd: out.delta.toString(),
      applied: out.applied,
    }),
  );

  // Step 4: diagnostic row — one per call, including no-op `applied=false`
  // calls. Lets us count how often clients reach this endpoint, whether
  // they're pushing values that the streaming worker's reconcile already
  // wrote, and whether the late-retry lock (`reconciled_at` set) is
  // catching post-reconcile retries. No start_at_ms: this endpoint runs in
  // a fresh Worker invocation separate from the streaming lifecycle, so
  // there's no handlerStartedAtMs to anchor an elapsed measurement to.
  await writeDiagnostic(sql, {
    error_name: 'DiagnosticReconcileEndpointHit',
    error_message: `client=${clientCost.toString()} new_settled=${out.new_settled.toString()} delta=${out.delta.toString()} µUSD applied=${out.applied} byok=${isByok}`,
    user_id: actorId,
    chart_id: null,
    request_metadata: {
      logging_message_id: loggingMessageId,
      authenticated,
      is_byok: isByok,
      client_cost_micro_usd: clientCost.toString(),
      new_settled_micro_usd: out.new_settled.toString(),
      delta_micro_usd: out.delta.toString(),
      applied: out.applied,
    },
    deployment_host: url.hostname,
    fired_at_ms: Date.now(),
  });

  return Response.json({
    applied: out.applied,
    delta: out.delta.toString(),
    new_settled: out.new_settled.toString(),
  });
}
