// Shared canvas-gesture coordination — one module-scope boolean ref.
//
// Mutual-exclusion primitive shared by the three drag hooks. Each checks
// the flag on `pointerdown`, short-circuits if another canvas gesture is
// in flight, and holds the flag itself for the length of its own gesture:
//
//   `usePointerDrag`     (node drag)
//   `useConnectionDrag`  (connection handles)
//   `useWaypointDrag`    (path waypoints)
//
// `useZoomPan` only reads it, so a canvas pan never starts under a drag.
//
// Why module-scope (not React state):
//   - Pointer-event handlers fire OUTSIDE the React render cycle. A
//     `useState` flag would require a re-render before downstream
//     handlers could observe it.
//   - All three hooks live in the same app instance (no SSR); a module
//     singleton is fine and avoids prop-drilling a context.
//   - The check is a pre-condition guard ("am I allowed to start?"),
//     not a render input.
//
// The flag also owns the page-level side of a gesture, so node,
// connection and waypoint drags all get it and every cleanup path
// (each ends in `setCanvasGestureActive(false)`) undoes it. While a
// gesture is active:
//   - `<html>` carries `tocb-canvas-gesture`; `index.css` turns that
//     into `user-select: none` for everything but editable fields, so
//     neither the press nor the drag can start or extend a text
//     selection;
//   - text already highlighted on the page is cleared, unless focus is
//     in an input or a contenteditable (that selection is the user's
//     editing state), so there is nothing left for the browser to start
//     a native drag of;
//   - `dragstart` is cancelled. A native drag (of a selection, image or
//     link) takes over the pointer and fires `pointercancel`, which
//     would kill the gesture.

let active = false;

const GESTURE_CLASS = 'tocb-canvas-gesture';
const EDITABLE = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

const cancelNativeDrag = (e: Event) => e.preventDefault();

export function isCanvasGestureActive(): boolean {
  return active;
}

export function setCanvasGestureActive(value: boolean): void {
  if (value === active) return;
  active = value;
  document.documentElement.classList.toggle(GESTURE_CLASS, value);
  if (value) {
    if (!document.activeElement?.closest(EDITABLE)) window.getSelection()?.removeAllRanges();
    document.addEventListener('dragstart', cancelNativeDrag, true);
  } else {
    document.removeEventListener('dragstart', cancelNativeDrag, true);
  }
}

/** Test-only reset. Avoids tests leaking state across files. */
export function _resetCanvasGestureStateForTest(): void {
  setCanvasGestureActive(false);
}
