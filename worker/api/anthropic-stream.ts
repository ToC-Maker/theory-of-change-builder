import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { decryptByokKey } from '../_shared/byok-crypto';
import { isUserOptedOut } from '../_shared/logging-optout';
import { extractTurnstileCookie, verifyTurnstileCookie } from '../_shared/turnstile-cookie';
import {
  resolveAnonActor,
  mergeAnonUsageIntoAuth,
  signAuthLinkCookie,
  buildAuthLinkCookieHeader,
} from '../_shared/anon-id';
import {
  computeCostMicroUsd,
  RATES_MICRO_USD_PER_TOKEN,
  WEB_SEARCH_MICRO_USD_PER_USE,
  type AnthropicUsage,
} from '../_shared/cost';
import {
  LIFETIME_CAP_USD,
  LIFETIME_CAP_MICRO_USD,
  EFFECTIVE_LIFETIME_CAP_MICRO_USD,
  BODY_SIZE_LIMIT_BYTES,
  tierFor,
  isCapped,
  needTurnstile,
  allowByok,
  type Tier,
} from '../_shared/tiers';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { AssistantBlock } from '../../shared/chat-blocks';

/**
 * HTTP streaming proxy for Anthropic's /v1/messages endpoint with server-side
 * cost enforcement. The pipeline, in order:
 *
 *   1. Body-size clamp (reject 413 if > BODY_SIZE_LIMIT_BYTES, currently 32 MB).
 *   2. JWT verify (if Authorization header present) → actor_id = sub or anon-<uuid>.
 *   3. Tier classification (anon / free / byok). Authenticated users with a row in
 *      user_byok_keys are promoted to the byok tier; header `X-User-Anthropic-Key`
 *      (legacy) is honored only for authenticated callers — from anon it is
 *      dropped to prevent bypassing Turnstile and the lifetime cap.
 *   4. Turnstile session cookie check for anon (skipped if TURNSTILE_SECRET_KEY unset).
 *      Cookie is issued by POST /api/verify-turnstile and bound to the caller's
 *      cookie-pinned anon_id.
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
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
  ).toISOString();
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
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  if (!request.body) {
    return {
      ok: false,
      response: jsonError({ error: 'Invalid JSON in request body' }, 400, altSvcHeaders),
    };
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
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
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
      return {
        ok: false,
        response: jsonError({ error: 'Invalid JSON in request body' }, 400, altSvcHeaders),
      };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      response: jsonError({ error: 'Invalid JSON in request body' }, 400, altSvcHeaders),
    };
  }
}

// --- Actor / tier resolution --------------------------------------------

type ActorResult =
  | {
      ok: true;
      actorId: string;
      authenticated: boolean;
      /** Set when resolveAnonActor minted a fresh tocb_actor_id cookie. */
      anonSetCookie?: string;
      /** Set when the JWT verified and we (re-)signed the tocb_auth_link
       *  cookie. Caller must append both to the outbound response. */
      authLinkSetCookie?: string;
    }
  | { ok: false; response: Response };

// Email verification is enforced upstream in Auth0 via a Post-Login Action
// that denies login for users with `event.user.email_verified === false`.
// Auth0 only issues tokens for verified users, so anyone reaching this
// handler with a valid JWT is implicitly verified — no in-worker check needed.
async function resolveActor(
  request: Request,
  env: Env,
  altSvcHeaders: Record<string, string>,
  sql: ReturnType<typeof getDb>,
): Promise<ActorResult> {
  const token = extractToken(request.headers.get('authorization'));

  if (token) {
    let decoded;
    try {
      decoded = await verifyToken(token, env);
    } catch (err) {
      if (err instanceof JWKSFetchError) {
        return {
          ok: false,
          response: jsonError({ error: 'authentication_service_unavailable' }, 503, altSvcHeaders),
        };
      }
      return { ok: false, response: jsonError({ error: 'invalid_token' }, 401, altSvcHeaders) };
    }
    // Fold any outstanding anon-cap usage (from a prior session under the
    // tocb_actor_id cookie) into the authenticated identity so sign-in
    // isn't a cap reset. Idempotent and non-fatal — see helper comment.
    await mergeAnonUsageIntoAuth(sql, decoded.sub, request);
    // Mint/refresh the tocb_auth_link cookie so post-logout anon traffic
    // on this browser continues to resolve to this auth sub's cap row
    // (closes the "log out to reset cap" path). Refresh on every auth'd
    // request so an active user's cookie stays well inside its 1y TTL.
    const authLinkSetCookie = buildAuthLinkCookieHeader(
      await signAuthLinkCookie(decoded.sub, env.IP_HASH_SALT),
    );
    return {
      ok: true,
      actorId: decoded.sub,
      authenticated: true,
      authLinkSetCookie,
    };
  }

  // Anonymous path: cookie-first identity. resolveAnonActor itself checks
  // tocb_auth_link before tocb_actor_id, so a post-logout browser still
  // resolves to its prior auth sub's cap row.
  try {
    const resolved = await resolveAnonActor(request, env);
    return {
      ok: true,
      actorId: resolved.userId,
      authenticated: false,
      anonSetCookie: resolved.setCookieHeader,
    };
  } catch (e) {
    // Fail closed: falling through to a shared `anon-unknown` bucket lets one
    // buggy client DoS every other anon caller through their shared cap row.
    // A 503 here tells the caller to retry; the next attempt mints a fresh
    // cookie-pinned id and the problem resolves itself.
    console.error('Failed to resolve anonymous actor:', e);
    return {
      ok: false,
      response: jsonError(
        {
          error: 'actor_unavailable',
          upstream_message: 'anonymous identity could not be resolved, please retry',
        },
        503,
        altSvcHeaders,
      ),
    };
  }
}

// --- Turnstile session cookie ------------------------------------------

type TurnstileResult =
  | 'ok'
  | 'missing'
  | 'expired'
  | 'actor_mismatch'
  | 'invalid'
  | 'not-configured';

/**
 * Verify the Turnstile session cookie issued by POST /api/verify-turnstile.
 *
 * The cookie carries the anon_id the session was minted for. Identity is
 * now cookie-pinned (UUID) rather than IP-hash, so IP changes no longer
 * invalidate the cookie — binding moves with the actor rather than with
 * the network. TTL is enforced by the `exp` field inside the signed
 * payload; cookie-cleared clients get a fresh identity + fresh challenge.
 *
 * When TURNSTILE_SECRET_KEY is unset (local dev / pre-launch), skip the
 * check entirely so the anon path still works.
 */
async function verifyTurnstileFromCookie(
  request: Request,
  env: Env,
  actorId: string,
): Promise<TurnstileResult> {
  if (!env.TURNSTILE_SECRET_KEY) {
    console.warn('Turnstile not configured; skipping anon session-cookie check');
    return 'not-configured';
  }

  const cookieValue = extractTurnstileCookie(request.headers.get('cookie'));
  if (!cookieValue) return 'missing';

  // Strip the 'anon-' prefix — Turnstile cookie payload binds to the raw
  // identity value (matches verify-turnstile.ts:signTurnstileCookie's
  // input).
  const expectedAnonId = actorId.startsWith('anon-') ? actorId.slice(5) : actorId;
  return verifyTurnstileCookie(cookieValue, expectedAnonId, env.IP_HASH_SALT);
}

// --- Idempotency --------------------------------------------------------

/**
 * Returns true if the insert succeeded (first time we've seen this key in the
 * window). Returns false on conflict (replay). On DB error, returns true and
 * logs — reserveCost fails closed on Neon outage, so this idempotency check
 * can safely fail open: the reservation blocks the request before any
 * upstream call, and a DB outage that bypasses dedup is strictly less bad
 * than one that blocks every legitimate request.
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
  | {
      ok: true;
      projected: bigint;
      model: string;
      inputTokens: number;
      countBody: Record<string, unknown>;
    }
  | { ok: false; response: Response };

/**
 * Build a count_tokens-compatible body from a /v1/messages body.
 *
 * count_tokens only accepts a narrow subset of /v1/messages fields
 * (messages, model, system, tools, tool_choice, thinking, output_config,
 * cache_control — per the API reference). Anything else (notably
 * `max_tokens`, `stream`, `metadata`, `temperature`, `top_p`, `top_k`,
 * `stop_sequences`) returns 400. Whitelist instead of blacklist so we
 * don't silently break whenever the client adds a new field.
 *
 * Also strips server tools (`web_search_*`, `code_execution_*`) — count_tokens
 * rejects them with "Server tools are not supported in the count_tokens
 * endpoint. Use the /v1/messages endpoint instead." Undocumented but
 * observed in production. User-defined function tools are preserved so their
 * definitions still count toward the token total.
 */
export function stripToCountTokensBody(body: Record<string, unknown>): Record<string, unknown> {
  // NOTE: `cache_control` is INTENTIONALLY not in the allow-list. Passing it
  // to count_tokens makes Anthropic return only the NON-cached token count,
  // which wildly under-estimates our cost projection for long conversations
  // whose prefix is already cached. We want the total token count as a
  // conservative upper bound; cache discounts apply at billing time, not
  // estimation time. (We also strip nested cache_control markers below.)
  const COUNT_TOKENS_ALLOWED = new Set([
    'messages',
    'model',
    'system',
    'tools',
    'tool_choice',
    'thinking',
    'output_config',
  ]);
  const countBody: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (COUNT_TOKENS_ALLOWED.has(k)) countBody[k] = v;
  }

  if (Array.isArray(countBody.tools)) {
    const filtered = (countBody.tools as Array<Record<string, unknown>>).filter((t) => {
      const type = typeof t?.type === 'string' ? t.type : '';
      return !type.startsWith('web_search_') && !type.startsWith('code_execution_');
    });
    if (filtered.length > 0) countBody.tools = filtered;
    else delete countBody.tools;
  }

  // Deep-strip `cache_control` from any nested content block (system[i],
  // messages[i].content[j], tool definitions). Without this, Anthropic still
  // returns the reduced-count behavior based on per-block markers even
  // though we dropped the top-level field.
  const stripCacheControl = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(stripCacheControl);
    if (node && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
        .filter(([k]) => k !== 'cache_control')
        .map(([k, v]) => [k, stripCacheControl(v)] as const);
      return Object.fromEntries(entries);
    }
    return node;
  };
  const withoutCacheControl = stripCacheControl(countBody) as Record<string, unknown>;

  // Strip `{type: 'document', source: {type: 'file', ...}}` content blocks.
  // Anthropic's count_tokens supports document sources of type `base64`,
  // `text`, `content`, and `url` — but NOT `file` (Files-API file_id).
  // Leaving them in returns 400 "messages.*.content.*.source: invalid
  // source type" and breaks preflight entirely when the user has PDFs
  // attached. The /v1/messages endpoint itself does accept file sources;
  // only count_tokens is the problem. We accept a small under-estimate
  // of the PDF's contribution — post-stream reconcile captures the real
  // cost from Anthropic's message_delta usage fields either way.
  if (Array.isArray(withoutCacheControl.messages)) {
    withoutCacheControl.messages = (
      withoutCacheControl.messages as Array<Record<string, unknown>>
    ).map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      const filtered = (msg.content as Array<Record<string, unknown>>).filter((block) => {
        if (block?.type !== 'document') return true;
        const src = block.source as Record<string, unknown> | undefined;
        return src?.type !== 'file';
      });
      return { ...msg, content: filtered };
    });
  }

  return withoutCacheControl;
}

/**
 * Calls /v1/messages/count_tokens with the request body (minus streaming-only
 * fields) to get the exact input-token count. Multiplies by the model's input
 * rate to get projected cost. The actual output cost is reconciled post-stream;
 * the mid-stream kill switch bounds the worst case.
 *
 * Also returns the stripped count_tokens body and initial input-token count so
 * the mid-stream polling kill switch can reuse them without re-stripping.
 */
async function estimateProjectedCost(
  body: Record<string, unknown>,
  env: Env,
  altSvcHeaders: Record<string, string>,
  sql: NeonQueryFunction<false, false>,
  chartId: string | null,
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

  // Extract file_id references before stripping — we'll look up their
  // precise cached token counts (populated at upload time by upload-file.ts)
  // and add them to the projection. count_tokens itself can't count file_id
  // document blocks; without this step preflight would undercount by the
  // full PDF size on file-attached messages and the reservation would be
  // too low.
  const strippedFileIds = extractDocumentFileIds(body);

  const countBody = stripToCountTokensBody(body);

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
    } catch {
      /* non-JSON body; leave undefined */
    }
    return {
      ok: false,
      response: jsonError(
        {
          error: 'estimation_unavailable',
          upstream_status: resp.status,
          upstream_message: upstreamMessage,
        },
        503,
        altSvcHeaders,
      ),
    };
  }

  let data: { input_tokens?: number };
  try {
    data = (await resp.json()) as { input_tokens?: number };
  } catch (e) {
    console.error('[estimate] count_tokens JSON parse failed:', e);
    return {
      ok: false,
      response: jsonError({ error: 'estimation_unavailable' }, 503, altSvcHeaders),
    };
  }

  const baseInputTokens = typeof data.input_tokens === 'number' ? data.input_tokens : 0;

  // Look up precise cached token counts for stripped file_ids. NULL or
  // missing rows contribute 0 — we log and under-project rather than fail
  // the estimate outright; the mid-stream kill switch still catches any
  // significant overshoot.
  //
  // Scope by chart_id when we have one so a file_id belonging to a DIFFERENT
  // chart can't leak its token count via timing. validateFileOwnership has
  // already confirmed each file_id is registered under chartId; this query
  // just keeps the estimator honest on the same axis. When chartId is null
  // (no files in body, so no ownership check either) the lookup is a no-op.
  let cachedFileTokens = 0;
  if (strippedFileIds.length > 0) {
    try {
      const rows = (
        chartId
          ? await sql`
            SELECT file_id, input_tokens
            FROM chart_files
            WHERE file_id = ANY(${strippedFileIds}) AND chart_id = ${chartId}
          `
          : await sql`
            SELECT file_id, input_tokens
            FROM chart_files
            WHERE file_id = ANY(${strippedFileIds})
          `
      ) as { file_id: string; input_tokens: string | number | null }[];
      // Neon returns BIGINT as a string; parse before summing.
      for (const r of rows) {
        const n = r.input_tokens == null ? NaN : Number(r.input_tokens);
        if (Number.isFinite(n) && n >= 0) {
          cachedFileTokens += n;
        }
      }
    } catch (e) {
      console.warn('[estimate] chart_files lookup failed (continuing with base count):', e);
    }
  }

  const totalInputTokens = baseInputTokens + cachedFileTokens;
  const projected = BigInt(totalInputTokens) * BigInt(rate.input);
  // The polling kill switch subtracts initialInputTokens from each poll's
  // result. Polling uses countBody (file_ids already stripped), so the
  // baseline it compares against must be the BASE count — not the cached-
  // file-inclusive total. Otherwise the first poll's delta = -cachedFileTokens
  // and output_tokens_est goes negative.
  return { ok: true, projected, model, inputTokens: baseInputTokens, countBody };
}

/**
 * Walk the original request body's messages and collect every
 * `{type: 'document', source: {type: 'file', file_id: '...'}}` block's
 * file_id. Used by estimateProjectedCost before the Anthropic-unfriendly
 * blocks are stripped out of the count_tokens body.
 */
export function extractDocumentFileIds(body: Record<string, unknown>): string[] {
  const out: string[] = [];
  const messages = body.messages;
  if (!Array.isArray(messages)) return out;
  for (const msg of messages as Array<Record<string, unknown>>) {
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'document') continue;
      const src = block.source as Record<string, unknown> | undefined;
      if (src?.type === 'file' && typeof src.file_id === 'string') {
        out.push(src.file_id);
      }
    }
  }
  return out;
}

type FileOwnershipResult = { ok: true } | { ok: false; response: Response };

/**
 * Before forwarding a request that references file_ids upstream, verify:
 *   1. Caller has access to `chartId` (owner/approved-edit for authed charts,
 *      matching editToken for anon charts — same posture as deleteChart).
 *   2. Every file_id in the body belongs to `chartId` per `chart_files`.
 *
 * Without this, the shared `env.ANTHROPIC_API_KEY` workspace key passes
 * Anthropic's workspace-level file ownership check for ANY file uploaded
 * by ANY free-tier user on our worker — so a leaked file_id would let a
 * different tenant dereference it cross-user. BYOK callers are gated by
 * their own Anthropic workspace key, so we skip this for them.
 */
async function validateFileOwnership(
  request: Request,
  env: Env,
  sql: NeonQueryFunction<false, false>,
  body: Record<string, unknown>,
  chartId: string | null,
  altSvcHeaders: Record<string, string>,
): Promise<FileOwnershipResult> {
  const fileIds = extractDocumentFileIds(body);
  if (fileIds.length === 0) return { ok: true };

  if (!chartId) {
    return {
      ok: false,
      response: jsonError({ error: 'missing_chart_id_for_files' }, 400, altSvcHeaders),
    };
  }

  // Chart access: owned charts require JWT + approved permission row; anon
  // charts require matching editToken in X-Edit-Token.
  const chartRows = (await sql`
    SELECT user_id FROM charts WHERE id = ${chartId}
  `) as { user_id: string | null }[];
  if (!chartRows.length) {
    return { ok: false, response: jsonError({ error: 'chart_not_found' }, 404, altSvcHeaders) };
  }
  const chartOwnerId = chartRows[0].user_id;

  if (chartOwnerId) {
    const token = extractToken(request.headers.get('authorization'));
    let allowed = false;
    if (token) {
      try {
        const decoded = await verifyToken(token, env);
        if (decoded.sub === chartOwnerId) {
          allowed = true;
        } else {
          const perm = (await sql`
            SELECT status FROM chart_permissions
            WHERE chart_id = ${chartId} AND user_id = ${decoded.sub}
          `) as { status: string }[];
          allowed = !!perm.length && perm[0].status === 'approved';
        }
      } catch {
        /* bad token -> allowed stays false */
      }
    }
    if (!allowed) {
      return { ok: false, response: jsonError({ error: 'forbidden' }, 403, altSvcHeaders) };
    }
  } else {
    const suppliedToken = request.headers.get('x-edit-token');
    if (!suppliedToken) {
      return {
        ok: false,
        response: jsonError({ error: 'Edit token required' }, 401, altSvcHeaders),
      };
    }
    const tokRows = await sql`
      SELECT 1 FROM charts WHERE id = ${chartId} AND edit_token = ${suppliedToken}
    `;
    if (!tokRows.length) {
      return {
        ok: false,
        response: jsonError({ error: 'Edit token required' }, 401, altSvcHeaders),
      };
    }
  }

  // Every file_id must be registered against this chart. A file_id that
  // exists in chart_files under a DIFFERENT chart_id is just as bad as an
  // unknown file — both signal a cross-tenant reference attempt.
  const owned = (await sql`
    SELECT file_id FROM chart_files
    WHERE chart_id = ${chartId} AND file_id = ANY(${fileIds})
  `) as { file_id: string }[];
  const ownedSet = new Set(owned.map((r) => r.file_id));
  const missing = fileIds.filter((f) => !ownedSet.has(f));
  if (missing.length > 0) {
    return {
      ok: false,
      response: jsonError(
        { error: 'file_not_owned', missing_file_ids: missing },
        403,
        altSvcHeaders,
      ),
    };
  }

  return { ok: true };
}

type ReserveResult = { ok: true; postReservationUsage: bigint } | { ok: false; response: Response };

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
    updateRows = (await sql`
      UPDATE user_api_usage
      SET cost_micro_usd = cost_micro_usd + ${projStr}::bigint,
          last_activity_at = NOW()
      WHERE user_id = ${userId}
        AND cost_micro_usd + ${projStr}::bigint <= ${capStr}::bigint
      RETURNING cost_micro_usd
    `) as { cost_micro_usd: bigint | number | string }[];
  } catch (e) {
    console.error('[reserve] UPDATE user_api_usage failed:', e);
    return {
      ok: false,
      response: jsonError({ error: 'database_unavailable' }, 503, altSvcHeaders),
    };
  }

  if (updateRows.length > 0) {
    return { ok: true, postReservationUsage: toBigInt(updateRows[0].cost_micro_usd) };
  }

  // Either no row exists, or the row would exceed the cap. Disambiguate by
  // attempting to create the row. ON CONFLICT DO NOTHING means: if the row
  // exists, INSERT is a no-op (and we know the existing row is over cap).
  let insertRows: { cost_micro_usd: bigint | number | string }[];
  try {
    insertRows = (await sql`
      INSERT INTO user_api_usage (user_id, cost_micro_usd, first_activity_at, last_activity_at)
      VALUES (${userId}, ${projStr}::bigint, NOW(), NOW())
      ON CONFLICT (user_id) DO NOTHING
      RETURNING cost_micro_usd
    `) as { cost_micro_usd: bigint | number | string }[];
  } catch (e) {
    console.error('[reserve] INSERT user_api_usage failed:', e);
    return {
      ok: false,
      response: jsonError({ error: 'database_unavailable' }, 503, altSvcHeaders),
    };
  }

  if (insertRows.length > 0) {
    return { ok: true, postReservationUsage: toBigInt(insertRows[0].cost_micro_usd) };
  }

  // Cap is actually exceeded — read current cost to produce a useful error body.
  let usedMicro: bigint = 0n;
  try {
    const rows = (await sql`
      SELECT cost_micro_usd FROM user_api_usage WHERE user_id = ${userId}
    `) as { cost_micro_usd: bigint | number | string }[];
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
  intervalMs = 25000,
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
    flush() {
      clearInterval(intervalId);
    },
    cancel() {
      clearInterval(intervalId);
    },
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

/**
 * Discriminated union for blocks we accumulate from the SSE stream. Used by
 * two consumers with different fidelity requirements:
 *
 *   - `buildAssistantBlocksForCountTokens` (kill-switch / reconcile): only
 *     `text`, `thinking`, and `server_tool_use` are submitted to Anthropic's
 *     count_tokens endpoint. The two `*_tool_result` types are captured but
 *     skipped on that path (Anthropic doesn't accept them on the assistant
 *     turn going IN to count_tokens — they're a response artifact).
 *   - `collectAssistantBlocksForAnalytics`: emits all five types verbatim
 *     into `logging_messages.content_blocks` so analytics can fork/replay
 *     the turn via the Messages API, where these blocks are valid history.
 */
type StreamingBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | {
      type: 'server_tool_use';
      id: string;
      name: string;
      input_json_raw: string;
      input: Record<string, unknown> | null;
    }
  | { type: 'web_search_tool_result'; tool_use_id: string; content: unknown }
  | { type: 'code_execution_tool_result'; tool_use_id: string; content: unknown };

type StreamingBlocksMap = Map<number, StreamingBlock>;

/**
 * In-progress assistant-turn content accumulated from SSE `content_block_*`
 * events. Used by the count_tokens polling kill-switch to estimate output
 * cost mid-stream. Only text and thinking blocks are reconstructed (they
 * dominate output cost in practice); tool_use inputs are intentionally
 * omitted to keep the poll body small, at the cost of a small systematic
 * undercount that the 5% overspend tolerance absorbs.
 */
type StreamingAssistantContent = {
  /**
   * Block content by SSE `index`; preserves original ordering on flush.
   * Thinking blocks also carry a `signature` captured from `signature_delta`
   * — Anthropic's count_tokens API rejects any submitted thinking block
   * lacking its signature ("messages.*.content.*.thinking.signature: Field
   * required"), which would 400 our polling request and silently disable
   * the kill poller.
   *
   * server_tool_use blocks stream their `input` field as a sequence of
   * input_json_delta events; `input_json_raw` is the concatenated partial
   * JSON and `input` is the parsed object (set at content_block_stop, or
   * null if parse fails / block is still streaming). Count_tokens needs
   * the parsed object, not the raw string.
   */
  blocks: StreamingBlocksMap;
  /**
   * Live count of `server_tool_use` blocks of name `web_search`. The usage
   * accumulator only picks this up from `message_delta` at end-of-stream,
   * which is too late for the mid-stream kill; we count them on
   * `content_block_start` instead.
   */
  webSearchCount: number;
};

function newStreamingAssistantContent(): StreamingAssistantContent {
  return { blocks: new Map(), webSearchCount: 0 };
}

type SseTeeContext = {
  accumulator: UsageAccumulator;
  /**
   * Mid-stream kill threshold in µUSD. When cumulative actual cost exceeds this,
   * the tee synthesizes a `request_cost_ceiling_exceeded` SSE error and aborts.
   *
   * For free/anon tiers this is the remaining_cap measured BEFORE this
   * request's reservation was deducted (i.e. the effective cap minus the user's
   * prior usage, where the effective cap includes a small overspend tolerance).
   * Since the reservation was already written, `remaining_cap` bounds what the
   * stream can spend before the cap is truly violated.
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
  /**
   * Env for the count_tokens polling kill switch (Anthropic API key). Null on
   * BYOK where no kill applies, so polling is skipped.
   */
  env: Env | null;
  /**
   * Stripped count_tokens body (from `stripToCountTokensBody`) minus the
   * in-progress assistant turn. The poller appends the accumulated assistant
   * message and POSTs to count_tokens. Null for BYOK (no polling).
   */
  countTokensBase: Record<string, unknown> | null;
  /**
   * Input-token count returned by pre-stream count_tokens. The poller
   * subtracts this from each subsequent count_tokens result to derive the
   * output-token delta for output-cost estimation.
   */
  initialInputTokens: number;
  /** In-progress assistant turn accumulated from content_block_* events. */
  streamingContent: StreamingAssistantContent;
  /**
   * Kill frame queued by the out-of-band poller. The poller can't enqueue
   * into the TransformStream controller directly (no controller reference
   * outside transform() callbacks); it sets this + `killed.v` and the next
   * transform() or flush() emits the frame. Null once emitted or unused.
   */
  pendingKillFrame: Uint8Array | null;
  /**
   * Transient frame carrying the latest poller-derived running-cost
   * estimate. Flushed on the next transform() tick the same way as
   * pendingKillFrame. Lets the client's "$X so far" label update every
   * ~5s instead of staying frozen on the message_start snapshot until
   * Anthropic's message_delta arrives at end-of-stream.
   */
  pendingRunningCostFrame: Uint8Array | null;
  /**
   * Sticky flag set when count_tokens returns 429 / network error. Polling
   * stops silently; the message_delta-based end-of-stream kill still acts as
   * a backstop. No user-visible error — graceful degradation only.
   */
  pollingDisabled: boolean;
  /**
   * Set to true once the transform stream has finished (natural end, cancel,
   * explicit kill, or client abort). The poller's fetch can outlive the
   * stream — without this flag an in-flight poll that returns after flush()
   * would set `killed.v` and append a kill-diagnostic even though the stream
   * has already completed successfully. Checked inside pollCostEstimate
   * before firing the kill.
   */
  streamDone: { v: boolean };
  /**
   * Diagnostic payload captured when the kill switch fires, for post-hoc
   * debugging via `logging_errors`. Written during post-stream reconcile
   * rather than from the kill site itself because ctx.waitUntil is scoped
   * to the handler. Null if the stream wasn't killed.
   */
  killDiagnostic: {
    source: 'parse_frame' | 'poll';
    /**
     * Distinguishes a normal threshold-crossing kill from the fail-closed
     * kill synthesized when computeCostMicroUsd throws (cost-table bug).
     * Absent / undefined means the ordinary over-threshold path fired.
     */
    reason?: 'kill_compute_error';
    cumulative_micro_usd: string; // BigInt serialized
    threshold_micro_usd: string; // BigInt serialized
    accumulator_at_kill: UsageAccumulator;
    live_web_search_count: number;
    output_tokens_est?: number; // only set for poll-triggered kills
    count_tokens_total?: number; // only set for poll-triggered kills
    /** Only set when reason === 'kill_compute_error'. */
    compute_error_message?: string;
    fired_at_ms: number; // Date.now()
  } | null;
  /**
   * Diagnostic for the first time polling gets disabled, written to
   * logging_errors from reconcile. Captures WHY the poller silently
   * stopped (network error / rate limit / JSON parse / etc.) so we can
   * tell apart "polling never ran" from "polling ran and passed" when
   * debugging overshoot.
   */
  pollDisableDiagnostic: {
    reason:
      | 'network_error'
      | 'upstream_error'
      | 'rate_limited'
      | 'json_parse_failed'
      | 'cost_compute_failed';
    http_status?: number;
    upstream_body?: string;
    error_message?: string;
    fired_at_ms: number;
  } | null;
  /**
   * Whether Anthropic's `message_delta` event — which carries the authoritative
   * final `output_tokens` — was ever observed. False after kill / abort /
   * network error; the accumulator's output_tokens stays at message_start's
   * placeholder in that case, so reconcile needs a fallback (count_tokens at
   * reconcile time, char-based estimate, or last-poll estimate) to avoid
   * under-billing the output that actually streamed.
   */
  messageDeltaSeen: boolean;
  /**
   * Output-token count from the latest successful poll. Used as a lower-bound
   * fallback at reconcile when `message_delta` never arrives — better than the
   * message_start placeholder but will still miss any output that streamed
   * after polling died (e.g. a giant text block after the last web_search
   * boundary). Reconcile prefers a fresh count_tokens call; this is the
   * cheaper backup.
   */
  lastPollOutputTokens: number;
};

/**
 * Interval between count_tokens polls during streaming. 5s × ~200 tok/s peak
 * output rate caps the overshoot from one poll to the next at ~1000 output
 * tokens ≈ $0.025 on Opus, well under the $0.05 overshoot target.
 */
const POLL_COUNT_TOKENS_INTERVAL_MS = 5_000;

/**
 * Out-of-band cost estimator: POSTs the accumulated assistant turn-so-far to
 * count_tokens and derives an output-token estimate from the delta against the
 * pre-stream baseline. When the combined cost would exceed the kill threshold,
 * sets `teeCtx.pendingKillFrame` + `teeCtx.killed` — the next transform() or
 * flush() emits the synthesized `request_cost_ceiling_exceeded` event.
 *
 * This runs outside the TransformStream controller's lifetime, so it CANNOT
 * enqueue directly. The polling/transform handshake relies on SSE chunks
 * continuing to flow — which they do at far higher rate than the 5s poll — so
 * the emit latency is the inter-chunk gap (~10-50ms).
 *
 * Graceful degradation: any non-2xx or network error sets `pollingDisabled`
 * and silently returns. The original end-of-stream `message_delta` kill still
 * acts as a backstop. No user-visible error on poll failure.
 */
/**
 * Rebuild the streaming assistant turn as a count_tokens-compatible content-
 * block array. Skips half-streamed thinking (no signature yet — Anthropic
 * rejects those). Normalizes the message shape to Anthropic's validation
 * rules, all empirically confirmed (2026-04-24) against /v1/messages/count_tokens:
 *
 *   1. Final block cannot be `thinking`.
 *   2. Final block cannot end with trailing whitespace (space, newline, tab) —
 *      even if it has real content before. A half-streamed text_delta ending
 *      at a word boundary fails this rule often, which used to silently
 *      disable the poller.
 *   3. Text blocks must be non-empty and must contain non-whitespace.
 *   4. Two `thinking` blocks cannot be adjacent in the assistant message
 *      without a text block between them (otherwise Anthropic complains
 *      that the thinking blocks "must remain as they were in the original
 *      response"). Intersperse a minimal text block.
 *
 * We append / intersperse a single period when needed — ~1 extra token per
 * call, trivial for budgeting. Shared between the mid-stream poller and
 * post-stream reconcile so the token-counting rules stay consistent.
 */
export function buildAssistantBlocksForCountTokens(
  teeCtx: SseTeeContext,
): Array<Record<string, unknown>> {
  const indices = Array.from(teeCtx.streamingContent.blocks.keys()).sort((a, b) => a - b);
  const assistantBlocks: Array<Record<string, unknown>> = [];
  for (const i of indices) {
    const block = teeCtx.streamingContent.blocks.get(i);
    if (!block) continue;
    if (block.type === 'text') {
      if (block.text.length === 0) continue;
      // Rule 3: skip empty/whitespace-only text blocks. They'd fail the
      // "text content blocks must be non-empty / must contain non-whitespace"
      // validation.
      if (block.text.trim().length === 0) continue;
      assistantBlocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      if (block.thinking.length === 0) continue;
      if (!block.signature) continue;
      // Rule 4: avoid adjacent thinking blocks by inserting a "." between
      // them. The model never emits two thinking blocks back-to-back in
      // practice, but if an intermediate text/tool block was skipped
      // (e.g. empty text) we'd produce an invalid message shape.
      const last = assistantBlocks[assistantBlocks.length - 1];
      if (last && last.type === 'thinking') {
        assistantBlocks.push({ type: 'text', text: '.' });
      }
      assistantBlocks.push({
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      });
    } else if (block.type === 'server_tool_use') {
      // Skip if input hasn't parsed yet — either the block is still
      // streaming (poll hit mid-block) or the partial JSON was malformed.
      // Including an unparsed block would either serialize `null` input
      // (400) or omit a required field.
      if (block.input === null) continue;
      assistantBlocks.push({
        type: 'server_tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
    // web_search_tool_result and code_execution_tool_result are intentionally
    // skipped on the count_tokens path. Anthropic accepts them on history in
    // the Messages API (where analytics replay sends them) but rejects them
    // on the assistant turn going IN to count_tokens — they're a response-
    // side artifact, not input. The polling kill-switch only needs an output-
    // token estimate, which the text/thinking blocks already cover.
  }
  // Rules 1 + 2: the final block cannot be `thinking` and a trailing text
  // block cannot end with whitespace. `server_tool_use` at the tail is OK
  // (verified via count_tokens probe 2026-04-24), so only `thinking`
  // requires an appended "." terminator.
  while (assistantBlocks.length > 0) {
    const last = assistantBlocks[assistantBlocks.length - 1];
    if (last.type === 'thinking') {
      assistantBlocks.push({ type: 'text', text: '.' });
      break;
    }
    if (last.type === 'text') {
      const text = typeof last.text === 'string' ? last.text : '';
      const trimmed = text.replace(/\s+$/u, '');
      if (trimmed.length === 0) {
        assistantBlocks.pop();
        continue;
      }
      if (trimmed.length !== text.length) {
        assistantBlocks[assistantBlocks.length - 1] = { type: 'text', text: trimmed };
      }
    }
    break;
  }
  return assistantBlocks;
}

/**
 * Convert the worker's in-progress block accumulator into the discriminated
 * `AssistantBlock[]` shape for analytics persistence (`logging_messages.
 * content_blocks`). Unlike `buildAssistantBlocksForCountTokens` this does
 * NOT smooth the assistant turn for Anthropic's count_tokens validation
 * (no trailing-whitespace strip, no period padding, no thinking-after-thinking
 * spacer). Analytics wants raw model output so the team can fork conversations
 * from any point and replay via the Messages API, which accepts the un-smoothed
 * shape on history (count_tokens is the stricter of the two endpoints).
 *
 * Skipped blocks (no analytics value): empty text, unsigned thinking. An
 * unsigned thinking block cannot be replayed (Anthropic 400s on missing
 * signatures during anti-forgery validation), so persisting it would just
 * pollute the analytics store with a dead artifact.
 *
 * server_tool_use with `input === null` (parse mid-stream / malformed JSON)
 * is rendered with an empty input object rather than dropped, so the
 * tool_use_id pairing with the result block survives — the analytics replay
 * path needs both halves of the pair to round-trip cleanly.
 */
export function collectAssistantBlocksForAnalytics(blocks: StreamingBlocksMap): AssistantBlock[] {
  const indices = Array.from(blocks.keys()).sort((a, b) => a - b);
  const out: AssistantBlock[] = [];
  for (const i of indices) {
    const block = blocks.get(i);
    if (!block) continue;
    if (block.type === 'text') {
      if (block.text.length === 0) continue;
      out.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      if (block.thinking.length === 0) continue;
      if (!block.signature) continue;
      out.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
    } else if (block.type === 'server_tool_use') {
      out.push({
        type: 'server_tool_use',
        id: block.id,
        name: block.name,
        input: block.input ?? {},
      });
    } else if (block.type === 'web_search_tool_result') {
      out.push({
        type: 'web_search_tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
      });
    } else {
      out.push({
        type: 'code_execution_tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
      });
    }
  }
  return out;
}

/**
 * One-shot count_tokens call used by reconcile when `message_delta` never
 * arrived (kill, abort, or upstream error mid-stream). Returns the output-
 * token estimate (total - baseline input). Null on any failure path — callers
 * should fall back to char-based estimate or the last-poll stash.
 */
async function countOutputTokensOnce(teeCtx: SseTeeContext): Promise<number | null> {
  if (!teeCtx.env || !teeCtx.countTokensBase) return null;
  const assistantBlocks = buildAssistantBlocksForCountTokens(teeCtx);
  if (assistantBlocks.length === 0) return 0;
  const priorMessages = Array.isArray(teeCtx.countTokensBase.messages)
    ? teeCtx.countTokensBase.messages
    : [];
  const body = {
    ...teeCtx.countTokensBase,
    messages: [...priorMessages, { role: 'assistant', content: assistantBlocks }],
  };
  try {
    const resp = await fetch(ANTHROPIC_COUNT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': teeCtx.env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { input_tokens?: number };
    if (typeof data.input_tokens !== 'number') return null;
    return Math.max(0, data.input_tokens - teeCtx.initialInputTokens);
  } catch {
    return null;
  }
}

async function pollCostEstimate(teeCtx: SseTeeContext): Promise<void> {
  if (teeCtx.killed.v || teeCtx.pollingDisabled) return;
  if (teeCtx.streamDone.v) return;
  // killThresholdMicro=null is the BYOK path (no cap, so no kill switch).
  // We still run polling for those streams because the running_cost frame
  // it emits is the only way the BYOK "$X this chart" pill captures
  // mid-stream output cost when the user kills before message_delta. Kill
  // logic below is gated separately on the threshold.
  if (!teeCtx.env || !teeCtx.countTokensBase) return;

  const assistantBlocks = buildAssistantBlocksForCountTokens(teeCtx);
  if (assistantBlocks.length === 0) return;

  // Skip if cap is already satisfied without considering output — the
  // remaining_cap is what we compare against, and input+cache costs are fixed
  // once message_start arrives. If even zero output would overshoot, the
  // pre-stream reserve would have rejected; we're defensive but shouldn't
  // have work to do here.
  const priorMessages = Array.isArray(teeCtx.countTokensBase.messages)
    ? teeCtx.countTokensBase.messages
    : [];
  const pollBody = {
    ...teeCtx.countTokensBase,
    messages: [...priorMessages, { role: 'assistant', content: assistantBlocks }],
  };

  let resp: Response;
  try {
    resp = await fetch(ANTHROPIC_COUNT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': teeCtx.env.ANTHROPIC_API_KEY,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': ANTHROPIC_BETA,
      },
      body: JSON.stringify(pollBody),
    });
  } catch (e) {
    console.warn('[kill-poll] count_tokens network error, disabling polling:', e);
    if (!teeCtx.pollDisableDiagnostic) {
      teeCtx.pollDisableDiagnostic = {
        reason: 'network_error',
        error_message: e instanceof Error ? e.message : String(e),
        fired_at_ms: Date.now(),
      };
    }
    teeCtx.pollingDisabled = true;
    return;
  }

  // The fetch can outlive the stream. If flush() / cancel() / kill already
  // ran while we were awaiting the count_tokens response, bail before doing
  // anything that could mutate state — firing a kill diagnostic now would
  // spuriously tag a successfully-completed stream as over-budget.
  if (teeCtx.streamDone.v || teeCtx.killed.v) return;

  if (!resp.ok) {
    // Rate-limit or upstream failure: give up on polling for the rest of
    // this stream. The message_delta kill still fires at end-of-stream as a
    // backstop, but that's often too late to avoid overshoot — so log the
    // body so we can tell what killed polling.
    const bodyText = await resp.text().catch(() => '');
    console.warn(
      JSON.stringify({
        event: 'kill_poll_disabled',
        status: resp.status,
        reason: resp.status === 429 ? 'rate_limited' : 'upstream_error',
        upstream_body: bodyText.slice(0, 500),
      }),
    );
    if (!teeCtx.pollDisableDiagnostic) {
      teeCtx.pollDisableDiagnostic = {
        reason: resp.status === 429 ? 'rate_limited' : 'upstream_error',
        http_status: resp.status,
        upstream_body: bodyText.slice(0, 500),
        fired_at_ms: Date.now(),
      };
    }
    teeCtx.pollingDisabled = true;
    return;
  }

  let data: { input_tokens?: number };
  try {
    data = (await resp.json()) as { input_tokens?: number };
  } catch (e) {
    console.warn('[kill-poll] count_tokens JSON parse failed, disabling polling:', e);
    if (!teeCtx.pollDisableDiagnostic) {
      teeCtx.pollDisableDiagnostic = {
        reason: 'json_parse_failed',
        error_message: e instanceof Error ? e.message : String(e),
        fired_at_ms: Date.now(),
      };
    }
    teeCtx.pollingDisabled = true;
    return;
  }

  const totalInputTokens = typeof data.input_tokens === 'number' ? data.input_tokens : 0;
  // count_tokens counts the entire poll body as input. Our baseline was the
  // same body without the appended assistant message, so the delta is the
  // token count of the in-progress assistant content. Clamp to ≥ 0 in case of
  // counter drift.
  const outputTokensSoFar = Math.max(0, totalInputTokens - teeCtx.initialInputTokens);
  // Stash for reconcile fallback: if the stream dies without message_delta,
  // this is the best output-token number we have (modulo content that
  // streamed between the last successful poll and the kill).
  teeCtx.lastPollOutputTokens = Math.max(teeCtx.lastPollOutputTokens, outputTokensSoFar);

  // Synthesize a usage object with the estimated output tokens and the live
  // web-search counter (which message_delta only reports at end-of-stream).
  // Reuse computeCostMicroUsd so cache / multi-component pricing stay in one
  // place.
  const usage: AnthropicUsage = {
    ...accumulatorToUsage(teeCtx.accumulator),
    output_tokens: outputTokensSoFar,
    server_tool_use: { web_search_requests: teeCtx.streamingContent.webSearchCount },
  };

  let estimatedMicro: bigint;
  try {
    estimatedMicro = computeCostMicroUsd(teeCtx.model, usage);
  } catch (e) {
    console.warn('[kill-poll] cost compute failed, disabling polling:', e);
    if (!teeCtx.pollDisableDiagnostic) {
      teeCtx.pollDisableDiagnostic = {
        reason: 'cost_compute_failed',
        error_message: e instanceof Error ? e.message : String(e),
        fired_at_ms: Date.now(),
      };
    }
    teeCtx.pollingDisabled = true;
    return;
  }

  // Publish the fresh estimate to the client so the composer's "$X so far"
  // label isn't frozen on the message_start snapshot during generation.
  // The client's chatService SSE parser keys events by the `type` field in
  // the JSON data payload (it doesn't read the SSE `event:` header), so the
  // type *must* be inside the JSON — otherwise the running_cost branch
  // never matches and the payload is silently discarded. This was the bug
  // behind "'so far' never updated" reports.
  teeCtx.pendingRunningCostFrame = new TextEncoder().encode(
    `event: running_cost\ndata: ${JSON.stringify({
      type: 'running_cost',
      cost_usd: microToUsd(estimatedMicro),
      output_tokens_est: outputTokensSoFar,
      source: 'poll',
      cost_micro_usd: estimatedMicro.toString(),
      input_tokens: teeCtx.accumulator.input_tokens,
      cache_creation_input_tokens: teeCtx.accumulator.cache_creation_input_tokens,
      cache_read_input_tokens: teeCtx.accumulator.cache_read_input_tokens,
      web_search_requests: teeCtx.streamingContent.webSearchCount,
    })}\n\n`,
  );

  // Structured log so `wrangler tail` / Cloudflare logs can answer "why did
  // the 'so far' value stop updating?" without a code redeploy. Runs every
  // 5s per active stream (POLL_COUNT_TOKENS_INTERVAL_MS); volume is bounded
  // by concurrent streams, and the JSON prefix lets a tail filter strip it.
  console.log(
    JSON.stringify({
      event: 'poll_running_cost',
      estimated_micro_usd: estimatedMicro.toString(),
      estimated_usd: microToUsd(estimatedMicro),
      output_tokens_est: outputTokensSoFar,
      total_input_tokens: totalInputTokens,
      web_searches: teeCtx.streamingContent.webSearchCount,
      kill_threshold_micro_usd: teeCtx.killThresholdMicro?.toString() ?? null,
    }),
  );

  // BYOK streams (killThresholdMicro=null) emit running_cost frames but
  // skip the cap-enforcement branch below.
  if (teeCtx.killThresholdMicro !== null && estimatedMicro > teeCtx.killThresholdMicro) {
    // Race: if another path (parseFrame kill, abort, etc.) already fired, skip.
    if (teeCtx.killed.v) return;
    const payload = JSON.stringify({
      type: 'request_cost_ceiling_exceeded',
      limit_usd: microToUsd(teeCtx.killThresholdMicro),
    });
    teeCtx.pendingKillFrame = new TextEncoder().encode(`event: error\ndata: ${payload}\n\n`);
    teeCtx.killed.v = true;
    teeCtx.killDiagnostic = {
      source: 'poll',
      cumulative_micro_usd: estimatedMicro.toString(),
      threshold_micro_usd: teeCtx.killThresholdMicro.toString(),
      accumulator_at_kill: { ...teeCtx.accumulator },
      live_web_search_count: teeCtx.streamingContent.webSearchCount,
      output_tokens_est: outputTokensSoFar,
      count_tokens_total: totalInputTokens,
      fired_at_ms: Date.now(),
    };
    console.log(
      JSON.stringify({
        event: 'poll_kill_triggered',
        estimatedCostMicroUsd: estimatedMicro.toString(),
        thresholdMicroUsd: teeCtx.killThresholdMicro.toString(),
        outputTokensEst: outputTokensSoFar,
        webSearches: teeCtx.streamingContent.webSearchCount,
      }),
    );
    // Don't abort upstream here — we need the next transform() chunk (or
    // flush()) to emit pendingKillFrame. Aborting synchronously can race a
    // pipeThrough error and drop the frame. The next chunk arrives within
    // the inter-frame gap (typically <50ms at Anthropic's streaming rates);
    // the transform callback then aborts upstream itself. If the stream
    // happens to finish naturally before the next chunk, flush() emits the
    // frame instead.
  }
}

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
  let resolveDoneInner!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDoneInner = resolve;
  });
  // Idempotent: first call sets streamDone + resolves the promise; subsequent
  // calls are no-ops. Centralizing the set-and-resolve pair here keeps the
  // poll-race fix correct no matter which exit path runs first.
  const resolveDone = () => {
    teeCtx.streamDone.v = true;
    resolveDoneInner();
  };

  // Polling timer for the async count_tokens kill switch. Armed below when
  // the tier is capped and we have everything the poller needs; cleared on
  // every exit path so we don't leak timers across Worker isolates.
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let pollInFlight = false;
  const clearPollTimer = (reason: string) => {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
      // Surface the stop reason so "so far stopped updating" can be
      // traced: kill_fired, polling_disabled, stream_done, abort, etc.
      // pollDisableDiagnostic (if set) carries the deeper why.
      console.log(
        JSON.stringify({
          event: 'poll_timer_cleared',
          reason,
          poll_disable: teeCtx.pollDisableDiagnostic ?? null,
        }),
      );
    }
  };

  // Defensive resolve-on-abort: if the upstream is aborted (either by our
  // client-disconnect propagation or the kill-switch), a pipeThrough error
  // can bypass flush()/cancel() so done would otherwise hang. Promise
  // resolve is idempotent, so double-resolution from the normal path is a
  // no-op. Also clears the poll timer so nothing fires after done resolves.
  teeCtx.abortController.signal.addEventListener('abort', () => {
    clearPollTimer('abort_signal');
    resolveDone();
  });

  // Arm the polling timer whenever count_tokens is reachable. This covers
  // both purposes: the cap kill-switch (when killThresholdMicro is set) and
  // the running_cost emit that drives the BYOK "$X this chart" pill (which
  // needs ticks even when killThresholdMicro is null, otherwise mid-stream
  // output cost is invisible until message_delta — and message_delta never
  // fires on a user-kill).
  if (teeCtx.env !== null && teeCtx.countTokensBase !== null) {
    pollTimer = setInterval(() => {
      if (teeCtx.killed.v || teeCtx.pollingDisabled) {
        clearPollTimer(teeCtx.killed.v ? 'killed' : 'polling_disabled');
        return;
      }
      if (pollInFlight) return;
      pollInFlight = true;
      pollCostEstimate(teeCtx)
        .catch((e) => {
          console.warn('[kill-poll] unexpected, disabling:', e);
          if (!teeCtx.pollDisableDiagnostic) {
            teeCtx.pollDisableDiagnostic = {
              reason: 'network_error',
              error_message: e instanceof Error ? e.message : String(e),
              fired_at_ms: Date.now(),
            };
          }
          teeCtx.pollingDisabled = true;
        })
        .finally(() => {
          pollInFlight = false;
          if (teeCtx.killed.v || teeCtx.pollingDisabled) {
            clearPollTimer(teeCtx.killed.v ? 'killed' : 'polling_disabled_after_poll');
          }
        });
    }, POLL_COUNT_TOKENS_INTERVAL_MS);
  }

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
    // chart that was garbage-collected. If the lookup errors, surface that
    // honestly as classification_unavailable so the UI can prompt a reload
    // instead of sending the user after a non-existent file.
    let kind: 'chart_deleted' | 'file_unavailable' | 'classification_unavailable' =
      'file_unavailable';
    if (teeCtx.chartId) {
      try {
        const rows = await teeCtx.sql`SELECT 1 FROM charts WHERE id = ${teeCtx.chartId} LIMIT 1`;
        if (rows.length === 0) kind = 'chart_deleted';
      } catch (e) {
        console.error('chart existence lookup failed during not_found interception:', e);
        kind = 'classification_unavailable';
      }
    }

    let payload: Record<string, string>;
    if (kind === 'chart_deleted') {
      payload = { type: 'chart_deleted' };
    } else if (kind === 'classification_unavailable') {
      payload = {
        type: 'classification_unavailable',
        message: 'Something went wrong, please reload.',
      };
    } else {
      payload = {
        type: 'file_unavailable',
        message: 'A file referenced by this chat is no longer available.',
      };
    }
    const frame = encoder.encode(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
    try {
      controller.enqueue(frame);
    } catch (e) {
      console.warn('not-found synthesized enqueue failed (controller closed):', e);
    }
    teeCtx.killed.v = true;
    try {
      controller.terminate();
    } catch {
      /* ignore */
    }
    try {
      teeCtx.abortController.abort();
    } catch {
      /* ignore */
    }
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

    // Content-block tracking for the polling kill-switch: text/thinking
    // accumulated per block index so we can rebuild the assistant turn for
    // count_tokens. Server tool uses are counted here because message_delta's
    // web_search_requests counter only lands at end-of-stream.
    if (eventType === 'content_block_start') {
      const idx = typeof parsed.index === 'number' ? parsed.index : -1;
      const cb = parsed.content_block;
      if (idx >= 0 && cb && typeof cb === 'object' && !Array.isArray(cb)) {
        const cbr = cb as Record<string, unknown>;
        const cbType = cbr.type;
        if (cbType === 'text') {
          teeCtx.streamingContent.blocks.set(idx, { type: 'text', text: '' });
        } else if (cbType === 'thinking') {
          teeCtx.streamingContent.blocks.set(idx, {
            type: 'thinking',
            thinking: '',
            signature: '',
          });
        } else if (cbType === 'server_tool_use') {
          const id = typeof cbr.id === 'string' ? cbr.id : `srvtoolu_unknown_${idx}`;
          const name = typeof cbr.name === 'string' ? cbr.name : '';
          teeCtx.streamingContent.blocks.set(idx, {
            type: 'server_tool_use',
            id,
            name,
            input_json_raw: '',
            input: null,
          });
          if (name === 'web_search') {
            teeCtx.streamingContent.webSearchCount += 1;
            // Web-search cost alone can push cumulative over the kill threshold
            // (51 searches × $0.01 = $0.51 for a single turn). Check here so we
            // don't wait for the 5s poll — which may also be disabled if
            // Anthropic rate-limited our count_tokens. Use the accumulator's
            // snapshot + the live web-search count; the accumulator's own
            // web_search_requests field stays 0 until message_delta.
            if (fireKillIfOverThreshold(controller)) return false;
          }
        } else if (cbType === 'web_search_tool_result') {
          // Anthropic delivers the resolved result in this single block_start
          // event (no deltas follow). Capture verbatim for analytics replay.
          const tuid = typeof cbr.tool_use_id === 'string' ? cbr.tool_use_id : '';
          teeCtx.streamingContent.blocks.set(idx, {
            type: 'web_search_tool_result',
            tool_use_id: tuid,
            content: cbr.content,
          });
        } else if (cbType === 'code_execution_tool_result') {
          const tuid = typeof cbr.tool_use_id === 'string' ? cbr.tool_use_id : '';
          teeCtx.streamingContent.blocks.set(idx, {
            type: 'code_execution_tool_result',
            tool_use_id: tuid,
            content: cbr.content,
          });
        }
      }
      return false;
    }
    if (eventType === 'content_block_delta') {
      const idx = typeof parsed.index === 'number' ? parsed.index : -1;
      const d = parsed.delta;
      if (idx >= 0 && d && typeof d === 'object' && !Array.isArray(d)) {
        const dr = d as Record<string, unknown>;
        const dtype = dr.type;
        const existing = teeCtx.streamingContent.blocks.get(idx);
        if (
          existing &&
          dtype === 'text_delta' &&
          typeof dr.text === 'string' &&
          existing.type === 'text'
        ) {
          existing.text += dr.text;
        } else if (
          existing &&
          dtype === 'thinking_delta' &&
          typeof dr.thinking === 'string' &&
          existing.type === 'thinking'
        ) {
          existing.thinking += dr.thinking;
        } else if (
          existing &&
          dtype === 'signature_delta' &&
          typeof dr.signature === 'string' &&
          existing.type === 'thinking'
        ) {
          // count_tokens requires submitted thinking blocks to include the
          // signature Anthropic produced when generating them (anti-forgery).
          // Without this, the poll request 400s with
          // "messages.*.content.*.thinking.signature: Field required" and
          // polling is disabled for the rest of the stream.
          existing.signature += dr.signature;
        } else if (
          existing &&
          dtype === 'input_json_delta' &&
          typeof dr.partial_json === 'string' &&
          existing.type === 'server_tool_use'
        ) {
          // server_tool_use blocks stream their `input` as a sequence of
          // partial JSON fragments. Concatenate here; JSON.parse fires at
          // block_stop since mid-stream fragments aren't necessarily
          // balanced JSON.
          existing.input_json_raw += dr.partial_json;
        }
      }
      return false;
    }

    if (eventType === 'content_block_stop') {
      const idx = typeof parsed.index === 'number' ? parsed.index : -1;
      const existing = idx >= 0 ? teeCtx.streamingContent.blocks.get(idx) : undefined;
      if (existing && existing.type === 'server_tool_use' && existing.input === null) {
        // Parse the accumulated partial_json into a concrete object that
        // count_tokens will accept. Graceful degradation on malformed JSON:
        // leave `input` null so the assembler skips this block (we'd rather
        // under-count output than disable the entire poller with a 400).
        const raw = existing.input_json_raw;
        try {
          const parsedInput = JSON.parse(raw.length === 0 ? '{}' : raw) as unknown;
          if (parsedInput && typeof parsedInput === 'object' && !Array.isArray(parsedInput)) {
            existing.input = parsedInput as Record<string, unknown>;
          }
        } catch {
          /* malformed; input stays null, assembler skips */
        }
      }
      return false;
    }

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
      teeCtx.messageDeltaSeen = true;
      const u = parsed.usage;
      if (u && typeof u === 'object' && !Array.isArray(u)) {
        usageObj = u as Record<string, unknown>;
      }
    }
    if (!usageObj) return false;

    // Emit a running_cost frame on every usage-bearing event so the client's
    // BYOK spend counter never lags behind reality:
    //   - message_start: cache_creation_input_tokens / cache_read_input_tokens
    //     and the full input_tokens count are only reported here (per
    //     mergeUsage doc). Without this emit, a kill landing before the first
    //     5s polling tick records ZERO cost for the turn — even though
    //     Anthropic already billed the cache writes at prompt-processing time.
    //     This was the bug behind the BYOK "$X this chart" counter
    //     undercounting cache costs by ~75% on chart 7DGgVcEy (10 quick
    //     kills, $1.58 actual vs $0.38 displayed).
    //   - message_delta: the authoritative final usage. Polling can be up to
    //     5s stale at message_stop, so this final frame is what makes the
    //     counter converge with what reconcile writes to user_api_usage.
    if (eventType === 'message_start' || eventType === 'message_delta') {
      const merged = { ...teeCtx.accumulator };
      mergeUsage(merged, usageObj);
      try {
        const finalMicro = computeCostMicroUsd(teeCtx.model, accumulatorToUsage(merged));
        // Embed the full accumulator snapshot in the SSE frame so the
        // client can log it alongside its delta-credit math. This is the
        // only way to surface server-side compute on PR-preview deploys
        // where `wrangler tail` isn't available.
        const frame = encoder.encode(
          `event: running_cost\ndata: ${JSON.stringify({
            type: 'running_cost',
            cost_usd: microToUsd(finalMicro),
            output_tokens_est: merged.output_tokens,
            source: eventType,
            cost_micro_usd: finalMicro.toString(),
            input_tokens: merged.input_tokens,
            cache_creation_input_tokens: merged.cache_creation_input_tokens,
            cache_read_input_tokens: merged.cache_read_input_tokens,
            web_search_requests: merged.web_search_requests,
          })}\n\n`,
        );
        try {
          controller.enqueue(frame);
        } catch {
          // Controller closed (downstream cancelled). Reconcile still
          // writes the authoritative figure to the DB; the client just
          // misses the tick.
        }
      } catch (e) {
        console.error(`running_cost emit failed at ${eventType}:`, e);
      }
    }

    // Diagnostic: log the raw usage shape on message_start so we can confirm
    // whether cache_creation/cache_read land immediately (as the kill switch
    // assumes) or only at message_delta at end-of-stream. One log per stream.
    if (eventType === 'message_start') {
      console.log(
        JSON.stringify({
          event: 'message_start_usage',
          model: teeCtx.model,
          usage: usageObj,
        }),
      );
    }

    mergeUsage(teeCtx.accumulator, usageObj);
    fireKillIfOverThreshold(controller);
    return false;
  }

  /**
   * Compute cumulative cost from the latest accumulator + live web-search
   * count, and fire the synthesized `request_cost_ceiling_exceeded` kill
   * frame if we've crossed the threshold. Returns true if kill fired.
   *
   * Returns false when the tier is BYOK (no threshold), when the cost can't
   * be computed, or when we're still under budget. Safe to call from any
   * parseFrame branch.
   */
  function fireKillIfOverThreshold(
    controller: TransformStreamDefaultController<Uint8Array>,
  ): boolean {
    if (teeCtx.killThresholdMicro === null) return false;
    if (teeCtx.killed.v) return false;

    let cumulativeMicro: bigint;
    try {
      cumulativeMicro = computeCostMicroUsd(teeCtx.model, accumulatorToUsage(teeCtx.accumulator));
    } catch (e) {
      // A cost-table bug must not silently disable the kill switch — that
      // leaves spend unbounded. Fail closed: synthesize a kill with a
      // distinct diagnostic reason so the reconcile path records WHY the
      // stream was torn down without a cumulative figure.
      console.error('cost compute failed; firing kill fail-closed:', e);
      teeCtx.killed.v = true;
      teeCtx.killDiagnostic = {
        source: 'parse_frame',
        reason: 'kill_compute_error',
        cumulative_micro_usd: '0',
        threshold_micro_usd: teeCtx.killThresholdMicro.toString(),
        accumulator_at_kill: { ...teeCtx.accumulator },
        live_web_search_count: teeCtx.streamingContent.webSearchCount,
        compute_error_message: e instanceof Error ? e.message : String(e),
        fired_at_ms: Date.now(),
      };
      const payload = JSON.stringify({
        type: 'request_cost_ceiling_exceeded',
        limit_usd: microToUsd(teeCtx.killThresholdMicro),
      });
      const killFrame = encoder.encode(`event: error\ndata: ${payload}\n\n`);
      try {
        controller.enqueue(killFrame);
      } catch (enqueueErr) {
        console.warn('kill-compute-error enqueue failed (controller closed):', enqueueErr);
      }
      try {
        controller.terminate();
      } catch {
        /* ignore */
      }
      try {
        teeCtx.abortController.abort();
      } catch {
        /* ignore */
      }
      resolveDone();
      return true;
    }
    // Accumulator's web_search_requests is 0 until message_delta at end-of-
    // stream. Top it up with the live per-block count so web-search cost is
    // reflected in cumulative *during* the stream.
    const liveWebExtra = Math.max(
      0,
      teeCtx.streamingContent.webSearchCount - teeCtx.accumulator.web_search_requests,
    );
    if (liveWebExtra > 0) {
      cumulativeMicro += BigInt(liveWebExtra) * BigInt(WEB_SEARCH_MICRO_USD_PER_USE);
    }

    if (cumulativeMicro <= teeCtx.killThresholdMicro) return false;

    teeCtx.killed.v = true;
    teeCtx.killDiagnostic = {
      source: 'parse_frame',
      cumulative_micro_usd: cumulativeMicro.toString(),
      threshold_micro_usd: teeCtx.killThresholdMicro.toString(),
      accumulator_at_kill: { ...teeCtx.accumulator },
      live_web_search_count: teeCtx.streamingContent.webSearchCount,
      fired_at_ms: Date.now(),
    };
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
    } catch {
      /* ignore */
    }
    try {
      teeCtx.abortController.abort();
    } catch {
      /* ignore */
    }
    // terminate() doesn't run flush(); resolve done directly so reconcile
    // doesn't hang waiting for a flush that never comes.
    resolveDone();
    return true;
  }

  /**
   * Forward a completed SSE frame verbatim plus its trailing `\n\n` separator.
   * Called from the TransformStream only after `maybeInterceptNotFound` has
   * had a chance to swallow the frame — so the client never sees Anthropic's
   * raw `not_found_error` followed by our synthesized variant.
   */
  function forwardFrame(
    frame: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    if (frame.length === 0) return;
    try {
      controller.enqueue(encoder.encode(frame + '\n\n'));
    } catch (e) {
      console.warn('frame forward failed (controller closed):', e);
    }
  }

  /**
   * Flush any poller-staged frames (running-cost snapshot + kill). Called at
   * the top of every transform() tick and from flush() so frames emitted by
   * the 5s poll land on the next chunk boundary (typically <50ms). The
   * running-cost frame goes first so the kill (if present) is the final
   * event the client sees before termination.
   */
  function flushPendingPollerFrames(
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void {
    if (teeCtx.pendingRunningCostFrame !== null) {
      try {
        controller.enqueue(teeCtx.pendingRunningCostFrame);
      } catch (e) {
        console.warn('pending running-cost frame enqueue failed (controller closed):', e);
      }
      teeCtx.pendingRunningCostFrame = null;
    }
    if (teeCtx.pendingKillFrame !== null) {
      try {
        controller.enqueue(teeCtx.pendingKillFrame);
      } catch (e) {
        console.warn('pending kill frame enqueue failed (controller closed):', e);
      }
      teeCtx.pendingKillFrame = null;
    }
  }

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (teeCtx.killed.v) {
        flushPendingPollerFrames(controller);
        try {
          controller.terminate();
        } catch {
          /* ignore */
        }
        // Abort upstream so we stop charging ourselves for tokens the client
        // will never see. The poller sets killed.v but intentionally doesn't
        // abort — this transform() callback is the safe spot to do so since
        // we've just enqueued the kill frame.
        try {
          teeCtx.abortController.abort();
        } catch {
          /* ignore */
        }
        clearPollTimer('killed_in_transform');
        resolveDone();
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
          flushPendingPollerFrames(controller);
          clearPollTimer('killed_after_parse');
          // resolveDone was called by parseFrame (or will be on abort).
          return;
        }
        if (!intercepted) {
          forwardFrame(frame, controller);
        }
      }
      // Flush any pending running_cost frame from a poll that completed
      // between chunks. Without this the frame sat in teeCtx until kill or
      // end-of-stream, so the client's "$X so far" stayed frozen on the
      // message_start estimate through the whole turn — exactly the bug
      // reported when a web-search-heavy turn showed "stuck at $0.14".
      if (teeCtx.pendingRunningCostFrame !== null) {
        flushPendingPollerFrames(controller);
      }
    },
    flush(controller) {
      // Either end-of-stream or the poller-triggered kill reached flush
      // without a further chunk. Emit the synthesized kill frame (if pending)
      // before the trailing buffer so the client sees it as the last event.
      flushPendingPollerFrames(controller);
      if (sseBuffer.length > 0) {
        try {
          controller.enqueue(encoder.encode(sseBuffer));
        } catch {
          /* ignore */
        }
      }
      clearPollTimer('stream_ended');
      resolveDone();
    },
    cancel() {
      // Downstream cancelled (client disconnect) — resolve so reconcile can
      // proceed with the partial accumulator we have.
      clearPollTimer('downstream_cancel');
      resolveDone();
    },
  });

  // Belt-and-braces hang safeguard: if the upstream source rejects (network
  // error, Anthropic kill-shot, edge 5xx) before flush/cancel have fired on
  // the transform, neither handler runs and `done` sleeps until the Worker
  // times out (~30s) — during which `ctx.waitUntil(tracked.done)` starves
  // the reconcile UPSERT. Chain a tail transform that mirrors chunks but
  // whose own flush/cancel hooks resolveDone so every exit path — clean
  // end-of-stream, downstream cancel, or readable-side error propagated
  // through the pipe — fires it exactly once (resolveDone is idempotent).
  const tail = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      resolveDone();
    },
    cancel(reason) {
      if (reason) {
        console.warn('[cost-tracking] tail cancelled:', reason);
      }
      resolveDone();
    },
  });
  const piped = source.pipeThrough(transform).pipeThrough(tail);
  return { stream: piped, done };
}

// --- Anthropic billing-error detection -----------------------------------

function looksLikeBillingError(status: number, errorBody: unknown): boolean {
  if (!errorBody || typeof errorBody !== 'object') return false;
  const e = (errorBody as { error?: unknown }).error;
  if (!e || typeof e !== 'object') return false;
  const err = e as { type?: unknown; message?: unknown };
  if (status === 402 && err.type === 'billing_error') return true;
  if (status === 429 && typeof err.message === 'string' && /spend|cap|limit/i.test(err.message)) {
    return true;
  }
  return false;
}

/**
 * Classify an Anthropic `not_found_error` (seen as SSE error event or HTTP
 * 404) into `chart_deleted` vs `file_unavailable`. Without a chart_id we can
 * only assume the specific file is gone; with one we can prove the chart
 * itself was deleted.
 *
 * A third kind, `classification_unavailable`, surfaces when the `charts`
 * lookup itself errors: we genuinely don't know which of the two cases
 * applies, and claiming `file_unavailable` at that point is misleading
 * since it steers the user toward a file-level remedy they probably can't
 * act on. The client renders this as a generic "reload" prompt.
 */
async function classifyNotFound(
  sql: NeonQueryFunction<false, false>,
  chartId: string | null,
): Promise<'chart_deleted' | 'file_unavailable' | 'classification_unavailable'> {
  if (!chartId) return 'file_unavailable';
  try {
    const rows = await sql`SELECT 1 FROM charts WHERE id = ${chartId} LIMIT 1`;
    return rows.length === 0 ? 'chart_deleted' : 'file_unavailable';
  } catch (e) {
    console.error('classifyNotFound: charts lookup failed', e);
    return 'classification_unavailable';
  }
}

// --- Main handler -------------------------------------------------------

export async function handler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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

  const sql = getDb(env);

  // Step 2: actor.
  const actor = await resolveActor(request, env, altSvcHeaders, sql);
  if (!actor.ok) return actor.response;
  const actorId = actor.actorId;
  // Auth'd path mints tocb_auth_link; anon path may mint tocb_actor_id.
  // The two are mutually exclusive on any given request (one of
  // authenticated=true or =false), so a single Set-Cookie slot on
  // altSvcHeaders covers both and propagates to every jsonError / stream
  // response built below.
  const setCookie = actor.anonSetCookie ?? actor.authLinkSetCookie;
  if (setCookie) {
    altSvcHeaders['Set-Cookie'] = setCookie;
  }

  // Step 3: BYOK resolution.
  //
  // Priority order for the x-api-key forwarded upstream:
  //   1. `X-User-Anthropic-Key` header — legacy path for an explicit per-request
  //      override (a user testing a different key without re-saving it).
  //   2. Server-stored `user_byok_keys` row for authenticated users — the
  //      Round-2 design: key is stored once, encrypted, and loaded here.
  //   3. Our `ANTHROPIC_API_KEY` fallback for the free/anon tier.
  //
  // Anonymous actors cannot BYOK — they have no user_id to key the row on,
  // and `allowByok('anon')` is false. Trusting the header from an anon caller
  // would silently bypass both the Turnstile gate and the lifetime cap, so
  // we drop it on the floor (with a warn for observability) and proceed as
  // if the header were never sent.
  const byokHeaderKeyRaw = request.headers.get('x-user-anthropic-key');
  const byokHeaderKey = actor.authenticated && byokHeaderKeyRaw ? byokHeaderKeyRaw : null;
  if (byokHeaderKeyRaw && !actor.authenticated) {
    console.warn('ignoring X-User-Anthropic-Key from anon caller');
  }
  let byokKey: string | null = byokHeaderKey;
  let hasByok = !!byokKey && actor.authenticated;

  if (!hasByok && actor.authenticated) {
    let encryptedKey: Uint8Array | ArrayBuffer | null;
    try {
      const rows = (await sql`
        SELECT encrypted_key FROM user_byok_keys WHERE user_id = ${actorId} LIMIT 1
      `) as { encrypted_key: Uint8Array | ArrayBuffer | null }[];
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
        const stored =
          encryptedKey instanceof Uint8Array ? encryptedKey : new Uint8Array(encryptedKey);
        byokKey = await decryptByokKey(stored, actorId, env.BYOK_ENCRYPTION_KEY);
        hasByok = true;
      } catch (e) {
        console.error('[anthropic-stream] BYOK decrypt failed', e);
        return jsonError({ error: 'byok_not_configured' }, 503, altSvcHeaders);
      }
    }
  }

  // Defense-in-depth: the BYOK resolution block above already requires
  // actor.authenticated before setting hasByok, but if that invariant ever
  // drifts we want a second barrier. Evaluate allowByok against the BASE
  // tier (ignoring the hasByok override) — allowByok('anon') === false, so
  // any accidental promotion of an anon caller to 'byok' trips here before
  // we touch upstream.
  //
  // Fail loud rather than downgrading silently. If we fall through to the
  // free tier, the user's BYOK pill keeps crediting the request as if it
  // hit their key, but the upstream call would actually use our shared
  // ANTHROPIC_API_KEY — they get phantom-billed twice (once locally on the
  // pill, once for real on our account). Surface a 500 so the bug is
  // visible and the user retries instead of accruing silent drift.
  const baseTier = tierFor(actorId, false);
  if (hasByok && !allowByok(baseTier)) {
    console.error('[anthropic-stream] invariant violated: hasByok=true on non-byok-eligible tier', {
      baseTier,
      actorId,
    });
    try {
      await sql`
        INSERT INTO logging_errors (error_id, error_name, error_message, user_id, request_metadata)
        VALUES (
          ${crypto.randomUUID()},
          'ByokTierInvariantViolation',
          ${`hasByok=true on baseTier=${baseTier}; refused to downgrade silently`},
          ${actorId},
          ${JSON.stringify({ baseTier, deployment_host: requestUrl.hostname, fired_at_ms: Date.now() })}
        )
      `;
    } catch (e) {
      console.error('[anthropic-stream] ByokTierInvariantViolation diagnostic insert failed:', e);
    }
    return jsonError(
      { error: 'byok_tier_mismatch', detail: 'BYOK rejected on non-eligible base tier' },
      500,
      altSvcHeaders,
    );
  }
  const tier = tierFor(actorId, hasByok);

  // Step 4: turnstile session cookie for anon.
  // missing / expired / actor_mismatch / invalid all map to the same client UX:
  // solve a fresh challenge and retry.
  if (needTurnstile(tier)) {
    const result = await verifyTurnstileFromCookie(request, env, actorId);
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

  // Step 5.5: file_id ownership. For our metered path (shared
  // env.ANTHROPIC_API_KEY), Anthropic's workspace-level file access check
  // passes for ANY file uploaded by ANY of our users — so a leaked file_id
  // would let one tenant dereference another's upload. Validate chart access
  // + scope every file_id to chartId before we hit upstream. BYOK callers
  // use their own Anthropic workspace key, so their key already enforces
  // ownership and we skip the check.
  if (!hasByok) {
    const fileCheck = await validateFileOwnership(request, env, sql, body, chartId, altSvcHeaders);
    if (!fileCheck.ok) return fileCheck.response;
  }

  // Step 6 + 7: estimate + reserve (skipped for BYOK).
  let projected: bigint = 0n;
  let model = typeof body.model === 'string' ? body.model : DEFAULT_MODEL;
  let postReservationUsage: bigint = 0n;
  let initialInputTokens = 0;
  let countTokensBase: Record<string, unknown> | null = null;
  if (isCapped(tier)) {
    const est = await estimateProjectedCost(body, env, altSvcHeaders, sql, chartId);
    if (!est.ok) return est.response;
    projected = est.projected;
    model = est.model;
    initialInputTokens = est.inputTokens;
    countTokensBase = est.countBody;

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
    // Probe count_tokens upfront for BYOK so polling and reconcile-fallback
    // can compute output tokens correctly.
    //
    // The polling path computes output as `totalInputTokens -
    // initialInputTokens`. The reconcile-without-message_delta fallback at
    // `countOutputTokensOnce` uses the same subtraction. If
    // initialInputTokens defaults to 0, both paths treat the entire request
    // (system prompt + messages, often 20-30k tokens) as "output" and the
    // computed cost balloons by ~5-10x — the opposite of the
    // missing-cache-cost bug, but just as wrong.
    //
    // Use the BYOK key so the probe bills the user's own Anthropic account
    // (we don't want to pay for BYOK-user count_tokens probes from our
    // shared ANTHROPIC_API_KEY). Probe failure leaves countTokensBase=null,
    // which disables polling for this stream — better than running with a
    // bad baseline and flooding the BYOK pill with inflated estimates.
    const candidateBody = stripToCountTokensBody(body);
    if (byokKey) {
      try {
        const probeResp = await fetch(ANTHROPIC_COUNT_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': byokKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-beta': ANTHROPIC_BETA,
          },
          body: JSON.stringify(candidateBody),
        });
        if (probeResp.ok) {
          const probeData = (await probeResp.json()) as { input_tokens?: number };
          if (typeof probeData.input_tokens === 'number' && probeData.input_tokens >= 0) {
            initialInputTokens = probeData.input_tokens;
            countTokensBase = candidateBody;
          } else {
            console.warn('[byok-probe] count_tokens response missing input_tokens', probeData);
          }
        } else {
          const text = await probeResp.text().catch(() => '');
          console.warn('[byok-probe] count_tokens upstream', probeResp.status, text.slice(0, 200));
        }
      } catch (e) {
        console.warn('[byok-probe] count_tokens fetch failed:', e);
      }
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
    console.log(
      JSON.stringify({
        event: 'client_disconnect',
        timestamp: new Date().toISOString(),
        userId: actorId,
        tier,
      }),
    );
    try {
      abortController.abort();
    } catch {
      /* ignore */
    }
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
    if (isCapped(tier)) {
      revertReservation(ctx, sql, actorId, projected, {
        model,
        chartId,
        deploymentHost: requestUrl.hostname,
      });
    }
    return jsonError(
      { error: 'upstream_unavailable', details: e instanceof Error ? e.message : 'Unknown error' },
      502,
      altSvcHeaders,
    );
  }

  if (!upstream.ok) {
    const errorText = await upstream.text();
    console.error(`Anthropic API error (${upstream.status}):`, errorText);
    if (isCapped(tier)) {
      revertReservation(ctx, sql, actorId, projected, {
        model,
        chartId,
        deploymentHost: requestUrl.hostname,
      });
    }

    // Detect global budget exhaustion (Anthropic Console cap).
    let parsedError: unknown;
    try {
      parsedError = JSON.parse(errorText);
    } catch {
      /* non-JSON body */
    }
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
      let payload: Record<string, string>;
      if (kind === 'chart_deleted') {
        payload = { error: 'chart_deleted' };
      } else if (kind === 'classification_unavailable') {
        payload = {
          error: 'classification_unavailable',
          message: 'Something went wrong, please reload.',
        };
      } else {
        payload = {
          error: 'file_unavailable',
          message: 'A file referenced by this chat is no longer available.',
        };
      }
      return jsonError(payload, 404, altSvcHeaders);
    }

    // Sanitize: Anthropic's error bodies can carry BYOK account context (org
    // ids, rate-limit details) or edge-layer stack traces that shouldn't be
    // forwarded verbatim to the browser. Wrap the message in our own envelope
    // and cap it at 500 chars so a verbose upstream can't pad the response.
    return jsonError(
      {
        error: 'upstream_error',
        upstream_message: errorText.slice(0, 500),
        upstream_status: upstream.status,
      },
      upstream.status,
      altSvcHeaders,
    );
  }

  if (!upstream.body) {
    if (isCapped(tier)) {
      revertReservation(ctx, sql, actorId, projected, {
        model,
        chartId,
        deploymentHost: requestUrl.hostname,
      });
    }
    return jsonError({ error: 'AI service returned empty response' }, 502, altSvcHeaders);
  }

  // Step 9: cost-tracking tee + kill-switch.
  const accumulator = newAccumulator();
  const killed = { v: false };

  // Kill threshold: cumulative actual cost must not exceed remaining_cap measured
  // BEFORE this request's reservation was deducted. Since the reservation has
  // already been debited, that's EFFECTIVE_CAP - (post_reservation - projected).
  // The effective cap includes a small overspend tolerance (see tiers.ts) so
  // the kill doesn't cut large legitimate responses off mid-sentence for a few
  // pennies of overshoot; preflight (composer + reserveCost) stays strict.
  // For BYOK the cap doesn't apply — null disables the check in the tee.
  const killThresholdMicro: bigint | null = isCapped(tier)
    ? EFFECTIVE_LIFETIME_CAP_MICRO_USD - (postReservationUsage - projected)
    : null;

  const teeCtx: SseTeeContext = {
    accumulator,
    killThresholdMicro,
    model,
    abortController,
    killed,
    chartId,
    sql,
    // count_tokens polling. Originally a kill-switch gated on capped tier,
    // but BYOK now uses the same poll cycle to emit running_cost frames
    // that drive the BYOK "$X this chart" pill. Both env and countTokensBase
    // must be non-null for the timer to arm; for BYOK, countTokensBase
    // comes from the upfront probe (see the BYOK branch in the request
    // handler) and stays null on probe failure, which keeps polling
    // disarmed for that stream rather than letting it run with a bad
    // baseline.
    env,
    countTokensBase,
    initialInputTokens,
    streamingContent: newStreamingAssistantContent(),
    pendingKillFrame: null,
    pendingRunningCostFrame: null,
    pollingDisabled: false,
    streamDone: { v: false },
    killDiagnostic: null,
    pollDisableDiagnostic: null,
    messageDeltaSeen: false,
    lastPollOutputTokens: 0,
  };

  const tracked = createCostTrackingStream(upstream.body, teeCtx);
  const keepaliveStream = createKeepaliveStream(tracked.stream, request.signal);

  // Step 10: post-stream reconcile. ctx.waitUntil extends the Worker lifetime
  // past the Response being fully flushed so we still get the DB write. Skip
  // user_api_usage / global_monthly_usage updates for BYOK (no reservation to
  // reconcile), but always try to write logging_messages.cost_micro_usd when
  // a message_id was supplied — it's the per-chart attribution key and is
  // independent of tier.
  ctx.waitUntil(
    (async () => {
      // Trace marker: insert a row at reconcile entry so we can tell whether
      // the waitUntil ran at all vs. hit an exception before the existing
      // diagnostics. Only fires when a logging-message-id was provided so we
      // don't pollute logging_errors with anonymous noise. Fire-and-forget;
      // if THIS insert fails the rest of the waitUntil still runs.
      if (loggingMessageId) {
        try {
          await sql`
            INSERT INTO logging_errors (
              error_id, error_name, error_message, user_id, chart_id,
              request_metadata
            )
            VALUES (
              ${crypto.randomUUID()},
              'DiagnosticReconcileEntered',
              'reconcile waitUntil entered (pre tracked.done await)',
              ${actorId},
              ${chartId ?? null},
              ${JSON.stringify({
                user_id: actorId,
                logging_message_id: loggingMessageId,
                tier,
                model,
                deployment_host: requestUrl.hostname,
                fired_at_ms: Date.now(),
              })}
            )
            ON CONFLICT (error_id) DO NOTHING
          `;
        } catch (e) {
          console.error('reconcile-entered diagnostic insert failed:', e);
        }
      }

      // Wait for the SSE stream to finish (natural end, kill-switch, or
      // client-cancel). Once `tracked.done` resolves, the accumulator is
      // stable — no further transform() callbacks will mutate it.
      //
      // Cap the wait so a stuck upstream (typical when the client disconnects
      // mid-stream and the abort doesn't propagate cleanly into the tee) can't
      // eat the entire ctx.waitUntil time budget. Without this, every Entered
      // gets stuck here and never reaches CostComputed, which is the dominant
      // failure mode observed in V33MO0XP and the 2026-05-01 byok-10 trace
      // (7 of 11 reconciles bailed at this await).
      const TRACKED_DONE_TIMEOUT_MS = 12_000;
      let trackedDoneTimedOut = false;
      await Promise.race([
        tracked.done,
        new Promise<void>((resolve) => {
          setTimeout(() => {
            trackedDoneTimedOut = true;
            resolve();
          }, TRACKED_DONE_TIMEOUT_MS);
        }),
      ]);
      if (trackedDoneTimedOut && loggingMessageId) {
        try {
          await sql`
            INSERT INTO logging_errors (
              error_id, error_name, error_message, user_id, chart_id,
              request_metadata
            )
            VALUES (
              ${crypto.randomUUID()},
              'DiagnosticReconcileTrackedDoneTimeout',
              ${`tracked.done did not resolve within ${TRACKED_DONE_TIMEOUT_MS}ms; proceeding with partial state`},
              ${actorId},
              ${chartId ?? null},
              ${JSON.stringify({
                logging_message_id: loggingMessageId,
                tier,
                model,
                killed: teeCtx.killed.v,
                message_delta_seen: teeCtx.messageDeltaSeen,
                accumulator,
                live_web_search_count: teeCtx.streamingContent.webSearchCount,
                last_poll_output_tokens: teeCtx.lastPollOutputTokens,
                timeout_ms: TRACKED_DONE_TIMEOUT_MS,
                deployment_host: requestUrl.hostname,
                fired_at_ms: Date.now(),
              })}
            )
            ON CONFLICT (error_id) DO NOTHING
          `;
        } catch (e) {
          console.error('tracked-done-timeout diagnostic insert failed:', e);
        }
      }

      // When the stream is killed mid-flight, Anthropic's message_delta never
      // arrives — which means the accumulator's `web_search_requests` stays 0
      // even though server_tool_use blocks actually fired on the upstream.
      // We've been counting those live in streamingContent.webSearchCount
      // (incremented on each content_block_start of type server_tool_use
      // name=web_search). If that live count is higher than the accumulator's
      // snapshot, trust the live count — Anthropic will bill us for those
      // searches whether message_delta confirms them or not.
      const reconciledWebSearch = Math.max(
        accumulator.web_search_requests,
        teeCtx.streamingContent.webSearchCount,
      );

      // Same story for output_tokens: without message_delta, accumulator.output
      // is the message_start placeholder (≈8). Every output token that streamed
      // after that is invisible to the cost calc, so we under-bill whatever
      // generated before the kill — a 47k-token text block can go unrecorded.
      // Fallback order:
      //   1. One-shot count_tokens at reconcile time — same mechanism the
      //      poller uses, authoritative w.r.t. Anthropic's tokenization.
      //   2. lastPollOutputTokens — last successful poll's result, stale but
      //      not a guess.
      //   3. accumulator.output_tokens — the placeholder. If we end up here
      //      we log a diagnostic since we know we're under-counting.
      let reconciledOutput = accumulator.output_tokens;
      let reconcileOutputSource: 'message_delta' | 'count_tokens' | 'last_poll' | 'placeholder' =
        'message_delta';
      if (!teeCtx.messageDeltaSeen) {
        const fresh = await countOutputTokensOnce(teeCtx);
        if (fresh !== null) {
          reconciledOutput = Math.max(reconciledOutput, fresh);
          reconcileOutputSource = 'count_tokens';
        } else if (teeCtx.lastPollOutputTokens > 0) {
          reconciledOutput = Math.max(reconciledOutput, teeCtx.lastPollOutputTokens);
          reconcileOutputSource = 'last_poll';
        } else {
          reconcileOutputSource = 'placeholder';
        }
      }

      const reconciledAccumulator: UsageAccumulator = {
        ...accumulator,
        output_tokens: reconciledOutput,
        web_search_requests: reconciledWebSearch,
      };

      let actualMicro: bigint = 0n;
      try {
        actualMicro = computeCostMicroUsd(model, accumulatorToUsage(reconciledAccumulator));
      } catch (e) {
        console.error('Post-stream cost computation failed:', e);
        if (loggingMessageId) {
          try {
            await sql`
              INSERT INTO logging_errors (
                error_id, error_name, error_message, user_id, chart_id,
                request_metadata
              )
              VALUES (
                ${crypto.randomUUID()},
                'DiagnosticReconcileCostComputeFailed',
                ${`computeCostMicroUsd threw: ${e instanceof Error ? e.message : String(e)}`},
                ${actorId},
                ${chartId ?? null},
                ${JSON.stringify({
                  logging_message_id: loggingMessageId,
                  tier,
                  model,
                  error_message: e instanceof Error ? e.message : String(e),
                  error_stack: e instanceof Error ? e.stack : null,
                  reconciled_accumulator: reconciledAccumulator,
                  output_source: reconcileOutputSource,
                  message_delta_seen: teeCtx.messageDeltaSeen,
                  killed: teeCtx.killed.v,
                  deployment_host: requestUrl.hostname,
                  fired_at_ms: Date.now(),
                })}
              )
              ON CONFLICT (error_id) DO NOTHING
            `;
          } catch (innerErr) {
            console.error('cost-compute-failed diagnostic insert failed:', innerErr);
          }
        }
        // Don't return — fall through with actualMicro=0n so downstream
        // logging_messages UPDATEs (was_killed, content_blocks) still run.
        // The cost-attribution bits silently set cost=0 for this turn, but
        // the diagnostic above tells us what threw.
      }

      // Persist a per-reconcile diagnostic to logging_errors so the
      // server-side final cost is queryable from the DB on PR-preview
      // deploys (no wrangler tail available there). Pair this with the
      // client-side `[ChatService] running_cost` lines (which now embed
      // the same accumulator breakdown via the SSE payload) to see
      // whether the server's final figure matches the last frame the
      // client received. The DB row is the queryable diagnostic; the
      // console.log below is for production debugging via wrangler tail.
      console.log(
        JSON.stringify({
          event: 'reconcile_cost_computed',
          loggingMessageId: loggingMessageId ?? null,
          chartId: chartId ?? null,
          tier,
          model,
          message_delta_seen: teeCtx.messageDeltaSeen,
          actual_micro_usd: actualMicro.toString(),
          actual_usd: microToUsd(actualMicro),
          projected_micro_usd: projected.toString(),
          input_tokens: reconciledAccumulator.input_tokens,
          output_tokens: reconciledAccumulator.output_tokens,
          cache_creation_input_tokens: reconciledAccumulator.cache_creation_input_tokens,
          cache_read_input_tokens: reconciledAccumulator.cache_read_input_tokens,
          web_search_requests: reconciledAccumulator.web_search_requests,
          output_source: reconcileOutputSource,
        }),
      );
      try {
        await sql`
          INSERT INTO logging_errors (
            error_id, error_name, error_message, user_id, chart_id,
            request_metadata
          )
          VALUES (
            ${crypto.randomUUID()},
            'DiagnosticReconcileCostComputed',
            ${`actual=${actualMicro.toString()} µUSD output=${reconciledAccumulator.output_tokens} source=${reconcileOutputSource}`},
            ${actorId},
            ${chartId ?? null},
            ${JSON.stringify({
              logging_message_id: loggingMessageId,
              tier,
              model,
              message_delta_seen: teeCtx.messageDeltaSeen,
              actual_micro_usd: actualMicro.toString(),
              actual_usd: microToUsd(actualMicro),
              projected_micro_usd: projected.toString(),
              input_tokens: reconciledAccumulator.input_tokens,
              output_tokens: reconciledAccumulator.output_tokens,
              cache_creation_input_tokens: reconciledAccumulator.cache_creation_input_tokens,
              cache_read_input_tokens: reconciledAccumulator.cache_read_input_tokens,
              web_search_requests: reconciledAccumulator.web_search_requests,
              output_source: reconcileOutputSource,
              deployment_host: requestUrl.hostname,
              fired_at_ms: Date.now(),
            })}
          )
          ON CONFLICT (error_id) DO NOTHING
        `;
      } catch (e) {
        console.error('DiagnosticReconcileCostComputed insert failed:', e);
      }

      if (isCapped(tier)) {
        const deltaMicro = actualMicro - projected;
        try {
          await sql`
          UPDATE user_api_usage
          SET cost_micro_usd        = cost_micro_usd + ${deltaMicro.toString()}::bigint,
              input_tokens          = input_tokens + ${reconciledAccumulator.input_tokens},
              output_tokens         = output_tokens + ${reconciledAccumulator.output_tokens},
              cache_create_tokens   = cache_create_tokens + ${reconciledAccumulator.cache_creation_input_tokens},
              cache_read_tokens     = cache_read_tokens + ${reconciledAccumulator.cache_read_input_tokens},
              web_search_uses       = web_search_uses + ${reconciledAccumulator.web_search_requests},
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
          // Reconcile drift silently accumulates when we only console.error.
          // Persist enough metadata for a manual replay: the projected figure
          // we've already reserved, the delta we intended to apply, and the
          // exception that blocked the write. Best-effort — if this INSERT
          // also fails, the outer catch logs and we stop there.
          console.error('Post-stream reconcile failed:', e);
          try {
            await sql`
            INSERT INTO logging_errors (
              error_id, error_name, error_message, user_id, chart_id,
              request_metadata
            )
            VALUES (
              ${crypto.randomUUID()},
              'DiagnosticReconcileFailed',
              ${`Reconcile failed: ${e instanceof Error ? e.message : String(e)}`},
              ${actorId},
              ${chartId ?? null},
              ${JSON.stringify({
                user_id: actorId,
                projected_micro_usd: projected.toString(),
                observed_delta_micro_usd: deltaMicro.toString(),
                actual_micro_usd: actualMicro.toString(),
                error_message: e instanceof Error ? e.message : String(e),
                model,
                deployment_host: requestUrl.hostname,
                fired_at_ms: Date.now(),
              })}
            )
            ON CONFLICT (error_id) DO NOTHING
          `;
          } catch (innerErr) {
            console.error('reconcile-failure diagnostic insert also failed:', innerErr);
          }
        }
      }

      // Per-message attribution: populate logging_messages.cost_micro_usd so
      // per-chart cost queries can JOIN + SUM without a separate aggregate. Only
      // runs if the client passed X-Logging-Message-Id. Fire-and-forget.
      //
      // NO `actualMicro > 0n` gate: a user-aborted stream can produce
      // actualMicro=0 if the abort raced parseFrame's accumulator update, but
      // tokens were still billed by Anthropic. Writing 0 here is better than
      // skipping — the row is "settled" and a follow-up audit can spot rows
      // with reconciled=0 + content_blocks present (means the accumulator
      // missed a usage event). Logged via DiagnosticReconcileEmptyAccumulator
      // when this happens to a row that DID stream content.
      if (loggingMessageId) {
        try {
          await sql`
          UPDATE logging_messages
          SET cost_micro_usd = ${actualMicro.toString()}::bigint
          WHERE message_id = ${loggingMessageId}
        `;
        } catch (e) {
          console.error('logging_messages cost update failed (non-fatal):', e);
        }

        // Diagnostic: a stream that ended with empty accumulator usage means
        // either no SSE arrived (network failure / instant abort) OR the
        // accumulator update was racing the reconcile read. We can't recover
        // the cost retroactively but we flag every empty-accumulator case
        // for analysis. blocksCount surfaces which scenario it was: 0 means
        // the worker forwarded nothing, >0 means content streamed but the
        // usage merge was lost.
        const blocksCount = teeCtx.streamingContent.blocks.size;
        const accumulatorEmpty =
          teeCtx.accumulator.input_tokens === 0 &&
          teeCtx.accumulator.output_tokens === 0 &&
          teeCtx.accumulator.cache_creation_input_tokens === 0 &&
          teeCtx.accumulator.cache_read_input_tokens === 0;
        if (accumulatorEmpty) {
          try {
            await sql`
            INSERT INTO logging_errors (
              error_id, error_name, error_message, user_id, chart_id,
              request_metadata
            )
            VALUES (
              ${crypto.randomUUID()},
              'DiagnosticReconcileEmptyAccumulator',
              ${`Reconcile saw empty accumulator (blocks_count=${blocksCount}, killed=${teeCtx.killed.v}, messageDeltaSeen=${teeCtx.messageDeltaSeen})`},
              ${actorId},
              ${chartId ?? null},
              ${JSON.stringify({
                user_id: actorId,
                logging_message_id: loggingMessageId,
                blocks_count: blocksCount,
                tier,
                model,
                killed: teeCtx.killed.v,
                killDiagnosticPresent: teeCtx.killDiagnostic !== null,
                deployment_host: requestUrl.hostname,
                fired_at_ms: Date.now(),
              })}
            )
            ON CONFLICT (error_id) DO NOTHING
          `;
          } catch (innerErr) {
            console.error('reconcile-empty-accumulator diagnostic insert failed:', innerErr);
          }
        }
      }

      // Per-message analytics: populate logging_messages.content_blocks (raw
      // assistant turn) and was_killed (cost-cap kill fired) so the analytics
      // team can fork conversations from any point and replay via the
      // Messages API. UPDATE-only: the row was INSERTed by the client via
      // logging-saveMessage when the turn started; we just augment it here.
      //
      // Gating mirrors the other logging-* endpoints: opt-out applies only to
      // authenticated users (anon opt-out is enforced client-side; anon users
      // have no server-side identity to key a preference against). Anonymous
      // requests are always written.
      //
      // Two UPDATEs because was_killed and content_blocks have different
      // applicability:
      //   - was_killed must always be persisted when the row exists, including
      //     when the kill fired before any content_block_start event arrived
      //     (analyticsBlocks would be empty in that case).
      //   - content_blocks is only worth writing when we actually captured
      //     blocks — empty array writes destroy the pre-existing `content`
      //     text column's information value for "no blocks captured" rows.
      //
      // was_killed semantically means "cost-cap kill fired" specifically, NOT
      // any stream termination. The not_found_error interception path also
      // sets teeCtx.killed.v (for flow control), but does not set
      // killDiagnostic — so killDiagnostic is the authoritative cost-cap
      // signal.
      if (loggingMessageId) {
        const optedOut = await isUserOptedOut(sql, actor.authenticated ? actorId : null);
        if (!optedOut) {
          const wasKilledByCostCap = teeCtx.killDiagnostic !== null;
          // Always-on: was_killed reflects whether the cost-cap kill fired,
          // independent of how many content blocks were captured.
          try {
            await sql`
              UPDATE logging_messages
              SET was_killed = ${wasKilledByCostCap}
              WHERE message_id = ${loggingMessageId}
            `;
          } catch (e) {
            console.error('logging_messages was_killed update failed (non-fatal):', e);
            try {
              await sql`
                INSERT INTO logging_errors (
                  error_id, error_name, error_message, user_id, chart_id,
                  request_metadata
                )
                VALUES (
                  ${crypto.randomUUID()},
                  'analytics_was_killed_update_failed',
                  ${`logging_messages.was_killed update failed: ${e instanceof Error ? e.message : String(e)}`},
                  ${actorId},
                  ${chartId ?? null},
                  ${JSON.stringify({
                    logging_message_id: loggingMessageId,
                    was_killed: wasKilledByCostCap,
                    error_message: e instanceof Error ? e.message : String(e),
                    deployment_host: requestUrl.hostname,
                    fired_at_ms: Date.now(),
                  })}
                )
                ON CONFLICT (error_id) DO NOTHING
              `;
            } catch (innerErr) {
              console.error('was_killed-failure diagnostic insert also failed:', innerErr);
            }
          }

          // Conditional: content_blocks only when we captured blocks.
          const analyticsBlocks = collectAssistantBlocksForAnalytics(
            teeCtx.streamingContent.blocks,
          );
          if (analyticsBlocks.length > 0) {
            try {
              // Stringify directly (TEXT column, not JSONB) so signed thinking
              // blocks round-trip byte-identical for replay — Postgres JSONB
              // would normalize key ordering / whitespace / numbers, which
              // could break Anthropic signature verification.
              await sql`
                UPDATE logging_messages
                SET content_blocks = ${JSON.stringify(analyticsBlocks)}
                WHERE message_id = ${loggingMessageId}
              `;
            } catch (e) {
              console.error('logging_messages content_blocks update failed (non-fatal):', e);
              // Mirror the reconcile-failure diagnostic pattern: persist a
              // logging_errors row so silent analytics drift is visible. If
              // this ALSO fails, fall through — outer console.error already
              // captured the original.
              try {
                await sql`
                  INSERT INTO logging_errors (
                    error_id, error_name, error_message, user_id, chart_id,
                    request_metadata
                  )
                  VALUES (
                    ${crypto.randomUUID()},
                    'analytics_content_blocks_update_failed',
                    ${`logging_messages.content_blocks update failed: ${e instanceof Error ? e.message : String(e)}`},
                    ${actorId},
                    ${chartId ?? null},
                    ${JSON.stringify({
                      logging_message_id: loggingMessageId,
                      block_count: analyticsBlocks.length,
                      error_message: e instanceof Error ? e.message : String(e),
                      deployment_host: requestUrl.hostname,
                      fired_at_ms: Date.now(),
                    })}
                  )
                  ON CONFLICT (error_id) DO NOTHING
                `;
              } catch (innerErr) {
                console.error('content_blocks-failure diagnostic insert also failed:', innerErr);
              }
            }
          }
        }
      }

      // Persist reconcile output-source whenever message_delta never arrived
      // on a stream that should have completed cleanly. PR previews have no
      // worker logs, so this is the only way to tell if the output-token
      // estimator is doing its job (or silently falling back to the
      // message_start placeholder and under-billing a whole turn).
      //
      // Gate on !killed.v: any kill (cost-cap OR not_found interception)
      // tears the stream down before message_delta would naturally arrive,
      // so its absence is expected, not a signal worth diagnosing. Without
      // this gate every kill writes a noise row.
      if (!teeCtx.killed.v && !teeCtx.messageDeltaSeen) {
        try {
          await sql`
          INSERT INTO logging_errors (
            error_id, error_name, error_message, user_id, chart_id,
            request_metadata
          )
          VALUES (
            ${crypto.randomUUID()},
            'DiagnosticReconcileWithoutMessageDelta',
            ${`Reconcile w/o message_delta: output source=${reconcileOutputSource}, output=${reconciledOutput}, actual=${actualMicro.toString()} µUSD`},
            ${actorId},
            ${chartId ?? null},
            ${JSON.stringify({
              reconcile_output_source: reconcileOutputSource,
              reconciled_output_tokens: reconciledOutput,
              accumulator_output_tokens: accumulator.output_tokens,
              last_poll_output_tokens: teeCtx.lastPollOutputTokens,
              projected_micro_usd: projected.toString(),
              actual_micro_usd: actualMicro.toString(),
              accumulator: reconciledAccumulator,
              live_web_search_count: teeCtx.streamingContent.webSearchCount,
              model,
              chart_id: chartId,
              deployment_host: requestUrl.hostname,
              fired_at_ms: Date.now(),
            })}
          )
          ON CONFLICT (error_id) DO NOTHING
        `;
        } catch (e) {
          console.error('reconcile-without-message_delta diagnostic insert failed:', e);
        }
      }

      // Persist first-time poll-disable reason to logging_errors. The poller
      // going silent is a primary cause of overshoot (parse_frame kill only
      // fires on usage-event boundaries, so without polling the window between
      // message_start and message_delta is kill-blind for output tokens). We
      // need to know WHY — rate limit vs upstream 5xx vs shape change — to
      // tune.
      if (teeCtx.pollDisableDiagnostic) {
        try {
          const p = teeCtx.pollDisableDiagnostic;
          await sql`
          INSERT INTO logging_errors (
            error_id, error_name, error_message, user_id, chart_id,
            http_status, request_metadata
          )
          VALUES (
            ${crypto.randomUUID()},
            'DiagnosticPollDisabled',
            ${`Polling disabled: ${p.reason}${p.error_message ? ` — ${p.error_message}` : ''}`},
            ${actorId},
            ${chartId ?? null},
            ${p.http_status ?? null},
            ${JSON.stringify({
              reason: p.reason,
              http_status: p.http_status,
              upstream_body: p.upstream_body,
              error_message: p.error_message,
              fired_at_ms: p.fired_at_ms,
              model,
              deployment_host: requestUrl.hostname,
            })}
          )
          ON CONFLICT (error_id) DO NOTHING
        `;
        } catch (e) {
          console.error('poll-disable diagnostic insert failed (non-fatal):', e);
        }
      }

      // Persist kill-switch diagnostics to logging_errors so post-hoc debugging
      // doesn't depend on worker log availability. Errors bypass the usage-data
      // opt-out, so this lands unconditionally. Minimal payload — no message
      // content.
      if (teeCtx.killDiagnostic) {
        try {
          const d = teeCtx.killDiagnostic;
          const diagnosticMetadata = {
            source: d.source,
            cumulative_micro_usd: d.cumulative_micro_usd,
            threshold_micro_usd: d.threshold_micro_usd,
            actual_reconciled_micro_usd: actualMicro.toString(),
            projected_micro_usd: projected.toString(),
            accumulator_at_kill: d.accumulator_at_kill,
            accumulator_at_reconcile: accumulator,
            live_web_search_count: d.live_web_search_count,
            output_tokens_est: d.output_tokens_est,
            count_tokens_total: d.count_tokens_total,
            polling_disabled: teeCtx.pollingDisabled,
            model,
            chart_id: chartId,
            logging_message_id: loggingMessageId,
            // Worker hostname of the request that produced this kill. Lets us
            // tell prod (`theory-of-change-builder.*`) apart from branch
            // previews (`<branch>-theory-of-change-builder.*`) without a
            // separate env var — preview URLs have no log streams anyway so
            // DB rows are the only signal we have.
            deployment_host: requestUrl.hostname,
          };
          await sql`
          INSERT INTO logging_errors (
            error_id, error_name, error_message, user_id, chart_id,
            request_metadata
          )
          VALUES (
            ${crypto.randomUUID()},
            'DiagnosticKillSwitchFired',
            ${`Kill fired from ${d.source}: cumulative=${d.cumulative_micro_usd} µUSD, threshold=${d.threshold_micro_usd} µUSD`},
            ${actorId},
            ${chartId ?? null},
            ${JSON.stringify(diagnosticMetadata)}
          )
          ON CONFLICT (error_id) DO NOTHING
        `;
        } catch (e) {
          console.error('kill diagnostic insert failed (non-fatal):', e);
        }
      }

      // End-of-IIFE marker. If we observe DiagnosticReconcileEntered for a turn
      // but no DiagnosticReconcileCompleted (and no DiagnosticReconcileBailedUnhandled
      // / DiagnosticReconcileCostComputeFailed), it means the IIFE was terminated
      // by Cloudflare's waitUntil time budget rather than by an exception we caught.
      if (loggingMessageId) {
        try {
          await sql`
            INSERT INTO logging_errors (
              error_id, error_name, error_message, user_id, chart_id,
              request_metadata
            )
            VALUES (
              ${crypto.randomUUID()},
              'DiagnosticReconcileCompleted',
              'Reconcile IIFE reached end',
              ${actorId},
              ${chartId ?? null},
              ${JSON.stringify({
                logging_message_id: loggingMessageId,
                tier,
                model,
                killed: teeCtx.killed.v,
                message_delta_seen: teeCtx.messageDeltaSeen,
                deployment_host: requestUrl.hostname,
                fired_at_ms: Date.now(),
              })}
            )
            ON CONFLICT (error_id) DO NOTHING
          `;
        } catch (e) {
          console.error('reconcile-completed diagnostic insert failed:', e);
        }
      }
    })().catch(async (outerErr) => {
      // Anything that throws inside the IIFE without being caught lands here.
      // Without this, ctx.waitUntil silently swallows the rejection and we get
      // DiagnosticReconcileEntered with no follow-up row — indistinguishable
      // from a Cloudflare budget kill. The completion marker above + this
      // catch together let us tell the two failure modes apart.
      console.error('Reconcile IIFE bailed unhandled:', outerErr);
      if (loggingMessageId) {
        try {
          await sql`
            INSERT INTO logging_errors (
              error_id, error_name, error_message, user_id, chart_id,
              request_metadata
            )
            VALUES (
              ${crypto.randomUUID()},
              'DiagnosticReconcileBailedUnhandled',
              ${`Unhandled throw in reconcile IIFE: ${outerErr instanceof Error ? outerErr.message : String(outerErr)}`},
              ${actorId},
              ${chartId ?? null},
              ${JSON.stringify({
                logging_message_id: loggingMessageId,
                tier,
                model,
                error_message: outerErr instanceof Error ? outerErr.message : String(outerErr),
                error_stack: outerErr instanceof Error ? outerErr.stack : null,
                deployment_host: requestUrl.hostname,
                fired_at_ms: Date.now(),
              })}
            )
            ON CONFLICT (error_id) DO NOTHING
          `;
        } catch (innerErr) {
          console.error('reconcile-bailed diagnostic insert failed:', innerErr);
        }
      }
    }),
  );

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

type RevertDiagnosticContext = {
  model: string;
  chartId: string | null;
  deploymentHost: string;
};

function revertReservation(
  ctx: ExecutionContext,
  sql: NeonQueryFunction<false, false>,
  userId: string,
  projected: bigint,
  diagCtx?: RevertDiagnosticContext,
): void {
  if (projected === 0n) return;
  const minusProj = (-projected).toString();
  ctx.waitUntil(
    (async () => {
      try {
        await sql`
        UPDATE user_api_usage
        SET cost_micro_usd = GREATEST(0::bigint, cost_micro_usd + ${minusProj}::bigint)
        WHERE user_id = ${userId}
      `;
      } catch (e) {
        // A silent revert failure leaves an over-reservation permanently on
        // the user's row with no breadcrumb. Persist the metadata a human
        // needs to reconcile later: the user, the µUSD we failed to return,
        // and the error that blocked the UPDATE.
        console.error('Reservation revert failed (leaves a small over-reservation):', e);
        try {
          await sql`
          INSERT INTO logging_errors (
            error_id, error_name, error_message, user_id, chart_id,
            request_metadata
          )
          VALUES (
            ${crypto.randomUUID()},
            'DiagnosticRevertFailed',
            ${`Reservation revert failed: ${e instanceof Error ? e.message : String(e)}`},
            ${userId},
            ${diagCtx?.chartId ?? null},
            ${JSON.stringify({
              user_id: userId,
              projected_micro_usd: projected.toString(),
              error_message: e instanceof Error ? e.message : String(e),
              model: diagCtx?.model,
              deployment_host: diagCtx?.deploymentHost,
              fired_at_ms: Date.now(),
            })}
          )
          ON CONFLICT (error_id) DO NOTHING
        `;
        } catch (innerErr) {
          console.error('revert-failure diagnostic insert also failed:', innerErr);
        }
      }
    })(),
  );
}
