// Single source of truth for Anthropic pricing + per-model capabilities.
//
// Both the Worker (integer µUSD BigInt arithmetic for cost-accurate reservation
// and reconcile) and the frontend (float USD for composer estimates and the
// per-message display) import from here, so a rate change touches one file.
// The worker converts to integer ratios at load time; the frontend uses the
// floats directly. Values verified against
// https://platform.claude.com/docs/en/about-claude/models/overview (capabilities)
// and https://platform.claude.com/docs/en/about-claude/pricing (rates).

export interface ModelPricing {
  /** USD per million input tokens (uncached). */
  input_usd_per_mtok: number;
  /** USD per million output tokens (includes extended thinking; no surcharge). */
  output_usd_per_mtok: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7':   { input_usd_per_mtok: 5, output_usd_per_mtok: 25 },
  'claude-opus-4-6':   { input_usd_per_mtok: 5, output_usd_per_mtok: 25 },
  'claude-sonnet-4-6': { input_usd_per_mtok: 3, output_usd_per_mtok: 15 },
  'claude-haiku-4-5':  { input_usd_per_mtok: 1, output_usd_per_mtok: 5  },
};

export interface ModelCapabilities {
  /** Total context window in tokens (input + output combined). */
  context_window_tokens: number;
  /** Maximum output tokens the synchronous Messages API will emit. */
  max_output_tokens: number;
  /** Whether this model supports extended / adaptive thinking blocks. */
  supports_extended_thinking: boolean;
  /** Whether this model accepts `output_config: {effort}`; Opus 4.7 only at time of writing. */
  supports_output_config_effort: boolean;
}

export const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'claude-opus-4-7':   { context_window_tokens: 1_000_000, max_output_tokens: 128_000, supports_extended_thinking: true,  supports_output_config_effort: true  },
  'claude-opus-4-6':   { context_window_tokens: 1_000_000, max_output_tokens: 128_000, supports_extended_thinking: true,  supports_output_config_effort: false },
  'claude-sonnet-4-6': { context_window_tokens: 1_000_000, max_output_tokens:  64_000, supports_extended_thinking: true,  supports_output_config_effort: false },
  'claude-haiku-4-5':  { context_window_tokens:   200_000, max_output_tokens:  64_000, supports_extended_thinking: true,  supports_output_config_effort: false },
};

// Ephemeral prompt-cache multipliers applied to the input rate.
// Write (default 5-minute TTL) is 1.25× base input; reads are 0.1×.
// Anthropic also offers a "1h" TTL with a 2× write multiplier which we
// don't use; add an entry here if we start setting `ttl: "1h"` anywhere.
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** Server-tool web_search: flat USD per invocation. */
export const WEB_SEARCH_USD_PER_USE = 0.01;

/** Default ephemeral cache TTL in milliseconds (5 minutes). */
export const CACHE_TTL_MS = 5 * 60 * 1000;
