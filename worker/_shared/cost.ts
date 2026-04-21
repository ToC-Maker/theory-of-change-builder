// STUB: Will be superseded by Unit 2 (U2) on merge.
// Matches the interface documented in plans/cost-controls.md §Integration contracts.

export type AnthropicUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
};

export const RATES_MICRO_USD_PER_TOKEN: Record<string, { input: number; output: number }> = {};

export function computeCostMicroUsd(model: string, usage: AnthropicUsage): bigint {
  // Stub: Unit 2 will supply the real implementation.
  void model;
  void usage;
  return 0n;
}
