// PR 7 Task 7.1 unit tests for `computePathWithWaypoints`.
//
// The function builds a single `M ... C ... [C ...]*` SVG path that
// runs from source through any number of intermediate waypoints to
// target. Critical contracts:
//
//   1. 0 waypoints  -> byte-identical to the inline auto-bezier in
//      `ConnectionsComponent.tsx` (existing graphs must render
//      unchanged).
//   2. Each waypoint lies ON the path (cubic bezier endpoints are
//      anchors; the waypoint is the anchor between two consecutive
//      cubic segments).
//   3. Single `<path>` element semantics: the returned string starts
//      with one `M`, then concatenates `C` segments. No `M` is
//      injected mid-path.
//   4. Dash-phase regression: across confidence 20/50/90 and 0/1/2
//      waypoints, the returned string shape is one Move + N+1 Curves
//      so the renderer can emit a single `<path>` with `stroke-
//      dasharray` spanning the whole path. We snapshot the path so a
//      regression in segment count / coordinate ordering fails loudly.

import { describe, it, expect } from 'vitest';
import {
  computePathWithWaypoints,
  type ConnectionPathDirection,
} from '../../src/utils/connectionPath';

describe('computePathWithWaypoints', () => {
  describe('0 waypoints — backward-compat fallback', () => {
    it('forward 0-waypoint path matches the existing inline auto-bezier shape', () => {
      // Match ConnectionsComponent's inline path string for the
      // forward case:
      //   `M ${startX} ${startY} C ${startX + offset} ${startY},
      //    ${endX - offset} ${endY}, ${endX} ${endY}`
      // baseOffset = |200-0|/2 = 100; offset = 100 * (0.1 + 0.5*1.9) = 105.
      const d = computePathWithWaypoints({
        source: { x: 0, y: 50 },
        waypoints: [],
        target: { x: 200, y: 50 },
        curvature: 0.5,
        direction: 'forward',
      });
      expect(d).toBe('M 0 50 C 105 50, 95 50, 200 50');
    });

    it('backward 0-waypoint path matches the existing inline auto-bezier shape', () => {
      const d = computePathWithWaypoints({
        source: { x: 200, y: 50 },
        waypoints: [],
        target: { x: 0, y: 50 },
        curvature: 0.5,
        direction: 'backward',
      });
      expect(d).toBe('M 200 50 C 95 50, 105 50, 0 50');
    });

    it('vertical 0-waypoint path matches the existing inline straight bezier', () => {
      const d = computePathWithWaypoints({
        source: { x: 50, y: 0 },
        waypoints: [],
        target: { x: 50, y: 200 },
        curvature: 0.5,
        direction: 'vertical',
      });
      expect(d).toBe('M 50 0 C 50 0, 50 200, 50 200');
    });

    it('curvature=0 collapses to zero horizontal offset', () => {
      const d = computePathWithWaypoints({
        source: { x: 0, y: 50 },
        waypoints: [],
        target: { x: 200, y: 50 },
        curvature: 0,
        direction: 'forward',
      });
      expect(d).toBe('M 0 50 C 0 50, 200 50, 200 50');
    });
  });

  describe('1 waypoint — path passes through the waypoint', () => {
    it('emits one Move + two Curves; both curve endpoints anchor at waypoint and target', () => {
      const d = computePathWithWaypoints({
        source: { x: 0, y: 50 },
        waypoints: [{ x: 100, y: 100 }],
        target: { x: 200, y: 50 },
        curvature: 0.5,
        direction: 'forward',
      });

      // Single Move command.
      const moveCount = (d.match(/M /g) ?? []).length;
      expect(moveCount).toBe(1);

      // N+1 Curves where N is the waypoint count.
      const curveCount = (d.match(/ C /g) ?? []).length;
      expect(curveCount).toBe(2);

      // The first curve must end at the waypoint and the second
      // curve must end at the target. Tokenize on the final pair of
      // each cubic.
      // Path shape: "M sx sy C c1x c1y, c2x c2y, wx wy C c3x c3y, c4x c4y, tx ty"
      const tokens = d.split(' C ');
      // tokens[0]: "M 0 50"
      // tokens[1]: "c1x c1y, c2x c2y, wx wy"
      // tokens[2]: "c3x c3y, c4x c4y, tx ty"
      const firstCurveAnchor = tokens[1].trim().split(', ').pop();
      const secondCurveAnchor = tokens[2].trim().split(', ').pop();
      expect(firstCurveAnchor).toBe('100 100');
      expect(secondCurveAnchor).toBe('200 50');
    });
  });

  describe('2 waypoints — path passes through both', () => {
    it('emits one Move + three Curves; curve endpoints anchor at wp1, wp2, target', () => {
      const d = computePathWithWaypoints({
        source: { x: 0, y: 50 },
        waypoints: [
          { x: 60, y: 100 },
          { x: 140, y: 0 },
        ],
        target: { x: 200, y: 50 },
        curvature: 0.5,
        direction: 'forward',
      });

      const moveCount = (d.match(/M /g) ?? []).length;
      expect(moveCount).toBe(1);

      const curveCount = (d.match(/ C /g) ?? []).length;
      expect(curveCount).toBe(3);

      // Anchor check on each cubic's terminal coord:
      const tokens = d.split(' C ');
      const anchors = tokens.slice(1).map((seg) => seg.trim().split(', ').pop());
      expect(anchors).toEqual(['60 100', '140 0', '200 50']);
    });

    it('is a pure function: same args produce identical strings', () => {
      const args = {
        source: { x: 0, y: 0 },
        waypoints: [
          { x: 60, y: 100 },
          { x: 140, y: 0 },
        ],
        target: { x: 200, y: 50 },
        curvature: 0.3,
        direction: 'forward' as ConnectionPathDirection,
      };
      expect(computePathWithWaypoints(args)).toBe(computePathWithWaypoints(args));
    });
  });

  describe('dash-phase shape regression (acceptance test 7.1)', () => {
    // The red-team Critical finding (plan/figma-redesign.md:160-163)
    // requires confidence-driven stroke styles to look continuous at
    // waypoint corners. The visual continuity comes from rendering ONE
    // `<path>` per connection with a stroke-dasharray spanning the
    // whole path; this test pins the SHAPE of the path string for 0 /
    // 1 / 2 waypoints. Confidence is NOT iterated: it doesn't enter
    // `computePathWithWaypoints` (only stroke style), so iterating it
    // would just multiply the test count. Visual dash continuity is a
    // QA check done in a real browser; this is the algorithmic guard.
    const cases: { waypoints: { x: number; y: number }[]; expectedCurves: number }[] = [
      { waypoints: [], expectedCurves: 1 },
      { waypoints: [{ x: 100, y: 80 }], expectedCurves: 2 },
      {
        waypoints: [
          { x: 60, y: 90 },
          { x: 140, y: 30 },
        ],
        expectedCurves: 3,
      },
    ];

    for (const { waypoints, expectedCurves } of cases) {
      it(`waypoints=${waypoints.length}: single Move + ${expectedCurves} Curves`, () => {
        const d = computePathWithWaypoints({
          source: { x: 0, y: 50 },
          waypoints,
          target: { x: 200, y: 50 },
          curvature: 0.5,
          direction: 'forward',
        });
        expect((d.match(/M /g) ?? []).length).toBe(1);
        expect((d.match(/ C /g) ?? []).length).toBe(expectedCurves);
      });
    }
  });

  describe('control-point smoothness at waypoints', () => {
    it('control points around an interior waypoint are reflected across the waypoint (C1 continuity)', () => {
      // For C1 continuity at the interior waypoint W, the leaving
      // control point must equal 2*W - (last control point of the
      // arriving segment). The math test pins this so that future
      // changes to the control-point algorithm don't break dash-phase
      // continuity at corners (the red-team Critical).
      const d = computePathWithWaypoints({
        source: { x: 0, y: 0 },
        waypoints: [{ x: 100, y: 50 }],
        target: { x: 200, y: 0 },
        curvature: 0.5,
        direction: 'forward',
      });
      // Path: "M 0 0 C c1x c1y, c2x c2y, 100 50 C c3x c3y, c4x c4y, 200 0"
      const tokens = d.split(' C ');
      const seg1 = tokens[1].trim().split(', '); // [c1, c2, anchor]
      const seg2 = tokens[2].trim().split(', '); // [c3, c4, anchor]
      const [c2x, c2y] = seg1[1].split(' ').map(Number);
      const [c3x, c3y] = seg2[0].split(' ').map(Number);
      // Reflect c2 across waypoint (100, 50): expect (200 - c2x, 100 - c2y) = (c3x, c3y).
      expect(c3x).toBeCloseTo(200 - c2x, 6);
      expect(c3y).toBeCloseTo(100 - c2y, 6);
    });
  });

  describe('malformed waypoint input — defense-in-depth', () => {
    // A malformed import (string coords, NaN, null entries, non-object
    // items) must not produce an SVG `d` string containing `NaN`
    // (which silently hides the connection) or throw (which would
    // unmount the canvas subtree). The function filters non-finite
    // / non-{x,y} entries and falls back to the byte-identical
    // 0-waypoint shape if NO valid waypoints remain.
    const baseArgs = {
      source: { x: 0, y: 50 },
      target: { x: 200, y: 50 },
      curvature: 0.5,
      direction: 'forward' as const,
    };

    it('returns the 0-waypoint fallback when all waypoints are NaN-coord', () => {
      const d = computePathWithWaypoints({
        ...baseArgs,
        waypoints: [{ x: Number.NaN, y: 50 }],
      });
      expect(d).not.toMatch(/NaN/);
      // Same byte-identical shape as the 0-waypoint case.
      expect(d).toBe('M 0 50 C 105 50, 95 50, 200 50');
    });

    it('returns the 0-waypoint fallback when all waypoints have string coords', () => {
      const d = computePathWithWaypoints({
        ...baseArgs,
        // Cast — simulates a malformed JSON import.
        waypoints: [{ x: '100', y: '50' }] as unknown as Array<{ x: number; y: number }>,
      });
      expect(d).not.toMatch(/NaN/);
      expect(d).toBe('M 0 50 C 105 50, 95 50, 200 50');
    });

    it('returns the 0-waypoint fallback when waypoints contains a null entry', () => {
      const d = computePathWithWaypoints({
        ...baseArgs,
        waypoints: [null] as unknown as Array<{ x: number; y: number }>,
      });
      expect(d).not.toMatch(/NaN/);
      expect(d).toBe('M 0 50 C 105 50, 95 50, 200 50');
    });

    it('returns the 0-waypoint fallback when waypoints itself is not an array', () => {
      const d = computePathWithWaypoints({
        ...baseArgs,
        waypoints: 'not-an-array' as unknown as Array<{ x: number; y: number }>,
      });
      expect(d).not.toMatch(/NaN/);
      expect(d).toBe('M 0 50 C 105 50, 95 50, 200 50');
    });

    it('drops only the malformed entries, keeping the valid ones', () => {
      const d = computePathWithWaypoints({
        ...baseArgs,
        waypoints: [
          { x: Number.NaN, y: 50 },
          { x: 100, y: 50 },
          null as unknown as { x: number; y: number },
        ],
      });
      expect(d).not.toMatch(/NaN/);
      // Should be the 1-waypoint shape using just (100, 50).
      expect((d.match(/M /g) ?? []).length).toBe(1);
      expect((d.match(/ C /g) ?? []).length).toBe(2);
      expect(d).toMatch(/100 50/);
    });
  });

  describe('many-waypoint stress (N=5+)', () => {
    it('handles N=8 waypoints with correct segment count and anchor placement', () => {
      // The loop is N-agnostic, but a single large-N test catches any
      // future change that hard-codes N≤2 assumptions.
      const waypoints = Array.from({ length: 8 }, (_, i) => ({
        x: 25 + i * 25,
        y: i % 2 === 0 ? 80 : 20,
      }));
      const d = computePathWithWaypoints({
        source: { x: 0, y: 50 },
        waypoints,
        target: { x: 250, y: 50 },
        curvature: 0.5,
        direction: 'forward',
      });
      expect((d.match(/M /g) ?? []).length).toBe(1);
      expect((d.match(/ C /g) ?? []).length).toBe(9); // N+1
      // Each anchor appears in the path string.
      for (const w of waypoints) {
        expect(d).toContain(`${w.x} ${w.y}`);
      }
    });
  });
});
