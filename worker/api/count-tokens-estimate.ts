import type { Env } from '../_shared/types';
import { RATES_MICRO_USD_PER_TOKEN } from '../_shared/cost';
import { getDb } from '../_shared/db';
import { extractToken, verifyToken } from '../_shared/auth';

// POST /api/count-tokens-estimate — thin pass-through to Anthropic's
// /v1/messages/count_tokens plus a cost projection using the server's rate
// table. count_tokens is a free Anthropic endpoint (no usage billed), so we
// can call it on every "about to submit" preview without cap-gating.
//
// Body matches Anthropic's shape (at minimum: `model`, `messages`; optional
// `system`, `tools`). Uses the server's ANTHROPIC_API_KEY — BYOK is not
// consulted here because count_tokens doesn't accrue cost for either side,
// and centralising it keeps the UI estimate independent of BYOK state.

export async function handler(request: Request, env: Env): Promise<Response> {
  let body: {
    model?: unknown;
    messages?: unknown;
    system?: unknown;
    tools?: unknown;
    chartId?: unknown;
  };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  const model = body.model;
  if (typeof model !== 'string' || !model) {
    return Response.json({ error: 'missing_model' }, { status: 400 });
  }

  // chartId is optional (older clients don't send it) but required to safely
  // scope the chart_files lookup below. Without it, the cache lookup would
  // be an IDOR — any caller with a file_id owned by a different chart could
  // read its token count. VARCHAR(12) matches the charts.id column shape.
  let chartId: string | null = null;
  if (body.chartId !== undefined && body.chartId !== null) {
    if (typeof body.chartId !== 'string' || !body.chartId || body.chartId.length > 12) {
      return Response.json({ error: 'invalid_chart_id' }, { status: 400 });
    }
    chartId = body.chartId;
  }

  // Strip `{type: 'document', source: {type: 'file', ...}}` content blocks.
  // Anthropic's count_tokens accepts document sources of type base64,
  // text, content, and url — but NOT `file` (Files-API file_id). Leaving
  // them in returns 400 "invalid source type" and the composer preview
  // shows "service unavailable" whenever the user has PDFs attached.
  // The /v1/messages endpoint itself DOES accept file sources, so stream
  // sending is fine; only count_tokens needs this fix.
  //
  // Collect the stripped file_ids so we can sum their cached input_tokens
  // (populated by upload-file at upload time) and restore a precise total.
  //
  // Split by origin: file_ids in the LAST message are "draft-side" (the
  // user's in-composition turn); earlier messages are "history-side" and
  // already in Anthropic's cached prefix (billed at cache-read rates, not
  // cache-write, within the 5m ephemeral TTL). Client uses this split to
  // price the estimate correctly — previously all file tokens went into
  // the draft bucket, inflating history-PDF estimates by 12.5×.
  const draftFileIds: string[] = [];
  const historyFileIds: string[] = [];
  if (Array.isArray(body.messages)) {
    const msgs = body.messages as Array<Record<string, unknown>>;
    const lastIdx = msgs.length - 1;
    body.messages = msgs.map((msg, idx) => {
      if (!Array.isArray(msg.content)) return msg;
      const bucket = idx === lastIdx ? draftFileIds : historyFileIds;
      const filtered = (msg.content as Array<Record<string, unknown>>).filter((block) => {
        if (block?.type !== 'document') return true;
        const src = block.source as Record<string, unknown> | undefined;
        if (src?.type === 'file') {
          const fid = typeof src.file_id === 'string' ? src.file_id : null;
          if (fid) bucket.push(fid);
          return false;
        }
        return true;
      });
      return { ...msg, content: filtered };
    });
  }
  const strippedFileIds = [...draftFileIds, ...historyFileIds];

  // Whitelist the fields we forward to Anthropic. Previously we sent the
  // full request body verbatim, which meant extra fields (e.g. chartId,
  // max_tokens, server-tools) would leak to Anthropic's count_tokens and
  // either be ignored or reject the request. Now we send only the four
  // fields the endpoint documents.
  const forwardBody: Record<string, unknown> = {
    model,
    messages: body.messages,
  };
  if (body.system !== undefined) forwardBody.system = body.system;
  if (body.tools !== undefined) forwardBody.tools = body.tools;

  let upstream: Response;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
        'content-type': 'application/json',
      },
      body: JSON.stringify(forwardBody),
    });
  } catch (err) {
    console.error('[count-tokens-estimate] upstream fetch failed:', err);
    return Response.json({ error: 'estimation_unavailable' }, { status: 503 });
  }

  // Surface Anthropic rate-limits as 429 rather than collapsing into a
  // generic 503, so the client can honour Retry-After and back off instead
  // of retrying immediately.
  if (upstream.status === 429) {
    const retryAfter = upstream.headers.get('retry-after');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (retryAfter) headers['retry-after'] = retryAfter;
    const retryAfterSec = retryAfter ? Number(retryAfter) : undefined;
    return new Response(
      JSON.stringify({
        error: 'rate_limited',
        retry_after:
          Number.isFinite(retryAfterSec as number) && (retryAfterSec as number) >= 0
            ? retryAfterSec
            : undefined,
      }),
      { status: 429, headers },
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    console.error(
      `[count-tokens-estimate] upstream returned ${upstream.status}: ${errText}`,
    );
    // Surface Anthropic's own error message so the client can render
    // something actionable — previously the composer just said "service
    // unavailable" for all failure modes, which hid shape-mismatch bugs
    // (e.g. file_id not resolvable, beta header mismatch) for good since
    // preview deploys have no log stream.
    let upstreamMessage: string | undefined;
    try {
      const parsed = JSON.parse(errText) as { error?: { message?: string } };
      upstreamMessage = parsed?.error?.message;
    } catch {
      /* non-JSON body */
    }
    return Response.json(
      {
        error: 'estimation_unavailable',
        upstream_status: upstream.status,
        upstream_message: upstreamMessage,
      },
      { status: 503 },
    );
  }

  let parsed: { input_tokens?: number };
  try {
    parsed = await upstream.json() as typeof parsed;
  } catch (err) {
    console.error('[count-tokens-estimate] JSON parse failed:', err);
    return Response.json({ error: 'estimation_unavailable' }, { status: 503 });
  }

  const inputTokens = parsed.input_tokens;
  if (typeof inputTokens !== 'number' || !Number.isFinite(inputTokens) || inputTokens < 0) {
    console.error('[count-tokens-estimate] unexpected shape:', parsed);
    return Response.json({ error: 'estimation_unavailable' }, { status: 503 });
  }

  // Sum the precise cached token count for each stripped file_id. Populated
  // once at upload time (see upload-file.ts). NULL rows (pre-migration or a
  // count_tokens failure at upload) coalesce to 0 here — those files are
  // invisible to the estimate; the UI should flag the mismatch if the number
  // feels off. The count_tokens failure path at upload is logged.
  let cachedFileTokensDraft = 0;
  let cachedFileTokensHistory = 0;
  const uncountedFileIdList: string[] = [];
  const sql = getDb(env);

  // If the caller is authenticated and a chartId is supplied, verify they
  // actually have access to that chart before we hand back token counts.
  // Anon charts (no owner) are public by definition and don't need this
  // check. An owned chart + no JWT is refused — returning cache data for
  // a chart the caller can't otherwise read would be an IDOR.
  if (chartId) {
    const chartRows = await sql`
      SELECT user_id FROM charts WHERE id = ${chartId}
    ` as { user_id: string | null }[];
    const chartOwnerId = chartRows[0]?.user_id ?? null;
    if (chartOwnerId) {
      const token = extractToken(request.headers.get('authorization'));
      let allowed = false;
      if (token) {
        try {
          const decoded = await verifyToken(token, env);
          if (decoded.sub === chartOwnerId) {
            allowed = true;
          } else {
            const perm = await sql`
              SELECT status FROM chart_permissions
              WHERE chart_id = ${chartId} AND user_id = ${decoded.sub}
            ` as { status: string }[];
            allowed = !!perm.length && perm[0].status === 'approved';
          }
        } catch {
          /* bad token -> allowed stays false */
        }
      }
      if (!allowed) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
    }
  }

  if (strippedFileIds.length > 0) {
    try {
      // Scope by chart_id when we have one so a file_id that belongs to a
      // different chart can't leak its token count. When chartId is missing
      // (older clients) we fall back to the file_id-only query; this is
      // retained for compatibility and will be removed once all clients
      // carry the field.
      const rows = (chartId
        ? await sql`
            SELECT file_id, input_tokens
            FROM chart_files
            WHERE file_id = ANY(${strippedFileIds}) AND chart_id = ${chartId}
          `
        : await sql`
            SELECT file_id, input_tokens
            FROM chart_files
            WHERE file_id = ANY(${strippedFileIds})
          `) as { file_id: string; input_tokens: string | number | null }[];
      // Neon returns BIGINT as a string (safe for values > 2^53). Build a
      // lookup so we can bucket each file_id by whether it was in the draft
      // (last) message or history.
      const tokensByFileId = new Map<string, number>();
      for (const row of rows) {
        const n = row.input_tokens == null ? NaN : Number(row.input_tokens);
        if (Number.isFinite(n) && n >= 0) tokensByFileId.set(row.file_id, n);
      }
      for (const fid of draftFileIds) {
        const n = tokensByFileId.get(fid);
        if (n === undefined) uncountedFileIdList.push(fid);
        else cachedFileTokensDraft += n;
      }
      for (const fid of historyFileIds) {
        const n = tokensByFileId.get(fid);
        if (n === undefined) uncountedFileIdList.push(fid);
        else cachedFileTokensHistory += n;
      }
    } catch (err) {
      console.warn('[count-tokens-estimate] chart_files lookup failed:', err);
      // Surface the full list so the client can retry / flag the mismatch
      // rather than silently dropping these from the total.
      uncountedFileIdList.push(...strippedFileIds);
    }
  }

  const cachedFileTokens = cachedFileTokensDraft + cachedFileTokensHistory;
  const totalInputTokens = inputTokens + cachedFileTokens;

  // Fallback rate mirrors Opus input ($5/MTok == 5 µUSD/token). Unknown models
  // get the conservative (highest) rate so UI estimates don't understate.
  const rate = RATES_MICRO_USD_PER_TOKEN[model]?.input ?? 5;
  const estimatedCostUsd = (totalInputTokens * rate) / 1_000_000;

  return Response.json({
    input_tokens: totalInputTokens,
    estimated_cost_usd: estimatedCostUsd,
    model,
    // Diagnostic breakdown for the client: how many file blocks we stripped
    // and which ones had no cached token count. The client (Unit E) uses
    // the id list to reconcile a "+ ~$X for N uncounted PDFs" banner and
    // to know which files to re-probe if the count looks off.
    stripped_file_blocks: strippedFileIds.length,
    uncounted_file_ids: uncountedFileIdList,
    cached_file_tokens: cachedFileTokens,
    // Split so the client can apply cache-write (1.25×) to draft-side PDFs
    // and cache-read (0.1×) to history-side PDFs already in the prefix.
    cached_file_tokens_draft: cachedFileTokensDraft,
    cached_file_tokens_history: cachedFileTokensHistory,
  });
}
