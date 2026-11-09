// PR #34 feedback (51): "Ideally, connection strength has a variable
// dash size rather than hard stops."
// PR #34 round-7 feedback (79): "Why is there a hard change between
// 95+ and 94 [...] it looks too visually different between 94 and 100."
//
// `getConfidenceStrokeStyle` previously bucketed confidence into three
// hard stops (solid / '8 6' / '2 6'); feedback 51 made the mapping
// continuous but LINEAR (dash 2→14, gap 8→2), which still left ~13%
// of the stroke as gaps just under the solid threshold — a visible
// cliff at 94↔95. Feedback 79 makes the approach to solid asymptotic:
//
//   - confidence ≥ 95  → solid stroke (no dasharray),
//   - below 95         → dash length grows CUBICALLY (2px → ~46.6px at
//                        94) while gap shrinks linearly (8px → ~1.6px),
//                        so just under the threshold the stroke is
//                        ~97% ink and the 95 boundary is imperceptible,
//                        while the low end keeps sparse dots and the
//                        middle still clearly reads dashed,
//   - opacity rises continuously 0.8 → 1.0 with confidence.
//
// These tests pin the contract: solid at the top end, monotonicity of
// every channel, sensible extremes, clamping, bounded steps between
// adjacent integers, near-solid ink coverage just under the threshold,
// and a clearly weak low end.

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

  it('is continuous: bounded steps between adjacent integers (no bucket cliffs)', () => {
    // fb7 (79): the dash bound is deliberately looser than the old 0.3 —
    // the cubic ramp grows ~1.4px/point near the threshold, which is
    // invisible there (gaps are hairline) but must stay bounded so a
    // future edit can't reintroduce a bucket-style jump. The gap channel
    // stays linear and tight.
    for (let c = 1; c < CONFIDENCE_SOLID_THRESHOLD; c++) {
      const a = computeConfidenceDash(c - 1)!;
      const b = computeConfidenceDash(c)!;
      expect(Math.abs(b.dash - a.dash)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(b.gap - a.gap)).toBeLessThanOrEqual(0.3);
    }
  });

  it('extremes: dotted-ish at 0, near-solid just under the threshold', () => {
    const low = computeConfidenceDash(0)!;
    expect(low.dash).toBeLessThanOrEqual(3); // dot-sized
    expect(low.gap).toBeGreaterThanOrEqual(7); // sparse

    const high = computeConfidenceDash(CONFIDENCE_SOLID_THRESHOLD - 1)!;
    expect(high.dash).toBeGreaterThanOrEqual(40); // very long dashes
    expect(high.gap).toBeLessThanOrEqual(1.8); // hairline gaps → reads near-solid
  });

  it('approach to solid is asymptotic: ≥96% ink coverage just under the threshold (fb7 issue 79)', () => {
    // Ink coverage = dash / (dash + gap). The 94↔95 boundary is only
    // imperceptible if a 94-confidence stroke is almost entirely ink.
    const { dash, gap } = computeConfidenceDash(CONFIDENCE_SOLID_THRESHOLD - 1)!;
    expect(dash / (dash + gap)).toBeGreaterThanOrEqual(0.96);
  });

  it('low end still clearly reads weak: short dots, wide gaps for 5–20 (fb7 issue 79)', () => {
    for (const c of [5, 10, 20]) {
      const { dash, gap } = computeConfidenceDash(c)!;
      expect(dash, `dash at ${c}`).toBeLessThanOrEqual(3);
      expect(gap, `gap at ${c}`).toBeGreaterThanOrEqual(6.5);
    }
  });

  it('mid-range still clearly reads dashed, not near-solid (fb7 issue 79)', () => {
    const { dash, gap } = computeConfidenceDash(50)!;
    expect(dash).toBeLessThanOrEqual(12);
    expect(gap).toBeGreaterThanOrEqual(4);
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
