import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import {
  computeCostMicroUsd,
  RATES_MICRO_USD_PER_TOKEN,
  type AnthropicUsage,
} from '../_shared/cost';
import {
  LIFETIME_CAP_USD,
  LIFETIME_CAP_MICRO_USD,
  PER_REQUEST_CAP_MICRO_USD,
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
 *   1. Body-size clamp (reject 413 if > BODY_SIZE_LIMIT_BYTES).
 *   2. JWT verify (if Authorization header present) → actor_id = sub or anon-<hmac(ip)>.
 *   3. Tier classification (anon / free / byok).
 *   4. Turnstile check for anon (skipped if TURNSTILE_SECRET_KEY unset).
 *   5. Idempotency de-dup via idempotency_keys table (60s window).
 *   6. Pre-flight cost estimate via /v1/messages/count_tokens.
 *   7. Atomic reservation against user_api_usage (skipped for BYOK).
 *   8. Upstream fetch; detect Anthropic billing-error → 402 global_budget_exhausted.
 *   9. Stream through a TransformStream that parses SSE usage events and enforces
 *      the mid-stream kill switch (abort when cumulative > min(reservation × 1.2,
 *      PER_REQUEST_CAP_MICRO_USD × 1.2)).
 *  10. Post-stream reconcile: adjust user_api_usage + global_monthly_usage for
 *      actual vs projected cost.
 *
 * On upstream error after reservation, the reservation is reverted in
 * ctx.waitUntil. BYOK requests bypass steps 7 / 9 / 10's reconcile writes.
 *
 * FOLLOW-UPS (explicitly deferred):
 *  - File-not-found interception (chart_deleted / file_unavailable synthesized events):
 *    requires threading chart_id into the request — the API body has no canonical
 *    slot for it today. Do as a follow-up once the client passes chart_id.
 *  - logging_messages.cost_micro_usd reconciliation: requires message_id coordination
 *    between anthropic-stream and the logging API. Follow-up unit.
 */

// --- Constants ----------------------------------------------------------

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_COUNT_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BETA = 'files-api-2025-04-14';
const DEFAULT_MODEL = 'claude-opus-4-7';

// Max kill-switch threshold regardless of how small the projected reservation is.
// Keeps the cap from starving legitimate bursts while still protecting against
// a runaway stream that is orders-of-magnitude over the pre-flight estimate.
const KILL_MULTIPLIER_NUM = 12n;
const KILL_MULTIPLIER_DEN = 10n;

// --- Helpers: IP / JSON / HTTP ------------------------------------------

async function hashIP(ip: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function extractIP(request: Request): string {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';
}

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

  // Concatenate in one pass — small sizes (<256KB), not worth a TransformStream.
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
  | { ok: true; actorId: string; emailVerified: boolean; authenticated: boolean }
  | { ok: false; response: Response };

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
    const emailVerified = decoded.email_verified === true;
    if (!emailVerified) {
      return { ok: false, response: jsonError({ error: 'email_verification_required' }, 401, altSvcHeaders) };
    }
    return { ok: true, actorId: decoded.sub, emailVerified: true, authenticated: true };
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
  return { ok: true, actorId, emailVerified: false, authenticated: false };
}

// --- Turnstile ----------------------------------------------------------

async function verifyTurnstile(
  request: Request,
  env: Env,
): Promise<'ok' | 'missing' | 'failed' | 'not-configured'> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.warn('Turnstile not configured; skipping anon bot check');
    return 'not-configured';
  }
  const turnstileToken = request.headers.get('x-turnstile-token');
  if (!turnstileToken) return 'missing';

  try {
    const form = new URLSearchParams();
    form.set('secret', secret);
    form.set('response', turnstileToken);
    const ip = extractIP(request);
    if (ip && ip !== 'unknown') form.set('remoteip', ip);

    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!r.ok) return 'failed';
    const data = await r.json() as { success?: boolean };
    return data.success === true ? 'ok' : 'failed';
  } catch (e) {
    console.error('Turnstile verification error:', e);
    return 'failed';
  }
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

  // count_tokens rejects streaming-only fields; strip them. Everything else
  // (messages, system, tools, etc.) is accepted verbatim.
  const countBody: Record<string, unknown> = { ...body };
  delete countBody.stream;
  delete countBody.metadata;

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
    console.error('count_tokens network error:', e);
    // Fail closed: we can't estimate, so we can't enforce. Reuse
    // database_unavailable since it's the closest catch-all 503.
    return {
      ok: false,
      response: jsonError({ error: 'database_unavailable' }, 503, altSvcHeaders),
    };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    console.error(`count_tokens failed (${resp.status}): ${text}`);
    return {
      ok: false,
      response: jsonError({ error: 'database_unavailable' }, 503, altSvcHeaders),
    };
  }

  let data: { input_tokens?: number };
  try {
    data = await resp.json() as { input_tokens?: number };
  } catch {
    return { ok: false, response: jsonError({ error: 'database_unavailable' }, 503, altSvcHeaders) };
  }

  const inputTokens = typeof data.input_tokens === 'number' ? data.input_tokens : 0;
  const projected = BigInt(inputTokens) * BigInt(rate.input);
  return { ok: true, projected, model };
}

type ReserveResult =
  | { ok: true }
  | { ok: false; response: Response };

/**
 * Atomically reserve `projected` µUSD against user_api_usage. Either:
 *   - updates an existing row (cap-respecting guard in WHERE),
 *   - inserts a new row on first use,
 *   - or reports the user is already at/over the cap (429).
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
    console.error('reserve UPDATE failed:', e);
    return { ok: false, response: jsonError({ error: 'database_unavailable' }, 503, altSvcHeaders) };
  }

  if (updateRows.length > 0) return { ok: true };

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
    console.error('reserve INSERT failed:', e);
    return { ok: false, response: jsonError({ error: 'database_unavailable' }, 503, altSvcHeaders) };
  }

  if (insertRows.length > 0) return { ok: true };

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
  killThresholdMicro: bigint;
  model: string;
  abortController: AbortController;
  /** Set to true when we fire the kill switch so downstream short-circuits. */
  killed: { v: boolean };
};

/**
 * Pipes the upstream SSE stream through a TransformStream that:
 *  - forwards every byte verbatim,
 *  - parses `data: {...}` frames as they complete,
 *  - accumulates usage,
 *  - fires the kill switch by enqueueing a synthesized error event and
 *    aborting the upstream fetch.
 *
 * The SSE frame parser keeps a tail buffer for partial frames; Anthropic's
 * stream can split a single frame across chunks (especially with cache/Worker
 * buffering). We split on the canonical frame separator `\n\n`.
 *
 * Returns both the transformed stream AND a `done` Promise that resolves
 * when the stream completes (naturally or via kill-switch). The caller uses
 * `done` to synchronize post-stream reconcile without racing against
 * incomplete accumulator state.
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

  function parseFrame(
    frame: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
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
    if (!dataJson || dataJson === '[DONE]') return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataJson) as Record<string, unknown>;
    } catch {
      return;
    }

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
    if (!usageObj) return;

    mergeUsage(teeCtx.accumulator, usageObj);

    // Kill-switch check.
    let cumulativeMicro: bigint;
    try {
      cumulativeMicro = computeCostMicroUsd(
        teeCtx.model,
        accumulatorToUsage(teeCtx.accumulator),
      );
    } catch (e) {
      console.error('cost compute failed (non-fatal, continuing):', e);
      return;
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
    }
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (teeCtx.killed.v) {
        try { controller.terminate(); } catch { /* ignore */ }
        return;
      }
      controller.enqueue(chunk);

      sseBuffer += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
        const frame = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);
        parseFrame(frame, controller);
        if (teeCtx.killed.v) {
          // resolveDone is called in flush(); terminate() triggers that.
          return;
        }
      }
    },
    flush() {
      // Any remaining buffered frame is incomplete — ignore.
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

  // Step 2 + 3: actor + tier.
  const actor = await resolveActor(request, env, altSvcHeaders);
  if (!actor.ok) return actor.response;
  const actorId = actor.actorId;

  const byokKey = request.headers.get('x-user-anthropic-key');
  const hasByok = !!byokKey;
  const tier = tierFor(actorId, hasByok);

  // Step 4: turnstile for anon.
  if (needTurnstile(tier)) {
    const result = await verifyTurnstile(request, env);
    if (result === 'missing') return jsonError({ error: 'turnstile_required' }, 401, altSvcHeaders);
    if (result === 'failed') return jsonError({ error: 'turnstile_failed' }, 401, altSvcHeaders);
    // 'ok' or 'not-configured' → proceed.
  }

  const sql = getDb(env);

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
  if (isCapped(tier)) {
    const est = await estimateProjectedCost(body, env, altSvcHeaders);
    if (!est.ok) return est.response;
    projected = est.projected;
    model = est.model;

    const reserve = await reserveCost(sql, actorId, projected, tier, altSvcHeaders);
    if (!reserve.ok) return reserve.response;
  } else {
    // BYOK — still validate the model so computeCostMicroUsd won't throw later
    // (not that we call it in BYOK reconcile, but stay defensive).
    const rate = RATES_MICRO_USD_PER_TOKEN[model];
    if (!rate) {
      console.warn('Unknown model on BYOK request (passing through):', model);
    }
  }

  // Log client disconnects for transport-layer debugging.
  request.signal.addEventListener('abort', () => {
    console.log(JSON.stringify({
      event: 'client_disconnect',
      timestamp: new Date().toISOString(),
      userId: actorId,
      tier,
    }));
  });

  // Step 8: upstream fetch. We add metadata.user_id here (never trust client).
  body.metadata = { user_id: actorId };

  const abortController = new AbortController();
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
          month_budget_usd: 100,
          used_usd: 100,
          resets_at: firstOfNextMonthUtcIso(),
          remedies: ['byok', 'donate'],
        },
        402,
        altSvcHeaders,
      );
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

  // Threshold is min(projected × 1.2, PER_REQUEST_CAP × 1.2). For BYOK, use
  // just the flat cap — we didn't reserve so there's no "projected" to scale.
  const projectedThreshold = isCapped(tier)
    ? (projected * KILL_MULTIPLIER_NUM) / KILL_MULTIPLIER_DEN
    : (PER_REQUEST_CAP_MICRO_USD * KILL_MULTIPLIER_NUM) / KILL_MULTIPLIER_DEN;
  const flatThreshold = (PER_REQUEST_CAP_MICRO_USD * KILL_MULTIPLIER_NUM) / KILL_MULTIPLIER_DEN;
  const killThresholdMicro = projectedThreshold < flatThreshold ? projectedThreshold : flatThreshold;

  const teeCtx: SseTeeContext = {
    accumulator,
    killThresholdMicro,
    model,
    abortController,
    killed,
  };

  const tracked = createCostTrackingStream(upstream.body, teeCtx);
  const keepaliveStream = createKeepaliveStream(tracked.stream, request.signal);

  // Step 10: post-stream reconcile. ctx.waitUntil extends the Worker lifetime
  // past the Response being fully flushed so we still get the DB write. Skip
  // for BYOK — we didn't reserve anything to reconcile.
  if (isCapped(tier)) {
    ctx.waitUntil((async () => {
      // Wait for the SSE stream to finish (natural end, kill-switch, or
      // client-cancel). Once `tracked.done` resolves, the accumulator is
      // stable — no further transform() callbacks will mutate it.
      await tracked.done;
      try {
        const actualMicro = computeCostMicroUsd(model, accumulatorToUsage(accumulator));
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
    })());
  }

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
