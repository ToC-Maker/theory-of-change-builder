import type { Env } from '../_shared/types';
import { RATES_MICRO_USD_PER_TOKEN } from '../_shared/cost';
import { getDb } from '../_shared/db';

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
  let body: { model?: unknown; messages?: unknown; system?: unknown; tools?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  const model = body.model;
  if (typeof model !== 'string' || !model) {
    return Response.json({ error: 'missing_model' }, { status: 400 });
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
  const strippedFileIds: string[] = [];
  if (Array.isArray(body.messages)) {
    body.messages = (body.messages as Array<Record<string, unknown>>).map((msg) => {
      if (!Array.isArray(msg.content)) return msg;
      const filtered = (msg.content as Array<Record<string, unknown>>).filter((block) => {
        if (block?.type !== 'document') return true;
        const src = block.source as Record<string, unknown> | undefined;
        if (src?.type === 'file') {
          const fid = typeof src.file_id === 'string' ? src.file_id : null;
          if (fid) strippedFileIds.push(fid);
          return false;
        }
        return true;
      });
      return { ...msg, content: filtered };
    });
  }

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
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[count-tokens-estimate] upstream fetch failed:', err);
    return Response.json({ error: 'estimation_unavailable' }, { status: 503 });
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
  let cachedFileTokens = 0;
  let uncountedFileIds = 0;
  if (strippedFileIds.length > 0) {
    try {
      const sql = getDb(env);
      const rows = await sql<{ file_id: string; input_tokens: number | null }>`
        SELECT file_id, input_tokens
        FROM chart_files
        WHERE file_id = ANY(${strippedFileIds}::text[])
      `;
      for (const row of rows) {
        if (typeof row.input_tokens === 'number' && row.input_tokens >= 0) {
          cachedFileTokens += row.input_tokens;
        } else {
          uncountedFileIds += 1;
        }
      }
      // file_ids not found in chart_files at all: treat as uncounted.
      uncountedFileIds += strippedFileIds.length - rows.length;
    } catch (err) {
      console.warn('[count-tokens-estimate] chart_files lookup failed:', err);
      uncountedFileIds = strippedFileIds.length;
    }
  }

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
    // and how many of those had no cached token count. The UI can render
    // "+ ~$X for N uncounted PDFs" if uncounted_file_ids > 0.
    stripped_file_blocks: strippedFileIds.length,
    uncounted_file_ids: uncountedFileIds,
    cached_file_tokens: cachedFileTokens,
  });
}
