import type { Env } from '../_shared/types';
import { RATES_MICRO_USD_PER_TOKEN } from '../_shared/cost';

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
    return Response.json({ error: 'estimation_unavailable' }, { status: 503 });
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

  // Fallback rate mirrors Opus input ($5/MTok == 5 µUSD/token). Unknown models
  // get the conservative (highest) rate so UI estimates don't understate.
  const rate = RATES_MICRO_USD_PER_TOKEN[model]?.input ?? 5;
  const estimatedCostUsd = (inputTokens * rate) / 1_000_000;

  return Response.json({
    input_tokens: inputTokens,
    estimated_cost_usd: estimatedCostUsd,
    model,
  });
}
