/**
 * Cost computation for Anthropic API usage.
 *
 * Rates come from `shared/pricing.ts` (single source of truth). This module
 * converts the USD/MTok floats into integer µUSD/token so the reservation,
 * mid-stream kill switch, and post-stream reconcile can all stay in BigInt
 * arithmetic. Usage totals accumulate for months and would lose precision
 * as Number (IEEE 754).
 *
 * Single-sourced: update `shared/pricing.ts` to change a rate.
 */

import {
  MODEL_PRICING,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  WEB_SEARCH_USD_PER_USE,
} from '../../shared/pricing';

export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
};

/**
 * Per-model rates in µUSD per token, derived from `shared/pricing.ts`.
 * USD/MTok and µUSD/token are numerically equal ($5/MTok = 5 µUSD/tok), so
 * the derivation is just a re-key.
 */
export const RATES_MICRO_USD_PER_TOKEN: Record<string, { input: number; output: number }> =
  Object.fromEntries(
    Object.entries(MODEL_PRICING).map(([model, p]) => [
      model,
      { input: p.input_usd_per_mtok, output: p.output_usd_per_mtok },
    ]),
  );

// Integer ratios (numerator/denominator, denominator = 100) for the BigInt
// cache-multiplier math below. Derived from the shared floats so pricing
// updates only touch shared/pricing.ts. Math.round guards against IEEE 754
// wobble for e.g. 0.1 (which isn't exactly representable).
const CACHE_WRITE_NUM = BigInt(Math.round(CACHE_WRITE_5M_MULTIPLIER * 100));
const CACHE_READ_NUM = BigInt(Math.round(CACHE_READ_MULTIPLIER * 100));
const CACHE_DENOM = 100n;

/** Web-search tool: flat µUSD per request ($0.01 = 10_000 µUSD). */
export const WEB_SEARCH_MICRO_USD_PER_USE = Math.round(WEB_SEARCH_USD_PER_USE * 1_000_000);

// Re-export the shared floats under their historical names so existing
// imports (`CACHE_WRITE_5M_MULT`, `CACHE_READ_MULT`) keep working.
export const CACHE_WRITE_5M_MULT = CACHE_WRITE_5M_MULTIPLIER;
export const CACHE_READ_MULT = CACHE_READ_MULTIPLIER;

/**
 * Compute the total cost in micro-USD for an Anthropic usage record.
 *
 * All arithmetic uses BigInt; floating cache multipliers are expressed as
 * integer ratios (see CACHE_WRITE_NUM/CACHE_READ_NUM above) to keep the
 * result exact. Truncation on division is acceptable at µUSD precision —
 * it rounds down by at most 1 µUSD per term, well below anything we meter
 * against (cents, dollars).
 *
 * Throws on unknown model rather than silently returning 0. A missing model
 * entry indicates the pricing table is out of sync with what anthropic-stream
 * is actually sending — a bug the caller should surface, not mask.
 */
export function computeCostMicroUsd(model: string, usage: AnthropicUsage): bigint {
  const r = RATES_MICRO_USD_PER_TOKEN[model];
  if (!r) {
    throw new Error(`Unknown model for cost computation: ${model}`);
  }

  const inputRate = BigInt(r.input);
  const outputRate = BigInt(r.output);

  const input       = BigInt(usage.input_tokens ?? 0) * inputRate;
  const cacheCreate = (BigInt(usage.cache_creation_input_tokens ?? 0) * inputRate * CACHE_WRITE_NUM) / CACHE_DENOM;
  const cacheRead   = (BigInt(usage.cache_read_input_tokens ?? 0)     * inputRate * CACHE_READ_NUM)  / CACHE_DENOM;
  const output      = BigInt(usage.output_tokens ?? 0) * outputRate;
  const webSearch   = BigInt(usage.server_tool_use?.web_search_requests ?? 0)
    * BigInt(WEB_SEARCH_MICRO_USD_PER_USE);

  return input + cacheCreate + cacheRead + output + webSearch;
}
