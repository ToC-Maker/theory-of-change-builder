// Shared canvas-gesture coordination — one module-scope boolean ref.
//
// This is the "mutual exclusion" primitive called out in the red-team
// Important finding "PR 7 waypoint × connection-drag gesture coordination"
// (plan/figma-redesign.md:203). The three drag hooks shipped across the
// figma-redesign PR series all check this flag on `pointerdown` and
// short-circuit if another canvas gesture is in flight:
//
//   PR 4: `usePointerDrag`     (node drag)           — this PR, primary writer.
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
//     not a render input. Reading a mutable module ref is the right
//     primitive.
//
// Failure mode that motivated the design (red-team analysis): without
// mutual exclusion, a user could pointer-down on a node (starting
// `usePointerDrag`) and then pointer-down on a connection handle on
// the same node mid-drag (starting `useConnectionDrag`), capturing two
// pointers and dispatching two competing commits. The flag prevents
// the second start.
//
// Tests assert the transitions (set/clear/read) directly; this is a
// pure module-level state primitive with no React surface.

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
