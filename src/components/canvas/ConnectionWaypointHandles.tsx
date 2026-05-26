// PR 7 Task 7.3: waypoint + midpoint handles for a single connection.
//
// Rendered ABOVE the connection's `<path>` (as SVG circles, in the
// same SVG element as the path) when the connection is hovered or
// selected. Two kinds:
//
//   - Filled solid circles at each existing waypoint. `cursor: move`.
//     Pointerdown binds via `useWaypointDrag.bindWaypoint(...)`. Drag
//     moves the waypoint; release within 16px of a neighbor removes.
//
//   - Smaller translucent circles at each SEGMENT MIDPOINT.
//     `cursor: crosshair`. Pointerdown binds via
//     `useWaypointDrag.bindMidpoint(...)`. Drag creates a new waypoint
//     at the drop position.
//
// Segment indexing: a connection with N waypoints has N+1 segments.
// Segment 0 runs (source, waypoint[0]) — or (source, target) if N=0.
// Segment k (0 < k < N) runs (waypoint[k-1], waypoint[k]). Segment N
// runs (waypoint[N-1], target).
//
// Midpoint visibility: connections with zero waypoints show ONE
// midpoint handle (the user's entry point for adding waypoints). Each
// waypoint added increases the number of midpoint handles by one.
// **PR 7 feedback (17)**: midpoint handles are HIDDEN whenever a
// waypoint drag is in flight on this connection. The previous behavior
// (a fresh insert-from-midpoint immediately surfaced TWO new midpoints
// on either side of the dragged waypoint) was deeply confusing — the
// reviewer described the two new dots as "extra transparent circles"
// influencing the curve. They actually had no effect on the curve
// math, but they SAT ON the curve as the user dragged the new
// waypoint, and the curve was simultaneously deforming weirdly under
// the old bezier algorithm. Hiding them during drag removes the
// distraction; they reappear on pointerup so the user can continue
// adding more waypoints.
//
// Geometry: midpoint coords come from the caller as `segmentMidpoints`.
// They are the on-curve B(0.5) points of each segment (see
// `computeSegmentMidpoints` in `src/utils/connectionPath.ts`), so the
// handle dots sit ON the visible bezier line regardless of waypoint
// placement, curvature, or chord asymmetry. PR 7 feedback (A) — the
// earlier chord-midpoint formula put each dot a few pixels OFF the
// curve, which read as "floating" and made users wonder what those
// circles were attached to.

import type { PointerEvent as ReactPointerEvent } from 'react';

interface BindResult {
  onPointerDown: (e: ReactPointerEvent) => void;
}

interface Point {
  x: number;
  y: number;
}

export interface ConnectionWaypointHandlesProps {
  sourceNodeId: string;
  targetNodeId: string;
  /**
   * Anchor coordinates for the full path, in container-local space.
   * Always `[source, ...waypoints, target]`, length ≥ 2. Only the
   * interior entries (`anchors[1..N]`) are read here — they're the
   * positions of the existing waypoints.
   */
  anchors: Point[];
  /**
   * On-curve midpoint per segment, in container-local space. There is
   * one entry per segment (= `anchors.length - 1` = `waypointCount + 1`),
   * each one the bezier `B(0.5)` of the segment as rendered. Computed
   * by `computeSegmentMidpoints` in the parent so the handle dots
   * share identical control-point math with the rendered path and
   * always sit ON the visible curve.
   */
  segmentMidpoints: Point[];
  /** Number of waypoints (anchors.length - 2). */
  waypointCount: number;
  /** True when the connection is hovered or selected. */
  visible: boolean;
  /**
   * True when a waypoint drag is currently in flight on THIS connection.
   * Midpoint handles are hidden during drag (PR 7 feedback item 17) so
   * the user doesn't see two extra translucent circles spawn on either
   * side of the waypoint they're dragging.
   */
  dragInProgress?: boolean;
  bindWaypoint: (sourceNodeId: string, targetNodeId: string, waypointIndex: number) => BindResult;
  bindMidpoint: (sourceNodeId: string, targetNodeId: string, segmentIndex: number) => BindResult;
}

export function ConnectionWaypointHandles({
  sourceNodeId,
  targetNodeId,
  anchors,
  segmentMidpoints,
  waypointCount,
  visible,
  dragInProgress,
  bindWaypoint,
  bindMidpoint,
}: ConnectionWaypointHandlesProps) {
  if (!visible) return null;
  if (anchors.length < 2) return null;

  // Existing waypoints sit at anchors[1..N] (anchors[0]=source,
  // anchors[N+1]=target).
  const waypoints: Array<{ x: number; y: number; index: number }> = [];
  for (let i = 1; i <= waypointCount; i++) {
    waypoints.push({ x: anchors[i].x, y: anchors[i].y, index: i - 1 });
  }

  // Segment midpoints arrive precomputed (B(0.5) of each rendered
  // bezier segment) so the handle dots line up with the visible curve.
  // Skipped entirely while a drag is in flight on this connection (PR
  // 7 feedback item 17): the user dragging a waypoint shouldn't see
  // two new translucent dots spawn next to it.
  const midpoints: Array<{ x: number; y: number; segmentIndex: number }> = [];
  if (!dragInProgress) {
    for (let i = 0; i < segmentMidpoints.length; i++) {
      const m = segmentMidpoints[i];
      midpoints.push({ x: m.x, y: m.y, segmentIndex: i });
    }
  }

  return (
    <g data-tocb-waypoint-handles={`${sourceNodeId}->${targetNodeId}`}>
      {/* Midpoint handles: smaller, translucent. Render UNDER waypoint
          handles so a waypoint's filled circle wins click priority if
          they happen to overlap (rare; happens on a 0-length segment).
          Skipped entirely during an in-flight drag — see `dragInProgress`. */}
      {midpoints.map(({ x, y, segmentIndex }) => {
        const bound = bindMidpoint(sourceNodeId, targetNodeId, segmentIndex);
        return (
          <circle
            key={`midpoint-${segmentIndex}`}
            cx={x}
            cy={y}
            r={4}
            data-tocb-midpoint-handle={`${sourceNodeId}->${targetNodeId}|${segmentIndex}`}
            onPointerDown={bound.onPointerDown}
            onClick={(e) => e.stopPropagation()}
            style={{
              fill: 'rgba(99, 102, 241, 0.5)', // indigo-500 @ 50%
              stroke: 'white',
              strokeWidth: 1.5,
              cursor: 'crosshair',
              pointerEvents: 'auto',
              touchAction: 'none',
            }}
          />
        );
      })}

      {/* Waypoint handles: filled, opaque. */}
      {waypoints.map(({ x, y, index }) => {
        const bound = bindWaypoint(sourceNodeId, targetNodeId, index);
        return (
          <circle
            key={`waypoint-${index}`}
            cx={x}
            cy={y}
            r={6}
            data-tocb-waypoint-handle={`${sourceNodeId}->${targetNodeId}|${index}`}
            onPointerDown={bound.onPointerDown}
            onClick={(e) => e.stopPropagation()}
            style={{
              fill: 'rgb(99, 102, 241)', // indigo-500
              stroke: 'white',
              strokeWidth: 2,
              cursor: 'move',
              pointerEvents: 'auto',
              touchAction: 'none',
            }}
          />
        );
      })}
    </g>
  );
}
