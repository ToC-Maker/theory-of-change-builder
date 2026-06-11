// PR #34 feedback (51): "Ideally, connection strength has a variable
// dash size rather than hard stops."
//
// `getConfidenceStrokeStyle` previously bucketed confidence into three
// hard stops (solid / '8 6' / '2 6'). The continuous mapping:
//
//   - confidence ≥ 95  → solid stroke (no dasharray),
//   - below 95         → dash length GROWS and gap length SHRINKS
//                        smoothly as confidence rises, approaching a
//                        near-solid look just under the threshold and
//                        a sparse dotted look at 0,
//   - opacity rises continuously 0.8 → 1.0 with confidence.
//
// These tests pin the contract: solid at the top end, monotonicity of
// every channel, sensible extremes, clamping, and no large jumps
// (continuity) anywhere below the solid threshold.

import { describe, it, expect } from 'vitest';
import {
  computeConfidenceDash,
  getConfidenceStrokeStyle,
  CONFIDENCE_SOLID_THRESHOLD,
} from '../../src/utils';

describe('computeConfidenceDash (continuous dash mapping)', () => {
  it('returns null (solid) at and above the solid threshold', () => {
    expect(computeConfidenceDash(CONFIDENCE_SOLID_THRESHOLD)).toBeNull();
    expect(computeConfidenceDash(97)).toBeNull();
    expect(computeConfidenceDash(100)).toBeNull();
    expect(computeConfidenceDash(150)).toBeNull(); // clamped
  });

  it('returns dash/gap below the threshold', () => {
    const r = computeConfidenceDash(50);
    expect(r).not.toBeNull();
    expect(r!.dash).toBeGreaterThan(0);
    expect(r!.gap).toBeGreaterThan(0);
  });

  it('dash length is monotonically nondecreasing in confidence', () => {
    let prev = -Infinity;
    for (let c = 0; c < CONFIDENCE_SOLID_THRESHOLD; c++) {
      const { dash } = computeConfidenceDash(c)!;
      expect(dash).toBeGreaterThanOrEqual(prev);
      prev = dash;
    }
  });

  it('gap length is monotonically nonincreasing in confidence (longer gaps as confidence drops)', () => {
    let prev = Infinity;
    for (let c = 0; c < CONFIDENCE_SOLID_THRESHOLD; c++) {
      const { gap } = computeConfidenceDash(c)!;
      expect(gap).toBeLessThanOrEqual(prev);
      prev = gap;
    }
  });

  it('is continuous: no channel jumps by more than 0.3 between adjacent integers', () => {
    for (let c = 1; c < CONFIDENCE_SOLID_THRESHOLD; c++) {
      const a = computeConfidenceDash(c - 1)!;
      const b = computeConfidenceDash(c)!;
      expect(Math.abs(b.dash - a.dash)).toBeLessThanOrEqual(0.3);
      expect(Math.abs(b.gap - a.gap)).toBeLessThanOrEqual(0.3);
    }
  });

  it('extremes: dotted-ish at 0, near-solid just under the threshold', () => {
    const low = computeConfidenceDash(0)!;
    expect(low.dash).toBeLessThanOrEqual(3); // dot-sized
    expect(low.gap).toBeGreaterThanOrEqual(7); // sparse

    const high = computeConfidenceDash(CONFIDENCE_SOLID_THRESHOLD - 1)!;
    expect(high.dash).toBeGreaterThanOrEqual(12); // long dashes
    expect(high.gap).toBeLessThanOrEqual(2.5); // tiny gaps → reads near-solid
  });

  it('clamps negative confidence to 0', () => {
    expect(computeConfidenceDash(-25)).toEqual(computeConfidenceDash(0));
  });
});

describe('getConfidenceStrokeStyle (continuous)', () => {
  it('emits strokeDasharray "none" at the solid end', () => {
    expect(getConfidenceStrokeStyle(100).strokeDasharray).toBe('none');
    expect(getConfidenceStrokeStyle(95).strokeDasharray).toBe('none');
  });

  it('emits "<dash> <gap>" below the threshold, matching computeConfidenceDash', () => {
    for (const c of [0, 10, 33, 50, 66, 80, 94]) {
      const { dash, gap } = computeConfidenceDash(c)!;
      expect(getConfidenceStrokeStyle(c).strokeDasharray).toBe(`${dash} ${gap}`);
    }
  });

  it('opacity rises continuously from 0.8 (c=0) to 1.0 (c=100)', () => {
    expect(getConfidenceStrokeStyle(0).opacity).toBeCloseTo(0.8, 6);
    expect(getConfidenceStrokeStyle(100).opacity).toBeCloseTo(1.0, 6);
    let prev = -Infinity;
    for (let c = 0; c <= 100; c += 5) {
      const { opacity } = getConfidenceStrokeStyle(c);
      expect(opacity).toBeGreaterThanOrEqual(prev);
      prev = opacity;
    }
  });

  it('keeps the black stroke', () => {
    expect(getConfidenceStrokeStyle(40).stroke).toBe('#000000');
  });
});
