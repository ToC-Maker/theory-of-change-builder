// Client-side cost formatting + estimate helpers. Pricing values come from
// `shared/pricing.ts` (single source of truth shared with the Worker). Only
// display-side helpers live here; actual billing math is server-side.

import {
  MODEL_PRICING,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_READ_MULTIPLIER,
  CACHE_TTL_MS,
  WEB_SEARCH_USD_PER_USE as SHARED_WEB_SEARCH_USD_PER_USE,
} from '../../shared/pricing';

// Derived USD/MTok views of the shared pricing table. Kept as separate
// input/output maps because the composer/estimate code keys by rate kind.
export const MODEL_INPUT_RATES_USD_PER_MTOK: Record<string, number> = Object.fromEntries(
  Object.entries(MODEL_PRICING).map(([model, p]) => [model, p.input_usd_per_mtok]),
);

export const MODEL_OUTPUT_RATES_USD_PER_MTOK: Record<string, number> = Object.fromEntries(
  Object.entries(MODEL_PRICING).map(([model, p]) => [model, p.output_usd_per_mtok]),
);

// Most-expensive input rate across the pricing table. Derived so a pricing
// change doesn't leave a stale fallback. Used as the conservative upper-bound
// estimate when `estimateCostLowBound` is called with an unknown model.
const MAX_INPUT_RATE_USD_PER_MTOK: number = Math.max(
  ...Object.values(MODEL_PRICING).map((p) => p.input_usd_per_mtok),
);

// Re-export the shared cache + web-search constants so existing imports
// keep working with a single canonical reference.
export const WEB_SEARCH_USD_PER_USE = SHARED_WEB_SEARCH_USD_PER_USE;
export const CACHE_WRITE_MULTIPLIER = CACHE_WRITE_5M_MULTIPLIER;
export const CACHE_READ_MULTIPLIER_VALUE = CACHE_READ_MULTIPLIER;
export const CACHE_TTL_MILLIS = CACHE_TTL_MS;

/**
 * Rough lower-bound estimate: input cost only, assuming no output.
 *
 * If the caller passes an unknown model (e.g. the dropdown drifted out of
 * sync with `shared/pricing.ts`), we used to silently return 0 — which
 * rendered "$0.00" in the composer and gave the user a dangerously wrong
 * impression of free usage. Instead, warn and fall back to the most
 * expensive input rate in the table so the displayed estimate is a
 * conservative upper bound. Callers that want to branch on "unknown
 * model" should check membership in `MODEL_INPUT_RATES_USD_PER_MTOK`
 * directly before calling this helper.
 */
export function estimateCostLowBound(inputTokens: number, model: string): number {
  const rate = MODEL_INPUT_RATES_USD_PER_MTOK[model];
  if (rate == null) {
    console.warn(
      `[cost] unknown model "${model}" passed to estimateCostLowBound; ` +
        `falling back to max input rate ($${MAX_INPUT_RATE_USD_PER_MTOK}/MTok)`,
    );
    return (inputTokens / 1_000_000) * MAX_INPUT_RATE_USD_PER_MTOK;
  }
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
 * Used only for the pre-submission estimate fallback when
 * /api/count-tokens-estimate is unreachable. Rule of thumb: ~4 chars/token
 * for English. Opus 4.7 has up to 35% tokenizer bloat; bias up.
 */
export function roughInputTokensFromChars(chars: number, model: string): number {
  const charsPerToken = model === 'claude-opus-4-7' ? 3 : 4;
  return Math.ceil(chars / charsPerToken);
}
