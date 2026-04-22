/**
 * Cost computation for Anthropic API usage.
 *
 * Rates are stored as integer micro-USD per token so we can stay in integer
 * arithmetic (BigInt) end-to-end -- usage totals accumulate for months and
 * would lose precision as Number (IEEE 754).
 *
 * Single source of truth: the same `computeCostMicroUsd(model, usage)` call
 * is used for pre-flight reservation, mid-stream kill switch, and post-stream
 * reconcile. Rate table updates (new model, price change) land in one place.
 */

export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
};

/**
 * Per-model rates in micro-USD per token.
 * Source: Anthropic pricing (cost-controls plan §1.2). $5/MTok input == 5 µUSD/token.
 */
export const RATES_MICRO_USD_PER_TOKEN: Record<string, { input: number; output: number }> = {
  'claude-opus-4-7':   { input: 5, output: 25 },
  'claude-opus-4-6':   { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5':  { input: 1, output: 5  },
};

// Cache multipliers applied to the input rate.
// Write (5-minute TTL) is priced 1.25× the base input rate; reads are 0.1×.
// These constants are the canonical values; computeCostMicroUsd expresses them
// as integer ratios (125n/100n, 10n/100n) inline to stay in BigInt arithmetic.
// Update both places together if Anthropic changes cache pricing.
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_READ_MULT = 0.1;

// Web-search tool: flat $0.01 per request == 10_000 µUSD.
export const WEB_SEARCH_MICRO_USD_PER_USE = 10_000;

/**
 * Compute the total cost in micro-USD for an Anthropic usage record.
 *
 * All arithmetic uses BigInt; floating cache multipliers are expressed as
 * integer ratios (125/100, 10/100) to keep the result exact. Truncation on
 * division is acceptable at µUSD precision -- it rounds down by at most 1 µUSD
 * per term, which is well below anything we meter against (cents, dollars).
 *
 * Throws on unknown model rather than silently returning 0. A missing model
 * entry indicates the pricing table is out of sync with what anthropic-stream
 * is actually sending -- a bug the caller should surface, not mask.
 */
export function computeCostMicroUsd(model: string, usage: AnthropicUsage): bigint {
  const r = RATES_MICRO_USD_PER_TOKEN[model];
  if (!r) {
    throw new Error(`Unknown model for cost computation: ${model}`);
  }

  const inputRate = BigInt(r.input);
  const outputRate = BigInt(r.output);

  const input       = BigInt(usage.input_tokens ?? 0) * inputRate;
  const cacheCreate = (BigInt(usage.cache_creation_input_tokens ?? 0) * inputRate * 125n) / 100n;
  const cacheRead   = (BigInt(usage.cache_read_input_tokens ?? 0)     * inputRate * 10n)  / 100n;
  const output      = BigInt(usage.output_tokens ?? 0) * outputRate;
  const webSearch   = BigInt(usage.server_tool_use?.web_search_requests ?? 0)
    * BigInt(WEB_SEARCH_MICRO_USD_PER_USE);

  return input + cacheCreate + cacheRead + output + webSearch;
}
