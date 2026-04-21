// Client-side cost formatting helpers for BYOK / cost-estimate UI.
// Intentionally decoupled from worker/_shared/cost.ts so the frontend bundle
// stays lean; pricing is duplicated here in $/MTok for direct UI readability.

// Pricing in USD per million tokens — mirrors worker/_shared/cost.ts but
// expressed in $/MTok for UI clarity.
export const MODEL_INPUT_RATES_USD_PER_MTOK: Record<string, number> = {
  'claude-opus-4-7':   5,
  'claude-opus-4-6':   5,
  'claude-sonnet-4-6': 3,
  'claude-haiku-4-5':  1,
};

export const MODEL_OUTPUT_RATES_USD_PER_MTOK: Record<string, number> = {
  'claude-opus-4-7':   25,
  'claude-opus-4-6':   25,
  'claude-sonnet-4-6': 15,
  'claude-haiku-4-5':  5,
};

export const WEB_SEARCH_USD_PER_USE = 0.01;

/** Rough lower-bound estimate: input cost only, assuming no output. */
export function estimateCostLowBound(inputTokens: number, model: string): number {
  const rate = MODEL_INPUT_RATES_USD_PER_MTOK[model];
  if (rate == null) return 0;
  return (inputTokens / 1_000_000) * rate;
}

/** Compact USD formatter: $0.0047, $0.05, $1.20, $12.34, $123 */
export function formatCostUsd(usd: number): string {
  if (usd < 1) return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

/** "Est. $0.47 • up to $X budget remaining" (undefined remaining omits the second clause) */
export function estimateRangeString(lowUsd: number, remainingUsd?: number): string {
  const base = `Est. ${formatCostUsd(lowUsd)}`;
  if (remainingUsd == null) return base;
  return `${base} • up to ${formatCostUsd(remainingUsd)} budget remaining`;
}

/**
 * Very rough client-side input-token estimator from a char count.
 * Used only for the pre-submission estimate display; server does a real
 * count_tokens call before the actual API request. Rule of thumb: ~4
 * chars/token for English. Opus 4.7 has up to 35% tokenizer bloat; bias up.
 */
export function roughInputTokensFromChars(chars: number, model: string): number {
  const charsPerToken = model === 'claude-opus-4-7' ? 3 : 4;
  return Math.ceil(chars / charsPerToken);
}
