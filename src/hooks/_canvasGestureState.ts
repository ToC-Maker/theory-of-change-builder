// Shared canvas-gesture coordination — one module-scope boolean ref.
//
// Mutual-exclusion primitive shared by three drag hooks across the
// figma-redesign PR series. Each checks the flag on `pointerdown` and
// short-circuits if another canvas gesture is in flight:
//
//   PR 4: `usePointerDrag`     (node drag)           — primary writer.
//   PR 5: `useConnectionDrag`  (connection handles)  — reader.
//   PR 7: `useWaypointDrag`    (path waypoints)      — reader.
//
// Why module-scope (not React state):
//   - Pointer-event handlers fire OUTSIDE the React render cycle. A
//     `useState` flag would require a re-render before downstream
//     handlers could observe it.
//   - All three hooks live in the same app instance (no SSR); a module
//     singleton is fine and avoids prop-drilling a context.
//   - The check is a pre-condition guard ("am I allowed to start?"),
//     not a render input.

let active = false;

export function isCanvasGestureActive(): boolean {
  return active;
}

export function setCanvasGestureActive(value: boolean): void {
  active = value;
}

/** Test-only reset. Avoids tests leaking state across files. */
export function _resetCanvasGestureStateForTest(): void {
  active = false;
}
