import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { decryptByokKey } from '../_shared/byok-crypto';
import { extractTurnstileCookie, verifyTurnstileCookie } from '../_shared/turnstile-cookie';
import { hashIP, extractIP } from '../_shared/anon-id';
import {
  computeCostMicroUsd,
  RATES_MICRO_USD_PER_TOKEN,
  type AnthropicUsage,
} from '../_shared/cost';
import {
  LIFETIME_CAP_USD,
  LIFETIME_CAP_MICRO_USD,
  BODY_SIZE_LIMIT_BYTES,
  tierFor,
  isCapped,
  needTurnstile,
  type Tier,
} from '../_shared/tiers';
import type { NeonQueryFunction } from '@neondatabase/serverless';

/**
 * HTTP streaming proxy for Anthropic's /v1/messages endpoint with server-side
 * cost enforcement. The pipeline, in order:
 *
 *   1. Body-size clamp (reject 413 if > BODY_SIZE_LIMIT_BYTES, currently 32 MB).
 *   2. JWT verify (if Authorization header present) → actor_id = sub or anon-<hmac(ip)>.
 *   3. Tier classification (anon / free / byok). Authenticated users with a row in
 *      user_byok_keys are promoted to the byok tier; header `X-User-Anthropic-Key`
 *      (legacy) still wins if present.
 *   4. Turnstile session cookie check for anon (skipped if TURNSTILE_SECRET_KEY unset).
 *      Cookie is issued by POST /api/verify-turnstile and bound to the caller's
 *      cf-connecting-ip-derived anon_id via HMAC.
 *   5. Idempotency de-dup via idempotency_keys table (60s window).
 *   6. Pre-flight cost estimate via /v1/messages/count_tokens.
 *   7. Atomic reservation against user_api_usage (skipped for BYOK).
 *   8. Upstream fetch with x-api-key = BYOK key if the caller has one, else our
 *      ANTHROPIC_API_KEY. For BYOK: `body.metadata` is stripped entirely so we
 *      don't pollute the user's Anthropic dashboard with our internal user_ids.
 *      Detect Anthropic billing-error → 402 global_budget_exhausted.
 *   9. Stream through a TransformStream that parses SSE usage events and enforces
 *      the mid-stream kill switch: cumulative actual cost > remaining_cap (the
 *      portion of the lifetime cap that was available BEFORE this request's
 *      reservation was deducted). Also intercepts Anthropic `not_found_error`
 *      events and synthesizes `chart_deleted` / `file_unavailable` SSE errors
 *      so the client can react instead of seeing a truncated stream.
 *  10. Post-stream reconcile: adjust user_api_usage + global_monthly_usage for
 *      actual vs projected cost. If the client supplied X-Logging-Message-Id,
 *      writes the actual cost to logging_messages.cost_micro_usd for per-chart
 *      attribution queries.
 *
 * On upstream error after reservation, the reservation is reverted in
 * ctx.waitUntil. BYOK requests bypass steps 7, 9's kill-switch, and 10's
 * reconcile writes.
 */

// --- Constants ----------------------------------------------------------

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_COUNT_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'files-api-2025-04-14';
const DEFAULT_MODEL = 'claude-opus-4-7';

// --- Helpers: JSON / HTTP -----------------------------------------------

function jsonError(
  body: Record<string, unknown>,
  status: number,
  altSvcHeaders: Record<string, string>,
): Response {
  return Response.json(body, { status, headers: altSvcHeaders });
}

function microToUsd(micro: bigint): number {
  const whole = micro / 1_000_000n;
  const frac = Number(micro % 1_000_000n) / 1_000_000;
  return Number(whole) + frac;
}

function firstOfNextMonthUtcIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0)).toISOString();
}

function isUuidish(v: string): boolean {
  // Accept the canonical 8-4-4-4-12 UUID shape. We don't require v4 specifically;
  // any UUID-shaped string is fine as a dedup key. Non-UUID strings are ignored
  // rather than rejected — easier for clients to migrate without breaking.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

// --- Body reading with streaming size clamp -----------------------------

/**
 * Reads the full request body while streaming-counting bytes. Rejects early with
 * 413 as soon as the cumulative byte count crosses BODY_SIZE_LIMIT_BYTES, so a
 * malicious client cannot consume memory by sending an infinite body.
 *
 * Returns either { ok: true, body } with the parsed JSON, or { ok: false,
 * response } with a pre-built 4xx response the caller should return immediately.
 */
async function readBodyWithSizeClamp(
  request: Request,
  altSvcHeaders: Record<string, string>,
): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  if (!request.body) {
    return { ok: false, response: jsonError({ error: 'Invalid JSON in request body' }, 400, altSvcHeaders) };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > BODY_SIZE_LIMIT_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return {
        ok: false,
        response: jsonError(
          { error: 'body_too_large', limit_bytes: BODY_SIZE_LIMIT_BYTES },
          413,
          altSvcHeaders,
        ),
      };
    }
    chunks.push(value);
  }

  // Concatenate in one pass. Worst case is BODY_SIZE_LIMIT_BYTES (currently
  // 32 MB per Anthropic's Messages API ceiling); a TransformStream wouldn't
  // save allocations since we need the whole JSON to parse before forwarding.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }

  try {
    const text = new TextDecoder().decode(merged);
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, response: jsonError({ error: 'Invalid JSON in request body' }, 400, altSvcHeaders) };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, response: jsonError({ error: 'Invalid JSON in request body' }, 400, altSvcHeaders) };
  }
}

// --- Actor / tier resolution --------------------------------------------

type ActorResult =
  | { ok: true; actorId: string; authenticated: boolean }
  | { ok: false; response: Response };

// Email verification is enforced upstream in Auth0 via a Post-Login Action
// that denies login for users with `event.user.email_verified === false`.
// Auth0 only issues tokens for verified users, so anyone reaching this
// handler with a valid JWT is implicitly verified — no in-worker check needed.
async function resolveActor(
  request: Request,
  env: Env,
  altSvcHeaders: Record<string, string>,
): Promise<ActorResult> {
  const token = extractToken(request.headers.get('authorization'));

  if (token) {
    let decoded;
    try {
      decoded = await verifyToken(token, env);
    } catch (err) {
      if (err instanceof JWKSFetchError) {
        return { ok: false, response: jsonError({ error: 'authentication_service_unavailable' }, 503, altSvcHeaders) };
      }
      return { ok: false, response: jsonError({ error: 'invalid_token' }, 401, altSvcHeaders) };
    }
    return { ok: true, actorId: decoded.sub, authenticated: true };
  }

  // Anonymous path: hash the CF-attested IP under our salt.
  let actorId: string;
  try {
    const ip = extractIP(request);
    actorId = `anon-${await hashIP(ip, env.IP_HASH_SALT)}`;
  } catch (e) {
    console.error('Failed to hash IP for anonymous actor:', e);
    actorId = 'anon-unknown';
  }
  return { ok: true, actorId, authenticated: false };
}

// --- Turnstile session cookie ------------------------------------------

type TurnstileResult = 'ok' | 'missing' | 'expired' | 'ip_mismatch' | 'invalid' | 'not-configured';

/**
 * Verify the Turnstile session cookie issued by POST /api/verify-turnstile.
 *
 * The cookie carries the anon_id (hmac(cf-connecting-ip, IP_HASH_SALT)) it was
 * minted for. On every anon request here we re-derive the caller's anon_id from
 * the current cf-connecting-ip and require it to match — moving IPs
 * invalidates the cookie so a single solved challenge can't be replayed across
 * IPs. TTL is enforced by the `exp` field inside the signed payload.
 *
 * When TURNSTILE_SECRET_KEY is unset (local dev / pre-launch), skip the check
 * entirely so the anon path still works.
 */
async function verifyTurnstileFromCookie(
  request: Request,
  env: Env,
): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET_KEY) {
    console.warn('Turnstile not configured; skipping anon session-cookie check');
    return 'not-configured';
  }

  const cookieValue = extractTurnstileCookie(request.headers.get('cookie'));
  if (!cookieValue) return 'missing';

  let expectedAnonId: string;
  try {
    expectedAnonId = await hashIP(extractIP(request), env.IP_HASH_SALT);
  } catch (e) {
    console.error('Turnstile cookie: failed to derive expected anon_id', e);
    return 'invalid';
  }

  return verifyTurnstileCookie(cookieValue, expectedAnonId, env.IP_HASH_SALT);
}

// --- Idempotency --------------------------------------------------------

/**
 * Returns true if the insert succeeded (first time we've seen this key in the
 * window). Returns false on conflict (replay). On DB error, returns true and
 * logs — a broken Neon shouldn't block legitimate requests; the cap check
 * still gates cost.
 */
async function claimIdempotencyKey(
  sql: NeonQueryFunction<false, false>,
  userId: string,
  key: string,
): Promise<boolean> {
  try {
    const rows = await sql`
      INSERT INTO idempotency_keys (user_id, key)
      VALUES (${userId}, ${key})
      ON CONFLICT DO NOTHING
      RETURNING user_id
    `;
    // Opportunistic cleanup of expired rows (1% sampled) to keep table small.
    if (Math.random() < 0.01) {
      try {
        await sql`DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '60 seconds'`;
      } catch (e) {
        console.warn('idempotency_keys cleanup failed (non-fatal):', e);
      }
    }
    return rows.length > 0;
  } catch (e) {
    console.error('Idempotency claim failed (allowing request through):', e);
    return true;
  }
}

// --- Cost estimate + atomic reservation ---------------------------------

type EstimateResult =
  | { ok: true; projected: bigint; model: string }
  | { ok: false; response: Response };

/**
 * Calls /v1/messages/count_tokens with the request body (minus streaming-only
 * fields) to get the exact input-token count. Multiplies by the model's input
 * rate to get projected cost. The actual output cost is reconciled post-stream;
 * the mid-stream kill switch bounds the worst case.
 */
async function estimateProjectedCost(
  body: Record<string, unknown>,
  env: Env,
  altSvcHeaders: Record<string, string>,
): Promise<EstimateResult> {
  const model = typeof body.model === 'string' ? body.model : DEFAULT_MODEL;
  const rate = RATES_MICRO_USD_PER_TOKEN[model];
  if (!rate) {
    // Unknown model — refuse rather than silently skip the cap.
    console.error('Unknown model in anthropic-stream body:', model);
    return {
      ok: false,
      response: jsonError({ error: 'unknown_model', model }, 400, altSvcHeaders),
    };
  }

  // count_tokens only accepts a narrow subset of /v1/messages fields
  // (messages, model, system, tools, tool_choice, thinking, output_config,
  // cache_control — per the API reference). Anything else (notably
  // `max_tokens`, `stream`, `metadata`, `temperature`, `top_p`, `top_k`,
  // `stop_sequences`) returns 400. Whitelist instead of blacklist so we
  // don't silently break whenever the client adds a new field.
  const COUNT_TOKENS_ALLOWED = new Set([
    'messages', 'model', 'system', 'tools', 'tool_choice',
    'thinking', 'output_config', 'cache_control',
  ]);
  const countBody: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (COUNT_TOKENS_ALLOWED.has(k)) countBody[k] = v;
  }

  // Strip server tools (web_search_*, code_execution_*) — count_tokens
  // rejects them with "Server tools are not supported in the count_tokens
  // endpoint. Use the /v1/messages endpoint instead." Undocumented but
  // observed in production. Leave user-defined function tools in place so
  // their definitions still count. If the filtered array is empty, drop
  // the field entirely rather than sending [].
  if (Array.isArray(countBody.tools)) {
    const filtered = (countBody.tools as Array<Record<string, unknown>>).filter((t) => {
      const type = typeof t?.type === 'string' ? t.type : '';
      return !type.startsWith('web_search_') && !type.startsWith('code_execution_');
    });
    if (filtered.length > 0) countBody.tools = filtered;
    else delete countBody.tools;
  }

  let resp: Response;
  try {
    resp = await fetch(ANTHROPIC_COUNT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
      },
      body: JSON.stringify(countBody),
    });
  } catch (e) {
    // Fail closed: we can't estimate, so we can't enforce.
    console.error('[estimate] count_tokens network error:', e);
    return {
      ok: false,
      response: jsonError({ error: 'estimation_unavailable' }, 503, altSvcHeaders),
    };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(
      `[estimate] count_tokens upstream ${resp.status}: ${text} | body keys sent: ${Object.keys(countBody).join(',')}`,
    );
    // Surface Anthropic's error message to the client so the next 503
    // here is diagnosable without tailing Worker logs.
    let upstreamMessage: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      upstreamMessage = parsed?.error?.message;
    } catch { /* non-JSON body; leave undefined */ }
    return {
      ok: false,
      response: jsonError(
        { error: 'estimation_unavailable', upstream_status: resp.status, upstream_message: upstreamMessage },
        503,
        altSvcHeaders,
      ),
    };
  }

  let data: { input_tokens?: number };
  try {
    data = await resp.json() as { input_tokens?: number };
  } catch (e) {
    console.error('[estimate] count_tokens JSON parse failed:', e);
    return { ok: false, response: jsonError({ error: 'estimation_unavailable' }, 503, altSvcHeaders) };
  }

  const inputTokens = typeof data.input_tokens === 'number' ? data.input_tokens : 0;
  const projected = BigInt(inputTokens) * BigInt(rate.input);
  return { ok: true, projected, model };
}

type ReserveResult =
  | { ok: true; postReservationUsage: bigint }
  | { ok: false; response: Response };

/**
 * Atomically reserve `projected` µUSD against user_api_usage. Either:
 *   - updates an existing row (cap-respecting guard in WHERE),
 *   - inserts a new row on first use,
 *   - or reports the user is already at/over the cap (429).
 *
 * On success returns the post-reservation cost_micro_usd so the caller can
 * derive `pre_reservation_usage = post - projected` and, from that,
 * `remaining_cap_before_reservation = LIFETIME_CAP - pre_reservation_usage`
 * for the mid-stream kill switch.
 */
async function reserveCost(
  sql: NeonQueryFunction<false, false>,
  userId: string,
  projected: bigint,
  tier: Tier,
  altSvcHeaders: Record<string, string>,
): Promise<ReserveResult> {
  const projStr = projected.toString();
  const capStr = LIFETIME_CAP_MICRO_USD.toString();

  let updateRows: { cost_micro_usd: bigint | number | string }[];
  try {
    updateRows = await sql`
      UPDATE user_api_usage
      SET cost_micro_usd = cost_micro_usd + ${projStr}::bigint,
          last_activity_at = NOW()
      WHERE user_id = ${userId}
        AND cost_micro_usd + ${projStr}::bigint <= ${capStr}::bigint
      RETURNING cost_micro_usd
    ` as { cost_micro_usd: bigint | number | string }[];
  } catch (e) {
    console.error('[reserve] UPDATE user_api_usage failed:', e);
    return { ok: false, response: jsonError({ error: 'database_unavailable' }, 503, altSvcHeaders) };
  }

  if (updateRows.length > 0) {
    return { ok: true, postReservationUsage: toBigInt(updateRows[0].cost_micro_usd) };
  }

  // Either no row exists, or the row would exceed the cap. Disambiguate by
  // attempting to create the row. ON CONFLICT DO NOTHING means: if the row
  // exists, INSERT is a no-op (and we know the existing row is over cap).
  let insertRows: { cost_micro_usd: bigint | number | string }[];
  try {
    insertRows = await sql`
      INSERT INTO user_api_usage (user_id, cost_micro_usd, first_activity_at, last_activity_at)
      VALUES (${userId}, ${projStr}::bigint, NOW(), NOW())
      ON CONFLICT (user_id) DO NOTHING
      RETURNING cost_micro_usd
    ` as { cost_micro_usd: bigint | number | string }[];
  } catch (e) {
    console.error('[reserve] INSERT user_api_usage failed:', e);
    return { ok: false, response: jsonError({ error: 'database_unavailable' }, 503, altSvcHeaders) };
  }

  if (insertRows.length > 0) {
    return { ok: true, postReservationUsage: toBigInt(insertRows[0].cost_micro_usd) };
  }

  // Cap is actually exceeded — read current cost to produce a useful error body.
  let usedMicro: bigint = 0n;
  try {
    const rows = await sql`
      SELECT cost_micro_usd FROM user_api_usage WHERE user_id = ${userId}
    ` as { cost_micro_usd: bigint | number | string }[];
    if (rows.length > 0) usedMicro = toBigInt(rows[0].cost_micro_usd);
  } catch (e) {
    console.error('read-used lookup failed (non-fatal):', e);
  }

  const remedies = tier === 'anon' ? ['signin'] : ['byok', 'donate'];
  return {
    ok: false,
    response: jsonError(
      {
        error: 'lifetime_cap_reached',
        tier,
        used_usd: microToUsd(usedMicro),
        limit_usd: LIFETIME_CAP_USD,
        remedies,
      },
      429,
      altSvcHeaders,
    ),
  };
}

function toBigInt(v: bigint | number | string | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  // Neon returns BIGINT as string — BigInt('123') works.
  return BigInt(v);
}

// --- Keepalive (inherited, unchanged behavior) --------------------------

/**
 * Wraps an SSE stream with periodic keepalive comments to prevent idle
 * timeouts from killing long-running responses. During extended-thinking
 * pauses Claude may emit no data for tens of seconds; a 25s heartbeat
 * keeps the connection above any intermediate idle threshold (proxies,
 * QUIC idle timers, client-side watchdogs). SSE comment lines
 * (`: keepalive`) are ignored by EventSource parsers and the client's
 * manual line parser.
 */
function createKeepaliveStream(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  intervalMs = 25000
): ReadableStream<Uint8Array> {
  const keepaliveBytes = new TextEncoder().encode(': keepalive\n\n');
  let intervalId: ReturnType<typeof setInterval>;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      intervalId = setInterval(() => {
        try {
          controller.enqueue(keepaliveBytes);
        } catch {
          clearInterval(intervalId);
        }
      }, intervalMs);
      signal.addEventListener('abort', () => clearInterval(intervalId));
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() { clearInterval(intervalId); },
    cancel() { clearInterval(intervalId); },
  });

  return source.pipeThrough(transform);
}

// --- Cost-tracking SSE tee ----------------------------------------------

type UsageAccumulator = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_search_requests: number;
};

function newAccumulator(): UsageAccumulator {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    web_search_requests: 0,
  };
}

function accumulatorToUsage(acc: UsageAccumulator): AnthropicUsage {
  return {
    input_tokens: acc.input_tokens,
    output_tokens: acc.output_tokens,
    cache_creation_input_tokens: acc.cache_creation_input_tokens,
    cache_read_input_tokens: acc.cache_read_input_tokens,
    server_tool_use: { web_search_requests: acc.web_search_requests },
  };
}

/**
 * Merge an Anthropic usage fragment into our accumulator. Anthropic's SSE
 * stream emits usage on `message_start` (input + initial output=1) and
 * `message_delta` (incremental output); we treat later values as authoritative
 * rather than adding. Cache-creation/read counts only appear on message_start.
 */
function mergeUsage(acc: UsageAccumulator, usage: Record<string, unknown>): void {
  if (typeof usage.input_tokens === 'number') acc.input_tokens = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') acc.output_tokens = usage.output_tokens;
  if (typeof usage.cache_creation_input_tokens === 'number') {
    acc.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === 'number') {
    acc.cache_read_input_tokens = usage.cache_read_input_tokens;
  }
  const stu = usage.server_tool_use;
  if (stu && typeof stu === 'object' && !Array.isArray(stu)) {
    const wsr = (stu as Record<string, unknown>).web_search_requests;
    if (typeof wsr === 'number') acc.web_search_requests = wsr;
  }
}

type SseTeeContext = {
  accumulator: UsageAccumulator;
  /**
   * Mid-stream kill threshold in µUSD. When cumulative actual cost exceeds this,
   * the tee synthesizes a `request_cost_ceiling_exceeded` SSE error and aborts.
   *
   * For free/anon tiers this is the remaining_cap measured BEFORE this
   * request's reservation was deducted (i.e. the lifetime cap minus the user's
   * prior usage). Since the reservation was already written, `remaining_cap`
   * bounds what the stream can spend before the cap is truly violated.
   *
   * For BYOK this is null — no cap applies to a self-funded request.
   */
  killThresholdMicro: bigint | null;
  model: string;
  abortController: AbortController;
  /** Set to true when we fire the kill switch so downstream short-circuits. */
  killed: { v: boolean };
  /**
   * Chart id passed via X-Chart-Id header, if any. Used to disambiguate
   * `chart_deleted` vs `file_unavailable` when Anthropic returns
   * `not_found_error`.
   */
  chartId: string | null;
  /** Neon handle for the chart-existence lookup during file-not-found interception. */
  sql: NeonQueryFunction<false, false>;
};

/**
 * Pipes the upstream SSE stream through a TransformStream that:
 *  - forwards every byte verbatim,
 *  - parses `data: {...}` frames as they complete,
 *  - accumulates usage and fires the cap kill-switch when cumulative cost
 *    exceeds the remaining_cap bound,
 *  - intercepts Anthropic `not_found_error` events, classifies them as
 *    `chart_deleted` or `file_unavailable`, and synthesizes a clean SSE error
 *    for the client.
 *
 * The SSE frame parser keeps a tail buffer for partial frames; Anthropic's
 * stream can split a single frame across chunks (especially with cache/Worker
 * buffering). We split on the canonical frame separator `\n\n`.
 *
 * Returns both the transformed stream AND a `done` Promise that resolves
 * when the stream completes (naturally, via kill-switch, or intercepted
 * file-not-found error). The caller uses `done` to synchronize post-stream
 * reconcile without racing against incomplete accumulator state.
 */
function createCostTrackingStream(
  source: ReadableStream<Uint8Array>,
  teeCtx: SseTeeContext,
): { stream: ReadableStream<Uint8Array>; done: Promise<void> } {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let sseBuffer = '';
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => { resolveDone = resolve; });

  // Defensive resolve-on-abort: if the upstream is aborted (either by our
  // client-disconnect propagation or the kill-switch), a pipeThrough error
  // can bypass flush()/cancel() so done would otherwise hang. Promise
  // resolve is idempotent, so double-resolution from the normal path is a
  // no-op.
  teeCtx.abortController.signal.addEventListener('abort', () => resolveDone());

  /**
   * Detect Anthropic `not_found_error` inside an SSE `error` frame and, if so,
   * synthesize a typed `chart_deleted` / `file_unavailable` event. This lets
   * the client distinguish "your chart was deleted mid-request" from a generic
   * stream truncation. Returns true if the frame was intercepted; the caller
   * should stop forwarding the original frame in that case.
   */
  async function maybeInterceptNotFound(
    parsed: Record<string, unknown>,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): Promise<boolean> {
    if (parsed.type !== 'error') return false;
    const err = parsed.error;
    if (!err || typeof err !== 'object') return false;
    const errType = (err as Record<string, unknown>).type;
    if (errType !== 'not_found_error') return false;

    // Decide which synthesized event to send: if no chart id, we can't be
    // specific about a file. If we have a chart id, check whether it still
    // exists; if not, this is chart_deleted, otherwise it's a file within the
    // chart that was garbage-collected.
    let kind: 'chart_deleted' | 'file_unavailable' = 'file_unavailable';
    if (teeCtx.chartId) {
      try {
        const rows = await teeCtx.sql`SELECT 1 FROM charts WHERE id = ${teeCtx.chartId} LIMIT 1`;
        if (rows.length === 0) kind = 'chart_deleted';
      } catch (e) {
        console.error('chart existence lookup failed during not_found interception:', e);
        // Leave as file_unavailable; we can't prove chart_deleted.
      }
    }

    const payload = kind === 'chart_deleted'
      ? { type: 'chart_deleted' }
      : {
          type: 'file_unavailable',
          message: 'A file referenced by this chat is no longer available.',
        };
    const frame = encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    try { controller.enqueue(frame); } catch (e) {
      console.warn('not-found synthesized enqueue failed (controller closed):', e);
    }
    teeCtx.killed.v = true;
    try { controller.terminate(); } catch { /* ignore */ }
    try { teeCtx.abortController.abort(); } catch { /* ignore */ }
    resolveDone();
    return true;
  }

  /**
   * Parse a completed SSE frame for usage/error content. Returns true if the
   * caller should swallow the raw frame (not forward to the client) — this
   * happens when we synthesize a typed `not_found` error in its place.
   */
  async function parseFrame(
    frame: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): Promise<boolean> {
    // An SSE frame is one or more `field: value` lines. We only care about
    // the `data:` field; the semantic type duplicates inside the JSON data
    // (`type` property), which is more reliable than parsing `event:`.
    const lines = frame.split('\n');
    let dataJson: string | null = null;
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataJson = line.slice(5).trimStart();
        break;
      }
    }
    if (!dataJson || dataJson === '[DONE]') return false;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataJson) as Record<string, unknown>;
    } catch {
      return false;
    }

    // File-not-found interception takes priority: we replace the raw
    // `not_found_error` frame with a typed `chart_deleted` / `file_unavailable`
    // event, so the caller must NOT forward the original.
    if (await maybeInterceptNotFound(parsed, controller)) return true;

    const eventType = typeof parsed.type === 'string' ? parsed.type : '';

    // message_start: usage on parsed.message.usage
    // message_delta: usage on parsed.usage
    let usageObj: Record<string, unknown> | null = null;
    if (eventType === 'message_start') {
      const msg = parsed.message;
      if (msg && typeof msg === 'object' && !Array.isArray(msg)) {
        const u = (msg as Record<string, unknown>).usage;
        if (u && typeof u === 'object' && !Array.isArray(u)) {
          usageObj = u as Record<string, unknown>;
        }
      }
    } else if (eventType === 'message_delta') {
      const u = parsed.usage;
      if (u && typeof u === 'object' && !Array.isArray(u)) {
        usageObj = u as Record<string, unknown>;
      }
    }
    if (!usageObj) return false;

    mergeUsage(teeCtx.accumulator, usageObj);

    // Kill-switch only runs for capped tiers. BYOK passes teeCtx.killThresholdMicro
    // as null — the user is paying, no bound applies on our side.
    if (teeCtx.killThresholdMicro === null) return false;

    let cumulativeMicro: bigint;
    try {
      cumulativeMicro = computeCostMicroUsd(
        teeCtx.model,
        accumulatorToUsage(teeCtx.accumulator),
      );
    } catch (e) {
      console.error('cost compute failed (non-fatal, continuing):', e);
      return false;
    }

    if (cumulativeMicro > teeCtx.killThresholdMicro) {
      teeCtx.killed.v = true;
      const payload = JSON.stringify({
        type: 'request_cost_ceiling_exceeded',
        limit_usd: microToUsd(teeCtx.killThresholdMicro),
      });
      const killFrame = encoder.encode(`event: error\ndata: ${payload}\n\n`);
      try {
        controller.enqueue(killFrame);
      } catch (e) {
        console.warn('kill-switch enqueue failed (controller closed):', e);
      }
      try {
        controller.terminate();
      } catch { /* ignore */ }
      try {
        teeCtx.abortController.abort();
      } catch { /* ignore */ }
      // terminate() doesn't run flush(); resolve done directly so reconcile
      // doesn't hang waiting for a flush that never comes.
      resolveDone();
      // The caller loop checks teeCtx.killed.v and returns without forwarding
      // the triggering frame — client sees [earlier frames] + synthesized kill.
      return false;
    }
    return false;
  }

  /**
   * Forward a completed SSE frame verbatim plus its trailing `\n\n` separator.
   * Called from the TransformStream only after `maybeInterceptNotFound` has
   * had a chance to swallow the frame — so the client never sees Anthropic's
   * raw `not_found_error` followed by our synthesized variant.
   */
  function forwardFrame(frame: string, controller: TransformStreamDefaultController<Uint8Array>): void {
    if (frame.length === 0) return;
    try {
      controller.enqueue(encoder.encode(frame + '\n\n'));
    } catch (e) {
      console.warn('frame forward failed (controller closed):', e);
    }
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (teeCtx.killed.v) {
        try { controller.terminate(); } catch { /* ignore */ }
        return;
      }

      sseBuffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
        const frame = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);

        // parseFrame may swallow a not_found_error frame; in that case it sets
        // killed.v and we must NOT forward the raw Anthropic error too.
        const intercepted = await parseFrame(frame, controller);
        if (teeCtx.killed.v) {
          // resolveDone was called by parseFrame.
          return;
        }
        if (!intercepted) {
          forwardFrame(frame, controller);
        }
      }
    },
    flush(controller) {
      // If there are any trailing bytes after the last `\n\n`, pass them
      // through as-is. Anthropic always terminates frames with `\n\n`, so this
      // is empty in the success path; covers truncation / unexpected endings.
      if (sseBuffer.length > 0) {
        try { controller.enqueue(encoder.encode(sseBuffer)); } catch { /* ignore */ }
      }
      resolveDone();
    },
    cancel() {
      // Downstream cancelled (client disconnect) — resolve so reconcile can
      // proceed with the partial accumulator we have.
      resolveDone();
    },
  });

  return { stream: source.pipeThrough(transform), done };
}

// --- Anthropic billing-error detection -----------------------------------

function looksLikeBillingError(status: number, errorBody: unknown): boolean {
  if (!errorBody || typeof errorBody !== 'object') return false;
  const e = (errorBody as { error?: unknown }).error;
  if (!e || typeof e !== 'object') return false;
  const err = e as { type?: unknown; message?: unknown };
  if (status === 402 && err.type === 'billing_error') return true;
  if (status === 429 && typeof err.message === 'string'
      && /spend|cap|limit/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * Classify an Anthropic `not_found_error` (seen as SSE error event or HTTP
 * 404) into `chart_deleted` vs `file_unavailable`. Without a chart_id we can
 * only assume the specific file is gone; with one we can prove the chart
 * itself was deleted.
 */
async function classifyNotFound(
  sql: NeonQueryFunction<false, false>,
  chartId: string | null,
): Promise<'chart_deleted' | 'file_unavailable'> {
  if (!chartId) return 'file_unavailable';
  try {
    const rows = await sql`SELECT 1 FROM charts WHERE id = ${chartId} LIMIT 1`;
    return rows.length === 0 ? 'chart_deleted' : 'file_unavailable';
  } catch (e) {
    console.error('classifyNotFound: charts lookup failed', e);
    return 'file_unavailable';
  }
}

// --- Main handler -------------------------------------------------------

export async function handler(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // HTTP/2 fallback: when SSE streaming fails over HTTP/3 (QUIC), the client
  // retries with ?force-h2=1. The response includes Alt-Svc: clear (RFC 7838)
  // to tell the browser to stop using H3 for this origin.
  const requestUrl = new URL(request.url);
  const forceH2 = requestUrl.searchParams.get('force-h2') === '1';
  const altSvcHeaders: Record<string, string> = forceH2 ? { 'Alt-Svc': 'clear' } : {};

  if (request.method !== 'POST') {
    return jsonError({ error: 'Method not allowed' }, 405, altSvcHeaders);
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonError({ error: 'API key not configured on server' }, 500, altSvcHeaders);
  }

  // Step 1: body size clamp + JSON parse.
  const bodyResult = await readBodyWithSizeClamp(request, altSvcHeaders);
  if (!bodyResult.ok) return bodyResult.response;
  const body = bodyResult.body;

  // Optional client context headers (safe to read before auth).
  const chartId = request.headers.get('x-chart-id');
  const loggingMessageId = request.headers.get('x-logging-message-id');

  // Step 2: actor.
  const actor = await resolveActor(request, env, altSvcHeaders);
  if (!actor.ok) return actor.response;
  const actorId = actor.actorId;

  const sql = getDb(env);

  // Step 3: BYOK resolution.
  //
  // Priority order for the x-api-key forwarded upstream:
  //   1. `X-User-Anthropic-Key` header — legacy path for an explicit per-request
  //      override (a user testing a different key without re-saving it).
  //   2. Server-stored `user_byok_keys` row for authenticated users — the
  //      Round-2 design: key is stored once, encrypted, and loaded here.
  //   3. Our `ANTHROPIC_API_KEY` fallback for the free/anon tier.
  //
  // Anonymous actors cannot BYOK — they have no user_id to key the row on.
  const byokHeaderKey = request.headers.get('x-user-anthropic-key');
  let byokKey: string | null = byokHeaderKey;
  let hasByok = !!byokKey;

  if (!hasByok && actor.authenticated) {
    let encryptedKey: Uint8Array | ArrayBuffer | null = null;
    try {
      const rows = await sql`
        SELECT encrypted_key FROM user_byok_keys WHERE user_id = ${actorId} LIMIT 1
      ` as { encrypted_key: Uint8Array | ArrayBuffer | null }[];
      encryptedKey = rows[0]?.encrypted_key ?? null;
    } catch (e) {
      console.error('[anthropic-stream] BYOK lookup Neon error', e);
      return jsonError({ error: 'db_unavailable' }, 503, altSvcHeaders);
    }

    if (encryptedKey) {
      if (!env.BYOK_ENCRYPTION_KEY) {
        // Row exists but we can't decrypt. Fail closed — silently falling back
        // to our server key would bill us for a BYOK user.
        return jsonError({ error: 'byok_not_configured' }, 503, altSvcHeaders);
      }
      try {
        const stored = encryptedKey instanceof Uint8Array
          ? encryptedKey
          : new Uint8Array(encryptedKey);
        byokKey = await decryptByokKey(stored, actorId, env.BYOK_ENCRYPTION_KEY);
        hasByok = true;
      } catch (e) {
        console.error('[anthropic-stream] BYOK decrypt failed', e);
        return jsonError({ error: 'byok_not_configured' }, 503, altSvcHeaders);
      }
    }
  }

  const tier = tierFor(actorId, hasByok);

  // Step 4: turnstile session cookie for anon.
  // missing / expired / ip_mismatch / invalid all map to the same client UX:
  // solve a fresh challenge and retry.
  if (needTurnstile(tier)) {
    const result = await verifyTurnstileFromCookie(request, env);
    if (result !== 'ok' && result !== 'not-configured') {
      return jsonError({ error: 'turnstile_required' }, 401, altSvcHeaders);
    }
  }

  // Step 5: idempotency.
  const idempotencyKey = request.headers.get('x-idempotency-key');
  if (idempotencyKey && isUuidish(idempotencyKey)) {
    const claimed = await claimIdempotencyKey(sql, actorId, idempotencyKey);
    if (!claimed) {
      return jsonError({ error: 'idempotent_replay' }, 409, altSvcHeaders);
    }
  }

  // Step 6 + 7: estimate + reserve (skipped for BYOK).
  let projected: bigint = 0n;
  let model = typeof body.model === 'string' ? body.model : DEFAULT_MODEL;
  let postReservationUsage: bigint = 0n;
  if (isCapped(tier)) {
    const est = await estimateProjectedCost(body, env, altSvcHeaders);
    if (!est.ok) return est.response;
    projected = est.projected;
    model = est.model;

    const reserve = await reserveCost(sql, actorId, projected, tier, altSvcHeaders);
    if (!reserve.ok) return reserve.response;
    postReservationUsage = reserve.postReservationUsage;
  } else {
    // BYOK — still validate the model so computeCostMicroUsd won't throw later
    // (not that we call it in BYOK reconcile, but stay defensive).
    const rate = RATES_MICRO_USD_PER_TOKEN[model];
    if (!rate) {
      console.warn('Unknown model on BYOK request (passing through):', model);
    }
  }

  // Step 8: upstream fetch. For our metered path we set metadata.user_id so
  // Anthropic abuse-detection can attribute. For BYOK we strip `body.metadata`
  // entirely — otherwise our internal user_ids pollute the BYOK user's own
  // Anthropic account dashboard.
  if (hasByok) {
    delete body.metadata;
  } else {
    body.metadata = { user_id: actorId };
  }

  const abortController = new AbortController();

  // Propagate client disconnect to the upstream Anthropic request. Without
  // this, hitting Stop (or a dropped connection) only closes the browser↔
  // worker leg; Claude keeps generating tokens the user never sees — which
  // for BYOK users means they're billed for output after they've stopped
  // caring. Brief network blips are the stated trade-off, but the response
  // is already gone from the browser in that case, so aborting is a strict
  // improvement over keeping the bill running.
  request.signal.addEventListener('abort', () => {
    console.log(JSON.stringify({
      event: 'client_disconnect',
      timestamp: new Date().toISOString(),
      userId: actorId,
      tier,
    }));
    try { abortController.abort(); } catch { /* ignore */ }
  });
  let upstream: Response;
  try {
    upstream = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': byokKey ?? apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
      },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });
  } catch (e) {
    console.error('Upstream fetch failed:', e);
    if (isCapped(tier)) revertReservation(ctx, sql, actorId, projected);
    return jsonError(
      { error: 'upstream_unavailable', details: e instanceof Error ? e.message : 'Unknown error' },
      502,
      altSvcHeaders,
    );
  }

  if (!upstream.ok) {
    const errorText = await upstream.text();
    console.error(`Anthropic API error (${upstream.status}):`, errorText);
    if (isCapped(tier)) revertReservation(ctx, sql, actorId, projected);

    // Detect global budget exhaustion (Anthropic Console cap).
    let parsedError: unknown;
    try { parsedError = JSON.parse(errorText); } catch { /* non-JSON body */ }
    if (looksLikeBillingError(upstream.status, parsedError)) {
      return jsonError(
        {
          error: 'global_budget_exhausted',
          resets_at: firstOfNextMonthUtcIso(),
          remedies: ['byok', 'donate'],
        },
        402,
        altSvcHeaders,
      );
    }

    // HTTP-level 404 on a file reference also goes through the chart-deleted /
    // file-unavailable synthesis path, so the client doesn't see a raw 404.
    if (upstream.status === 404) {
      const kind = await classifyNotFound(sql, chartId);
      const payload = kind === 'chart_deleted'
        ? { error: 'chart_deleted' }
        : { error: 'file_unavailable', message: 'A file referenced by this chat is no longer available.' };
      return jsonError(payload, 404, altSvcHeaders);
    }

    return new Response(errorText, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', ...altSvcHeaders },
    });
  }

  if (!upstream.body) {
    if (isCapped(tier)) revertReservation(ctx, sql, actorId, projected);
    return jsonError({ error: 'AI service returned empty response' }, 502, altSvcHeaders);
  }

  // Step 9: cost-tracking tee + kill-switch.
  const accumulator = newAccumulator();
  const killed = { v: false };

  // Kill threshold: cumulative actual cost must not exceed remaining_cap measured
  // BEFORE this request's reservation was deducted. Since the reservation has
  // already been debited, that's LIFETIME_CAP - (post_reservation - projected).
  // For BYOK the cap doesn't apply — null disables the check in the tee.
  const killThresholdMicro: bigint | null = isCapped(tier)
    ? (LIFETIME_CAP_MICRO_USD - (postReservationUsage - projected))
    : null;

  const teeCtx: SseTeeContext = {
    accumulator,
    killThresholdMicro,
    model,
    abortController,
    killed,
    chartId,
    sql,
  };

  const tracked = createCostTrackingStream(upstream.body, teeCtx);
  const keepaliveStream = createKeepaliveStream(tracked.stream, request.signal);

  // Step 10: post-stream reconcile. ctx.waitUntil extends the Worker lifetime
  // past the Response being fully flushed so we still get the DB write. Skip
  // user_api_usage / global_monthly_usage updates for BYOK (no reservation to
  // reconcile), but always try to write logging_messages.cost_micro_usd when
  // a message_id was supplied — it's the per-chart attribution key and is
  // independent of tier.
  ctx.waitUntil((async () => {
    // Wait for the SSE stream to finish (natural end, kill-switch, or
    // client-cancel). Once `tracked.done` resolves, the accumulator is
    // stable — no further transform() callbacks will mutate it.
    await tracked.done;

    let actualMicro: bigint;
    try {
      actualMicro = computeCostMicroUsd(model, accumulatorToUsage(accumulator));
    } catch (e) {
      console.error('Post-stream cost computation failed:', e);
      return;
    }

    if (isCapped(tier)) {
      try {
        const deltaMicro = actualMicro - projected;
        await sql`
          UPDATE user_api_usage
          SET cost_micro_usd        = cost_micro_usd + ${deltaMicro.toString()}::bigint,
              input_tokens          = input_tokens + ${accumulator.input_tokens},
              output_tokens         = output_tokens + ${accumulator.output_tokens},
              cache_create_tokens   = cache_create_tokens + ${accumulator.cache_creation_input_tokens},
              cache_read_tokens     = cache_read_tokens + ${accumulator.cache_read_input_tokens},
              web_search_uses       = web_search_uses + ${accumulator.web_search_requests},
              last_activity_at      = NOW()
          WHERE user_id = ${actorId}
        `;
        await sql`
          INSERT INTO global_monthly_usage (month_start, cost_micro_usd)
          VALUES (DATE_TRUNC('month', NOW() AT TIME ZONE 'UTC')::date, ${actualMicro.toString()}::bigint)
          ON CONFLICT (month_start) DO UPDATE
          SET cost_micro_usd = global_monthly_usage.cost_micro_usd + EXCLUDED.cost_micro_usd
        `;
      } catch (e) {
        console.error('Post-stream reconcile failed:', e);
      }
    }

    // Per-message attribution: populate logging_messages.cost_micro_usd so
    // per-chart cost queries can JOIN + SUM without a separate aggregate. Only
    // runs if the client passed X-Logging-Message-Id. Fire-and-forget.
    if (loggingMessageId && actualMicro > 0n) {
      try {
        await sql`
          UPDATE logging_messages
          SET cost_micro_usd = ${actualMicro.toString()}::bigint
          WHERE message_id = ${loggingMessageId}
        `;
      } catch (e) {
        console.error('logging_messages cost update failed (non-fatal):', e);
      }
    }
  })());

  return new Response(keepaliveStream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      ...altSvcHeaders,
    },
  });
}

// --- Revert reservation (fire-and-forget on pre-stream failure) --------

function revertReservation(
  ctx: ExecutionContext,
  sql: NeonQueryFunction<false, false>,
  userId: string,
  projected: bigint,
): void {
  if (projected === 0n) return;
  const minusProj = (-projected).toString();
  ctx.waitUntil((async () => {
    try {
      await sql`
        UPDATE user_api_usage
        SET cost_micro_usd = GREATEST(0::bigint, cost_micro_usd + ${minusProj}::bigint)
        WHERE user_id = ${userId}
      `;
    } catch (e) {
      console.error('Reservation revert failed (leaves a small over-reservation):', e);
    }
  })());
}
