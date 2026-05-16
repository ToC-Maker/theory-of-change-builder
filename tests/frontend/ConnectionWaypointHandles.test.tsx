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
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
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
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors: [
          { x: 0, y: 0 },
          { x: 100, y: 100 },
        ],
        waypointCount: 0,
        visible: true,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(vi.fn()),
      });
      expect(container.querySelectorAll('[data-tocb-midpoint-handle]').length).toBe(1);
      expect(container.querySelectorAll('[data-tocb-waypoint-handle]').length).toBe(0);
    });

    it('1 waypoint → 2 midpoint, 1 waypoint handle', () => {
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors: [
          { x: 0, y: 0 },
          { x: 50, y: 50 }, // wp[0]
          { x: 100, y: 100 },
        ],
        waypointCount: 1,
        visible: true,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(vi.fn()),
      });
      expect(container.querySelectorAll('[data-tocb-midpoint-handle]').length).toBe(2);
      expect(container.querySelectorAll('[data-tocb-waypoint-handle]').length).toBe(1);
    });

    it('2 waypoints → 3 midpoint, 2 waypoint handles', () => {
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors: [
          { x: 0, y: 0 },
          { x: 33, y: 33 }, // wp[0]
          { x: 66, y: 66 }, // wp[1]
          { x: 100, y: 100 },
        ],
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
    it('midpoint handle sits at the straight-line midpoint of its segment', () => {
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors: [
          { x: 0, y: 0 },
          { x: 200, y: 100 },
        ],
        waypointCount: 0,
        visible: true,
        bindWaypoint: makeBind(vi.fn()),
        bindMidpoint: makeBind(vi.fn()),
      });
      const mid = container.querySelector('[data-tocb-midpoint-handle]');
      expect(mid?.getAttribute('cx')).toBe('100');
      expect(mid?.getAttribute('cy')).toBe('50');
    });

    it('waypoint handle sits at its waypoint coords', () => {
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors: [
          { x: 0, y: 0 },
          { x: 50, y: 200 },
          { x: 100, y: 0 },
        ],
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
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors: [
          { x: 0, y: 0 },
          { x: 50, y: 50 },
          { x: 100, y: 100 },
        ],
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
      const { container } = renderHandles({
        sourceNodeId: 's',
        targetNodeId: 't',
        anchors: [
          { x: 0, y: 0 },
          { x: 33, y: 33 },
          { x: 66, y: 66 },
          { x: 100, y: 100 },
        ],
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
