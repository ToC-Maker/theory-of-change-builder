import { describe, expect, it } from 'vitest';
import { computeCostMicroUsd, RATES_MICRO_USD_PER_TOKEN } from '../../worker/_shared/cost';

describe('computeCostMicroUsd', () => {
  it('returns 0 for empty usage', () => {
    expect(computeCostMicroUsd('claude-opus-4-7', {})).toBe(0n);
  });

  it('opus 4.7: 1M input tokens → $5 = 5_000_000 μUSD', () => {
    expect(computeCostMicroUsd('claude-opus-4-7', { input_tokens: 1_000_000 })).toBe(5_000_000n);
  });

  it('opus 4.7: 1M output tokens → $25 = 25_000_000 μUSD', () => {
    expect(computeCostMicroUsd('claude-opus-4-7', { output_tokens: 1_000_000 })).toBe(25_000_000n);
  });

  it('sonnet 4.6: cache write 100K = 100_000 × 3 × 1.25 = 375_000 μUSD', () => {
    expect(computeCostMicroUsd('claude-sonnet-4-6', { cache_creation_input_tokens: 100_000 })).toBe(
      375_000n,
    );
  });

  it('sonnet 4.6: cache read 100K = 100_000 × 3 × 0.1 = 30_000 μUSD', () => {
    expect(computeCostMicroUsd('claude-sonnet-4-6', { cache_read_input_tokens: 100_000 })).toBe(
      30_000n,
    );
  });

  it('haiku 4.5: 1M input + 1M output = 1_000_000 + 5_000_000 = 6_000_000 μUSD', () => {
    expect(
      computeCostMicroUsd('claude-haiku-4-5', {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
      }),
    ).toBe(6_000_000n);
  });

  it('10 web searches = 10 × 10_000 = 100_000 μUSD', () => {
    expect(
      computeCostMicroUsd('claude-opus-4-7', {
        server_tool_use: { web_search_requests: 10 },
      }),
    ).toBe(100_000n);
  });

  it('throws on unknown model', () => {
    expect(() => computeCostMicroUsd('unknown-model', { input_tokens: 100 })).toThrow();
  });

  it('rate table covers all current models', () => {
    expect(Object.keys(RATES_MICRO_USD_PER_TOKEN)).toContain('claude-opus-4-7');
    expect(Object.keys(RATES_MICRO_USD_PER_TOKEN)).toContain('claude-sonnet-4-6');
    expect(Object.keys(RATES_MICRO_USD_PER_TOKEN)).toContain('claude-haiku-4-5');
  });
});
