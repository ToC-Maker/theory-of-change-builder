// Tests for `ConnectionWaypointHandles` — single-waypoint model
// (PR #34 feedback 53).
//
// Verifies:
//   - `visible=false` → renders nothing.
//   - 0 waypoints → exactly 1 midpoint affordance (the "bend me" entry
//     point), 0 waypoint handles.
//   - 1 waypoint  → 0 midpoint affordances (no recursive splitting),
//     1 waypoint handle.
//   - N waypoints (legacy chart) → 0 midpoint affordances, N waypoint
//     handles (legacy waypoints stay visible/draggable; dragging any
//     one collapses to the single-waypoint model — hook-level test).
//   - `dragInProgress` hides the midpoint affordance.
//   - Midpoint pointerdown binds via `bindMidpoint(s, t, 0)`.
//   - Waypoint pointerdown binds via `bindWaypoint(s, t, wpIdx)`.
//   - Waypoint double-click calls the bound onDoubleClick (reset).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ConnectionWaypointHandles } from '../../src/components/canvas/ConnectionWaypointHandles';

afterEach(() => {
  cleanup();
});

function makeBind(spy: ReturnType<typeof vi.fn>, dblSpy?: ReturnType<typeof vi.fn>) {
  return (s: string, t: string, idx: number) => ({
    onPointerDown: (e: React.PointerEvent) => spy(s, t, idx, e),
    onDoubleClick: (e: React.MouseEvent) => dblSpy?.(s, t, idx, e),
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

  describe('handle counts (single-waypoint model)', () => {
    it('0 waypoints → exactly 1 midpoint affordance, 0 waypoint handles', () => {
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

    it('1 waypoint → 0 midpoint affordances (no recursive splitting), 1 waypoint handle', () => {
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
      expect(container.querySelectorAll('[data-tocb-midpoint-handle]').length).toBe(0);
      expect(container.querySelectorAll('[data-tocb-waypoint-handle]').length).toBe(1);
    });

    it('legacy 2-waypoint chart → 0 midpoint affordances, 2 waypoint handles', () => {
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
      expect(container.querySelectorAll('[data-tocb-midpoint-handle]').length).toBe(0);
      expect(container.querySelectorAll('[data-tocb-waypoint-handle]').length).toBe(2);
    });

    it('dragInProgress hides the midpoint affordance', () => {
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
        dragInProgress: true,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(vi.fn()),
      });
      expect(container.querySelectorAll('[data-tocb-midpoint-handle]').length).toBe(0);
    });
  });

  describe('handle positions', () => {
    it('midpoint affordance renders at the caller-supplied segmentMidpoint coords', () => {
      // The component is a pure renderer for `segmentMidpoints[0]`;
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
    it('midpoint pointerdown binds segment 0', () => {
      const midSpy = vi.fn();
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
        bindMidpoint: makeBind(midSpy),
      });
      const midpoints = container.querySelectorAll('[data-tocb-midpoint-handle]');
      fireEvent.pointerDown(midpoints[0]);
      expect(midSpy).toHaveBeenCalledWith('s', 't', 0, expect.anything());
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

    it('waypoint double-click calls the bound onDoubleClick (reset affordance)', () => {
      const dblSpy = vi.fn();
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
        bindWaypoint: makeBind(vi.fn(), dblSpy),
        bindMidpoint: makeBind(vi.fn()),
      });
      const wp = container.querySelector('[data-tocb-waypoint-handle]')!;
      fireEvent.doubleClick(wp);
      expect(dblSpy).toHaveBeenCalledWith('s', 't', 0, expect.anything());
    });
  });
});
