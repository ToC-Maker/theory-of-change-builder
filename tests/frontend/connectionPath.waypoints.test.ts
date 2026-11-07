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
  computeSegmentMidpoints,
  type ConnectionPathDirection,
} from '../../src/utils/connectionPath';

interface Point {
  x: number;
  y: number;
}

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

  describe('single waypoint — issue 52 geometry (horizontal ends, chord-aligned at W)', () => {
    // PR #34 feedback (52): "the arrow head isn't horizontal, which it
    // should be, but also the path isn't smooth/elegant enough."
    // Contract for the single-waypoint path (the only kind the UI can
    // produce after feedback 53):
    //   - The path LEAVES the source along the flow axis (horizontal
    //     for forward/backward, vertical for same-column).
    //   - The path ENTERS the target along the flow axis — the
    //     arrowhead (marker orient=auto) renders horizontal for
    //     forward/backward connections.
    //   - The tangent AT the waypoint is chord-aligned (parallel to
    //     target - source) and C1-continuous (equal-magnitude
    //     reflection), so the curve flows through the waypoint without
    //     a kink and dash patterns stay smooth.
    const S = { x: 0, y: 100 };
    const T = { x: 400, y: 100 };

    /** Parse `M sx sy C c1, c2, a C c3, c4, b` into numeric points. */
    function parse(d: string) {
      const tokens = d.split(' C ');
      const num = (s: string) => s.trim().split(' ').map(Number);
      const seg1 = tokens[1].split(', ');
      const seg2 = tokens[2].split(', ');
      const [c1x, c1y] = num(seg1[0]);
      const [c2x, c2y] = num(seg1[1]);
      const [wx, wy] = num(seg1[2]);
      const [c3x, c3y] = num(seg2[0]);
      const [c4x, c4y] = num(seg2[1]);
      const [tx, ty] = num(seg2[2]);
      return {
        c1: { x: c1x, y: c1y },
        c2: { x: c2x, y: c2y },
        w: { x: wx, y: wy },
        c3: { x: c3x, y: c3y },
        c4: { x: c4x, y: c4y },
        t: { x: tx, y: ty },
      };
    }

    const waypointPositions = [
      { name: 'mid above', w: { x: 200, y: 20 } },
      { name: 'mid below', w: { x: 200, y: 190 } },
      { name: 'near source high', w: { x: 60, y: 10 } },
      { name: 'near target low', w: { x: 360, y: 200 } },
      { name: 'directly above source', w: { x: 2, y: 0 } },
      { name: 'directly above target', w: { x: 398, y: 0 } },
    ];

    for (const { name, w } of waypointPositions) {
      it(`forward, W ${name}: horizontal departure, horizontal arrival, chord-aligned C1 at W`, () => {
        const d = computePathWithWaypoints({
          source: S,
          target: T,
          waypoints: [w],
          curvature: 0.5,
          direction: 'forward',
        });
        const p = parse(d);

        // Horizontal departure: first control shares the source's y and
        // sits to the RIGHT of it (forward sense).
        expect(p.c1.y).toBeCloseTo(S.y, 6);
        expect(p.c1.x).toBeGreaterThan(S.x);

        // Horizontal arrival: last control shares the target's y and
        // sits to the LEFT of it → end tangent points +x → the
        // arrowhead renders horizontal.
        expect(p.c4.y).toBeCloseTo(T.y, 6);
        expect(p.c4.x).toBeLessThan(T.x);

        // Chord-aligned tangent at W: both controls around the
        // waypoint lie on the line through W parallel to (T - S).
        // Cross-product of (W - c2) with the chord must vanish.
        const chord = { x: T.x - S.x, y: T.y - S.y };
        const inArm = { x: p.w.x - p.c2.x, y: p.w.y - p.c2.y };
        const outArm = { x: p.c3.x - p.w.x, y: p.c3.y - p.w.y };
        expect(inArm.x * chord.y - inArm.y * chord.x).toBeCloseTo(0, 6);
        expect(outArm.x * chord.y - outArm.y * chord.x).toBeCloseTo(0, 6);

        // C1: outgoing control is the reflection of the incoming one.
        expect(p.c3.x).toBeCloseTo(2 * p.w.x - p.c2.x, 6);
        expect(p.c3.y).toBeCloseTo(2 * p.w.y - p.c2.y, 6);
      });
    }

    it('backward: horizontal departure to the LEFT, horizontal arrival from the RIGHT', () => {
      // Backward connection: source's anchor is its left edge, target's
      // anchor is its right edge — the arrow points -x into the target.
      const bS = { x: 400, y: 100 };
      const bT = { x: 0, y: 100 };
      const d = computePathWithWaypoints({
        source: bS,
        target: bT,
        waypoints: [{ x: 200, y: 220 }],
        curvature: 0.5,
        direction: 'backward',
      });
      const p = parse(d);
      expect(p.c1.y).toBeCloseTo(bS.y, 6);
      expect(p.c1.x).toBeLessThan(bS.x); // leaves leftward
      expect(p.c4.y).toBeCloseTo(bT.y, 6);
      expect(p.c4.x).toBeGreaterThan(bT.x); // arrives pointing leftward
    });

    it('vertical (same-column): vertical departure and arrival', () => {
      const vS = { x: 100, y: 0 };
      const vT = { x: 100, y: 300 };
      const d = computePathWithWaypoints({
        source: vS,
        target: vT,
        waypoints: [{ x: 180, y: 150 }],
        curvature: 0.5,
        direction: 'vertical',
      });
      const p = parse(d);
      // Departure straight down (target below source).
      expect(p.c1.x).toBeCloseTo(vS.x, 6);
      expect(p.c1.y).toBeGreaterThan(vS.y);
      // Arrival straight down into the target.
      expect(p.c4.x).toBeCloseTo(vT.x, 6);
      expect(p.c4.y).toBeLessThan(vT.y);
    });

    it('curvature=0 collapses to the straight polyline through W', () => {
      const w = { x: 150, y: 30 };
      const d = computePathWithWaypoints({
        source: S,
        target: T,
        waypoints: [w],
        curvature: 0,
        direction: 'forward',
      });
      const p = parse(d);
      expect(p.c1).toEqual(S);
      expect(p.c2).toEqual(w);
      expect(p.c3).toEqual(w);
      expect(p.c4).toEqual(T);
    });

    it('computeSegmentMidpoints stays on the rendered curve (shared control math)', () => {
      const w = { x: 250, y: 10 };
      const args = {
        source: S,
        target: T,
        waypoints: [w],
        curvature: 0.5,
        direction: 'forward' as ConnectionPathDirection,
      };
      const p = parse(computePathWithWaypoints(args));
      const mids = computeSegmentMidpoints(args);
      expect(mids).toHaveLength(2);
      // Manual B(0.5) of segment 1 from the path string's controls.
      const b05 = (p0: Point, p1: Point, p2: Point, p3: Point) => ({
        x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
        y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
      });
      const m1 = b05(S, p.c1, p.c2, p.w);
      const m2 = b05(p.w, p.c3, p.c4, p.t);
      expect(mids[0].x).toBeCloseTo(m1.x, 6);
      expect(mids[0].y).toBeCloseTo(m1.y, 6);
      expect(mids[1].x).toBeCloseTo(m2.x, 6);
      expect(mids[1].y).toBeCloseTo(m2.y, 6);
    });
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
