// PR 7 Task 7.3 tests for `ConnectionWaypointHandles`.
//
// Verifies:
//   - `visible=false` → renders nothing.
//   - 0 waypoints → 1 midpoint handle, 0 waypoint handles.
//   - 1 waypoint  → 2 midpoint handles, 1 waypoint handle.
//   - 2 waypoints → 3 midpoint handles, 2 waypoint handles.
//   - Midpoint handle pointerdown binds via `bindMidpoint(s, t, segIdx)`.
//   - Waypoint handle pointerdown binds via `bindWaypoint(s, t, wpIdx)`.
//   - Click on either kind stops propagation (so it doesn't trigger the
//     edge's `onClick` underneath).
//
// PR 7 feedback (A): midpoint positioning moved from chord-midpoint
// (computed inside the component) to caller-supplied `segmentMidpoints`
// (computed by `computeSegmentMidpoints` to land on the rendered
// bezier). The test now passes one midpoint coord per segment via that
// prop; the component just renders what it's given.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ConnectionWaypointHandles } from '../../src/components/canvas/ConnectionWaypointHandles';

afterEach(() => {
  cleanup();
});

function makeBind(spy: ReturnType<typeof vi.fn>) {
  return (s: string, t: string, idx: number) => ({
    onPointerDown: (e: React.PointerEvent) => spy(s, t, idx, e),
  });
}

/**
 * Build a `segmentMidpoints` array of correct length for `anchors`.
 * The values are placeholder chord midpoints — handle counts and
 * positions only care that one midpoint is supplied per segment.
 */
function chordMidpoints(anchors: Array<{ x: number; y: number }>) {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    out.push({
      x: (anchors[i].x + anchors[i + 1].x) / 2,
      y: (anchors[i].y + anchors[i + 1].y) / 2,
    });
  }
  return out;
}

// Render the handles inside a wrapping <svg> so jsdom mounts the SVG
// circles without type errors.
function renderHandles(props: Parameters<typeof ConnectionWaypointHandles>[0]) {
  return render(
    <svg width={500} height={500}>
      <ConnectionWaypointHandles {...props} />
    </svg>,
  );
}

describe('ConnectionWaypointHandles', () => {
  describe('visibility', () => {
    it('renders nothing when visible=false', () => {
      const anchors = [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ];
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors,
        segmentMidpoints: chordMidpoints(anchors),
        waypointCount: 0,
        visible: false,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(vi.fn()),
      });
      // No `<g>` group rendered.
      expect(container.querySelector('[data-tocb-waypoint-handles]')).toBeNull();
    });

    it('renders nothing when anchors has fewer than 2 points', () => {
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors: [{ x: 0, y: 0 }],
        segmentMidpoints: [],
        waypointCount: 0,
        visible: true,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(vi.fn()),
      });
      expect(container.querySelector('[data-tocb-waypoint-handles]')).toBeNull();
    });
  });

  describe('handle counts', () => {
    it('0 waypoints → 1 midpoint, 0 waypoint handles', () => {
      const anchors = [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ];
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors,
        segmentMidpoints: chordMidpoints(anchors),
        waypointCount: 0,
        visible: true,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(vi.fn()),
      });
      expect(container.querySelectorAll('[data-tocb-midpoint-handle]').length).toBe(1);
      expect(container.querySelectorAll('[data-tocb-waypoint-handle]').length).toBe(0);
    });

    it('1 waypoint → 2 midpoint, 1 waypoint handle', () => {
      const anchors = [
        { x: 0, y: 0 },
        { x: 50, y: 50 }, // wp[0]
        { x: 100, y: 100 },
      ];
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors,
        segmentMidpoints: chordMidpoints(anchors),
        waypointCount: 1,
        visible: true,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(vi.fn()),
      });
      expect(container.querySelectorAll('[data-tocb-midpoint-handle]').length).toBe(2);
      expect(container.querySelectorAll('[data-tocb-waypoint-handle]').length).toBe(1);
    });

    it('2 waypoints → 3 midpoint, 2 waypoint handles', () => {
      const anchors = [
        { x: 0, y: 0 },
        { x: 33, y: 33 }, // wp[0]
        { x: 66, y: 66 }, // wp[1]
        { x: 100, y: 100 },
      ];
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors,
        segmentMidpoints: chordMidpoints(anchors),
        waypointCount: 2,
        visible: true,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(vi.fn()),
      });
      expect(container.querySelectorAll('[data-tocb-midpoint-handle]').length).toBe(3);
      expect(container.querySelectorAll('[data-tocb-waypoint-handle]').length).toBe(2);
    });
  });

  describe('handle positions', () => {
    it('midpoint handle renders at the caller-supplied segmentMidpoint coords', () => {
      // The component is now a pure renderer for `segmentMidpoints`;
      // the on-curve B(0.5) math lives in `computeSegmentMidpoints`
      // (see `tests/frontend/connectionPath.waypoints.test.ts`).
      const anchors = [
        { x: 0, y: 0 },
        { x: 200, y: 100 },
      ];
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors,
        segmentMidpoints: [{ x: 123, y: 45 }], // arbitrary — should round-trip to DOM
        waypointCount: 0,
        visible: true,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(vi.fn()),
      });
      const mid = container.querySelector('[data-tocb-midpoint-handle]');
      expect(mid?.getAttribute('cx')).toBe('123');
      expect(mid?.getAttribute('cy')).toBe('45');
    });

    it('waypoint handle sits at its waypoint coords', () => {
      const anchors = [
        { x: 0, y: 0 },
        { x: 50, y: 200 },
        { x: 100, y: 0 },
      ];
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors,
        segmentMidpoints: chordMidpoints(anchors),
        waypointCount: 1,
        visible: true,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(vi.fn()),
      });
      const wp = container.querySelector('[data-tocb-waypoint-handle]');
      expect(wp?.getAttribute('cx')).toBe('50');
      expect(wp?.getAttribute('cy')).toBe('200');
    });
  });

  describe('binding correctness', () => {
    it('midpoint pointerdown calls bindMidpoint with correct segmentIndex', () => {
      const midSpy = vi.fn();
      const anchors = [
        { x: 0, y: 0 },
        { x: 50, y: 50 },
        { x: 100, y: 100 },
      ];
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors,
        segmentMidpoints: chordMidpoints(anchors),
        waypointCount: 1,
        visible: true,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(midSpy),
      });
      const midpoints = container.querySelectorAll('[data-tocb-midpoint-handle]');
      fireEvent.pointerDown(midpoints[0]);
      expect(midSpy).toHaveBeenCalledWith('s', 't', 0, expect.anything());
      fireEvent.pointerDown(midpoints[1]);
      expect(midSpy).toHaveBeenCalledWith('s', 't', 1, expect.anything());
    });

    it('waypoint pointerdown calls bindWaypoint with correct index', () => {
      const wpSpy = vi.fn();
      const anchors = [
        { x: 0, y: 0 },
        { x: 33, y: 33 },
        { x: 66, y: 66 },
        { x: 100, y: 100 },
      ];
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors,
        segmentMidpoints: chordMidpoints(anchors),
        waypointCount: 2,
        visible: true,
        bindWaypoint: makeBind(wpSpy),
        bindMidpoint: makeBind(vi.fn()),
      });
      const waypoints = container.querySelectorAll('[data-tocb-waypoint-handle]');
      fireEvent.pointerDown(waypoints[0]);
      expect(wpSpy).toHaveBeenCalledWith('s', 't', 0, expect.anything());
      fireEvent.pointerDown(waypoints[1]);
      expect(wpSpy).toHaveBeenCalledWith('s', 't', 1, expect.anything());
    });
  });
});
