import { describe, expect, it } from 'vitest';
import { microToUsd } from '../../shared/pricing';

describe('microToUsd', () => {
  it('1_000_000n → 1.0 (exact dollar)', () => {
    expect(microToUsd(1_000_000n)).toBe(1.0);
  });

  it('5_500_000n → 5.5 (sub-µUSD remainder split correctly)', () => {
    expect(microToUsd(5_500_000n)).toBe(5.5);
  });

  it('0n → 0', () => {
    expect(microToUsd(0n)).toBe(0);
  });

  // Contract: null / undefined collapse to 0. Used by /api/usage where a
  // missing user row reads as "no spend yet"; the caller doesn't need a
  // separate branch.
  it('null → 0 (collapses-to-zero contract)', () => {
    expect(microToUsd(null)).toBe(0);
  });

  it('undefined → 0 (collapses-to-zero contract)', () => {
    expect(microToUsd(undefined)).toBe(0);
  });

  // number input (small) survives the bigint conversion. Postgres BIGINT
  // columns can deserialize as `number` for small values depending on
  // driver version; microToUsd accepts both.
  it('accepts number input for small values', () => {
    expect(microToUsd(2_500_000)).toBe(2.5);
    expect(microToUsd(0)).toBe(0);
  });

  // Precision boundary: this is the whole reason for the split-arithmetic
  // design. At 10^16 µUSD = $10 billion + 1 µUSD, the input bigint exceeds
  // Number.MAX_SAFE_INTEGER (2^53 - 1 ≈ 9.007×10^15). A naive
  // `Number(big) / 1_000_000` would coerce 10_000_000_000_000_001n to
  // Number first, losing the trailing 1 µUSD (rounds down to
  // 10_000_000_000_000_000), and then divide — silently producing 10^10
  // exactly and dropping the µUSD precision.
  //
  // The split path:
  //   whole = big / 1_000_000n = 10_000_000_000n  (fits in Number exactly)
  //   frac  = Number(big % 1_000_000n) / 1_000_000 = 1 / 1_000_000
  //   result = 10_000_000_000 + 0.000001 = 10_000_000_000.000002 (float)
  //
  // The +0.000002 is the closest representable float to the exact answer
  // 10_000_000_000.000001 (IEEE 754 gap at 10^10 is ~2.4×10^-7 so .000001
  // and .000002 round to the same double). Crucially, the result is NOT
  // exactly 10^10 — i.e. the µUSD remainder survived the conversion.
  it('preserves sub-µUSD precision past Number.MAX_SAFE_INTEGER (split-arithmetic contract)', () => {
    const big = 10_000_000_000_000_001n; // 10^16 + 1 µUSD = $10B + 1 µUSD
    const result = microToUsd(big);

    // Result must differ from the whole-dollar floor: the trailing µUSD
    // is preserved as a fractional float. A naive
    // `Number(big) / 1_000_000` regression would round to 10^10 exactly
    // and this assertion would fail.
    expect(result).not.toBe(10_000_000_000);

    // Result is just above $10B. The exact answer 10_000_000_000.000001
    // isn't representable as Number (gap ~2.4×10^-7 at this magnitude)
    // but the split path lands on the nearest representable float, which
    // is strictly greater than 10^10.
    expect(result).toBeGreaterThan(10_000_000_000);
    expect(result).toBeLessThan(10_000_000_001);
  });

  // BigInt(MAX_SAFE_INTEGER) * 2n = 2^54 - 2 = 18_014_398_509_481_982n.
  // This is just past 2^53 but at this scale the µUSD precision (1 part
  // in 10^16) is below the float gap (~4 at 2^54), so the split and
  // naive paths happen to land on the same float. The test below pins
  // the split path's behavior — it asserts the value reconstructs to
  // ~$18B with the expected whole-dollar component intact.
  it('reconstructs MAX_SAFE_INTEGER * 2 to expected whole-dollar component', () => {
    const big = BigInt(Number.MAX_SAFE_INTEGER) * 2n; // 18_014_398_509_481_982n
    const result = microToUsd(big);

    // Whole-dollar part: 18_014_398_509_481_982 / 1_000_000 = 18_014_398_509
    // (well within Number.MAX_SAFE_INTEGER), so the split path returns
    // 18_014_398_509 + frac. Verify the integer part survives.
    expect(Math.floor(result)).toBe(18_014_398_509);
    // Sanity bound: fractional part is < 1.
    expect(result - Math.floor(result)).toBeLessThan(1);
    expect(result - Math.floor(result)).toBeGreaterThanOrEqual(0);
  });
});
