// Regression test for PR #34 feedback (50): "Dragging the connection
// waypoints (sometimes?) moves the canvas too."
//
// Root cause (reproduced in Chrome via CDP trusted input):
//   1. `pointerdown` lands on a midpoint-insert handle
//      (`[data-tocb-midpoint-handle]` circle). `useWaypointDrag.
//      startInsertGesture` runs: sets the canvas-gesture mutex, sets
//      dragState, and inserts the new waypoint — all synchronously
//      flushed by React before the event handler returns.
//   2. The flush UNMOUNTS the pressed midpoint circle (midpoint handles
//      are hidden while a drag is in flight — `dragInProgress` in
//      `ConnectionWaypointHandles`).
//   3. Chrome then dispatches the COMPATIBILITY `mousedown` for the same
//      press. Because the original target is detached, the event is
//      retargeted to the closest still-connected ancestor — the
//      `<g data-tocb-waypoint-handles=...>` group — NOT re-hit-tested.
//   4. `useZoomPan`'s document-level mousedown listener checks
//      `excludeFromPan(target)`, which matches `[data-tocb-waypoint-handle]`
//      / `[data-tocb-midpoint-handle]` but NOT the group's (plural)
//      `data-tocb-waypoint-handles` attribute → not excluded → pan
//      starts → waypoint drag and canvas pan track the same mouse.
//
// The robust fix is for `useZoomPan` to consult the shared canvas-
// gesture mutex (`_canvasGestureState`) in its mousedown handler:
// every canvas gesture (node drag PR 4, connection drag PR 5, waypoint
// drag PR 7) claims the mutex during `pointerdown`, which the browser
// ALWAYS dispatches before the compatibility `mousedown`. Target
// identity games (detached nodes, retargeting, re-renders) can't break
// that ordering.

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { useZoomPan } from '../../src/hooks/useZoomPan';
import {
  setCanvasGestureActive,
  _resetCanvasGestureStateForTest,
} from '../../src/hooks/_canvasGestureState';

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  document.body.innerHTML = '';
});

function renderZoomPan() {
  return renderHook(() => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    return useZoomPan({
      containerSize: { width: 800, height: 600 },
      containerRef,
      // No exclusions: we want the raw mousedown → pan path. The mutex
      // must gate the pan even when the exclusion attribute check
      // fails (which is exactly what happens when Chrome retargets the
      // compat mousedown to a detached element's ancestor).
      excludeFromPan: () => false,
    });
  });
}

function mousedownOnBody(): void {
  const e = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true });
  document.body.dispatchEvent(e);
}

function mouseup(): void {
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

describe('useZoomPan × canvas-gesture mutex (PR #34 feedback 50)', () => {
  it('baseline: mousedown while zoomed in starts a pan', () => {
    const { result } = renderZoomPan();

    // Zoom in past fit so panning is armed (handleMouseDown requires
    // z > fitZoom * 1.01).
    act(() => {
      result.current.zoomIn();
    });
    expect(result.current.isZoomedIn).toBe(true);

    act(() => {
      mousedownOnBody();
    });
    expect(result.current.isPanning).toBe(true);

    act(() => {
      mouseup();
    });
    expect(result.current.isPanning).toBe(false);
  });

  it('does NOT start a pan when a canvas gesture is already in flight', () => {
    const { result } = renderZoomPan();

    act(() => {
      result.current.zoomIn();
    });
    expect(result.current.isZoomedIn).toBe(true);

    // Simulate the real-world ordering: pointerdown on a waypoint /
    // midpoint handle claimed the gesture mutex...
    setCanvasGestureActive(true);

    // ...then the compatibility mousedown arrives (possibly retargeted
    // to an element the exclusion check does not match).
    act(() => {
      mousedownOnBody();
    });

    expect(result.current.isPanning).toBe(false);

    act(() => {
      mouseup();
    });
  });

  it('pans again once the gesture mutex is released', () => {
    const { result } = renderZoomPan();

    act(() => {
      result.current.zoomIn();
    });

    setCanvasGestureActive(true);
    act(() => {
      mousedownOnBody();
    });
    expect(result.current.isPanning).toBe(false);
    act(() => {
      mouseup();
    });

    // Gesture ends (pointerup → cleanup() → mutex released).
    setCanvasGestureActive(false);
    act(() => {
      mousedownOnBody();
    });
    expect(result.current.isPanning).toBe(true);
    act(() => {
      mouseup();
    });
  });
});
