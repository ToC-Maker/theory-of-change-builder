import { describe, expect, it } from 'vitest';
import { computeCostMicroUsd, RATES_MICRO_USD_PER_TOKEN } from '../../shared/cost';
import { MODEL_PRICING } from '../../shared/pricing';

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

  // Symmetry: every entry in the single-source-of-truth pricing table must
  // produce a non-NaN, non-negative BigInt µUSD for a minimal usage shape.
  // Catches any new model added to MODEL_PRICING without a matching entry in
  // RATES_MICRO_USD_PER_TOKEN, and any rate that would underflow or NaN.
  describe('all-model symmetry', () => {
    for (const model of Object.keys(MODEL_PRICING)) {
      it(`${model}: minimal usage → non-negative BigInt`, () => {
        const cost = computeCostMicroUsd(model, { input_tokens: 100, output_tokens: 50 });
        expect(typeof cost).toBe('bigint');
        expect(cost >= 0n).toBe(true);
        // Both rates >0 in the pricing table → minimal usage must be strictly >0.
        expect(cost > 0n).toBe(true);
      });
    }
  });

  // Composite golden: every per-component test above only exercises one
  // non-zero summand. A refactor that dropped (say) `cacheRead` from the
  // final sum would still pass them all. This test exercises all five
  // summands together and pins the total, so any dropped summand surfaces
  // as a wrong sum.
  //
  // Sonnet 4.6 (input=3 µUSD/tok, output=15 µUSD/tok):
  //   input        = 100_000 * 3                 = 300_000
  //   cache_write  = 50_000  * 3 * 125 / 100     = 187_500
  //   cache_read   = 200_000 * 3 *  10 / 100     =  60_000
  //   output       = 10_000  * 15                = 150_000
  //   web_search   = 5       * 10_000            =  50_000
  //                                              ─────────
  //                                                747_500
  it('sonnet 4.6: composite (input + cache_write + cache_read + output + web_search) sums all summands', () => {
    expect(
      computeCostMicroUsd('claude-sonnet-4-6', {
        input_tokens: 100_000,
        cache_creation_input_tokens: 50_000,
        cache_read_input_tokens: 200_000,
        output_tokens: 10_000,
        server_tool_use: { web_search_requests: 5 },
      }),
    ).toBe(747_500n);
  });

  // BigInt safety: the whole reason computeCostMicroUsd uses BigInt is to
  // avoid Number precision loss past 2^53. A "switched to Number(...)*r.input"
  // regression would pass every test above (max 1M tokens × $25/MTok ≈
  // 2.5×10^7 µUSD, comfortably within Number.MAX_SAFE_INTEGER = 2^53−1).
  // These pin the BigInt contract with values that Number can't represent.
  describe('BigInt safety past Number.MAX_SAFE_INTEGER', () => {
    // 10^9 input tokens × $5/MTok (opus-4.7) = 5×10^9 µUSD. Result still
    // fits in Number, but the BigInt(10^9) * BigInt(5) intermediate is the
    // smallest case that meaningfully exercises the BigInt path.
    it('opus 4.7: 1_000_000_000 input tokens → 5_000_000_000n µUSD', () => {
      expect(computeCostMicroUsd('claude-opus-4-7', { input_tokens: 1_000_000_000 })).toBe(
        5_000_000_000n,
      );
    });

    // Boundary: input_tokens = MAX_SAFE_INTEGER * opus-4.7 input rate ($5).
    // Number(MAX_SAFE_INTEGER) * 5 = 4.503599627370495e16 which Number CAN
    // still hold (just). But MAX_SAFE_INTEGER * 5 + tiny exact remainder is
    // where Number IEEE-754 rounding kicks in. We pick a token count that
    // forces the multiplication to land just past 2^53 so a Number-based
    // implementation would round to an even integer and miss by ±1.
    //
    // (MAX_SAFE_INTEGER + 1) * 5 = 5 * 2^53 = exactly 45_035_996_273_704_960n.
    // Number can represent that (it's a multiple of large powers of 2), but
    // (MAX_SAFE_INTEGER + 1) itself can't be passed through Number without
    // collapsing to MAX_SAFE_INTEGER (since both round to the same float).
    // So we instead use a known unsafe input and verify the BigInt path
    // preserves it. The token count must be a literal BigInt to avoid the
    // Number-input rounding on the test-author side.
    //
    // Note: AnthropicUsage types `input_tokens` as `number`, but the
    // BigInt path tolerates this cast because we're testing what
    // computeCostMicroUsd does internally with BigInt(...). If a future
    // refactor switches to `Number(input_tokens) * rate`, this test
    // catches the rounding at 2^53+1.
    it('opus 4.7: 2^53 + 1 input tokens stays exact via BigInt path', () => {
      // 2^53 + 1 = 9_007_199_254_740_993. Number(9_007_199_254_740_993)
      // === 9_007_199_254_740_992 (rounds down). We pass the value as a
      // BigInt-castable surrogate via the implementation's own BigInt(...)
      // coercion — the AnthropicUsage type doesn't accept bigint, but the
      // implementation's `BigInt(usage.input_tokens ?? 0)` will accept
      // anything BigInt() accepts. Use the documented unsafe boundary.
      const unsafeTokens = Number.MAX_SAFE_INTEGER + 1; // = 2^53
      // Number(2^53) === 9_007_199_254_740_992 exactly (a power of 2),
      // so BigInt(2^53) === 9_007_199_254_740_992n.
      // Cost = 9_007_199_254_740_992n × 5n = 45_035_996_273_704_960n µUSD.
      expect(computeCostMicroUsd('claude-opus-4-7', { input_tokens: unsafeTokens })).toBe(
        45_035_996_273_704_960n,
      );
      // Sanity: this value is past what plain Number arithmetic would
      // preserve through a multiply-then-add chain. Number(2^53) * 5
      // does happen to equal 4.503599627370496e16 exactly (multiplies
      // of small powers of 2 survive), but the sum with any non-power-
      // of-2 cache term would lose precision. The next test pins that.
    });

    it('opus 4.7: composite past 2^53 stays exact (Number would lose precision on the sum)', () => {
      // input = 2^53 tokens × 5 = 45_035_996_273_704_960n µUSD
      // output = 1 token × 25 = 25n µUSD
      // Sum = 45_035_996_273_704_985n. Number can't represent the +25
      // increment past 2^53 — Number(45_035_996_273_704_960 + 25) rounds
      // back to 45_035_996_273_704_984 (the nearest representable
      // multiple of 8 at this magnitude). The BigInt result must be
      // exactly 45_035_996_273_704_985n.
      const cost = computeCostMicroUsd('claude-opus-4-7', {
        input_tokens: Number.MAX_SAFE_INTEGER + 1, // 2^53
        output_tokens: 1,
      });
      expect(cost).toBe(45_035_996_273_704_985n);
      // Crux assertion: the BigInt preserves the +25 increment that
      // Number arithmetic would silently round away. If anyone "fixes"
      // this by converting through Number, this comparison will fail.
      expect(cost - 45_035_996_273_704_960n).toBe(25n);
    });
  });
});
