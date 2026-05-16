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
//
// Geometry: midpoint coords use the STRAIGHT-LINE midpoint of the
// chord between consecutive anchors (not the bezier midpoint at
// t=0.5). The straight midpoint is cheap, predictable, and visually
// adequate at this scale — a 6x6 px translucent dot sitting near the
// curve is unambiguous enough as an affordance. If we ever want
// tighter visual coupling we can switch to B(0.5); contract here is
// just "render a small circle nearby the segment".

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
   * Always `[source, ...waypoints, target]`, length ≥ 2.
   */
  anchors: Point[];
  /** Number of waypoints (anchors.length - 2). */
  waypointCount: number;
  /** True when the connection is hovered or selected. */
  visible: boolean;
  bindWaypoint: (sourceNodeId: string, targetNodeId: string, waypointIndex: number) => BindResult;
  bindMidpoint: (sourceNodeId: string, targetNodeId: string, segmentIndex: number) => BindResult;
}

export function ConnectionWaypointHandles({
  sourceNodeId,
  targetNodeId,
  anchors,
  waypointCount,
  visible,
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

  // Segment midpoints: between each consecutive pair of anchors. There
  // are anchors.length - 1 segments (== waypointCount + 1).
  const midpoints: Array<{ x: number; y: number; segmentIndex: number }> = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    midpoints.push({
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      segmentIndex: i,
    });
  }

  return (
    <g data-tocb-waypoint-handles={`${sourceNodeId}->${targetNodeId}`}>
      {/* Midpoint handles: smaller, translucent. Render UNDER waypoint
          handles so a waypoint's filled circle wins click priority if
          they happen to overlap (rare; happens on a 0-length segment). */}
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
