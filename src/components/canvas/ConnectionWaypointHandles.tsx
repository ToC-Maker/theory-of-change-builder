// Waypoint + midpoint handles for a single connection — single-waypoint
// model (PR #34 feedback 53).
//
// Rendered ABOVE the connection's `<path>` (as SVG circles, in the
// same SVG element as the path) when the connection is hovered or
// selected. Two kinds:
//
//   - ONE translucent midpoint affordance at the on-curve midpoint,
//     shown only while the connection has NO waypoint. `cursor:
//     crosshair`. Dragging it creates THE waypoint
//     (`useWaypointDrag.bindMidpoint`).
//
//   - A filled solid circle at each existing waypoint. `cursor: move`.
//     Dragging moves the waypoint (`useWaypointDrag.bindWaypoint`);
//     double-click resets the connection to its automatic curve.
//
// Why only one midpoint affordance: the original N-waypoint design
// surfaced a new midpoint-insert dot on every segment, so dragging the
// midpoint spawned two new dots on either side ("editing the midway
// point shouldn't create two extra midway points" — reviewer). The
// single-waypoint model removes recursive splitting entirely: at rest
// you see one dot on the curve; once a waypoint exists, the only
// affordances are the waypoint handle itself (drag to adjust,
// double-click to reset).
//
// Legacy charts: connections saved by the earlier multi-waypoint build
// can carry N > 1 waypoints. All N handles render (the curve still
// passes through them — `computePathWithWaypoints` keeps N-waypoint
// support for rendering), but no midpoint-insert affordances are
// offered, and the first drag of any handle collapses the connection
// to the single dragged waypoint (see `useWaypointDrag`).
//
// Geometry: the midpoint affordance coordinate comes from the caller as
// `segmentMidpoints[0]` — the bezier B(0.5) of the rendered curve (see
// `computeSegmentMidpoints` in `src/utils/connectionPath.ts`), so the
// dot sits ON the visible line regardless of curvature or chord
// asymmetry.

import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

interface WaypointBindResult {
  onPointerDown: (e: ReactPointerEvent) => void;
  onDoubleClick: (e: ReactMouseEvent) => void;
}

interface MidpointBindResult {
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
   * On-curve midpoint per segment, in container-local space, computed
   * by `computeSegmentMidpoints` in the parent. Only `[0]` is consumed
   * (the midpoint affordance renders only when there are no waypoints,
   * i.e. when the path is a single segment).
   */
  segmentMidpoints: Point[];
  /** Number of waypoints (anchors.length - 2). */
  waypointCount: number;
  /** True when the connection is hovered or selected. */
  visible: boolean;
  /**
   * True when a waypoint drag is currently in flight on THIS
   * connection. The midpoint affordance is suppressed during the drag
   * (between pointerdown and the first armed move the connection still
   * has zero waypoints, and the dot would distract right under the
   * pointer).
   */
  dragInProgress?: boolean;
  bindWaypoint: (
    sourceNodeId: string,
    targetNodeId: string,
    waypointIndex: number,
  ) => WaypointBindResult;
  bindMidpoint: (
    sourceNodeId: string,
    targetNodeId: string,
    segmentIndex: number,
  ) => MidpointBindResult;
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

  // The single midpoint affordance: only when the connection has no
  // waypoint yet (and no drag is in flight on it).
  const showMidpoint = waypointCount === 0 && !dragInProgress && segmentMidpoints.length > 0;
  const midpoint = showMidpoint ? segmentMidpoints[0] : null;
  const midpointBound = midpoint ? bindMidpoint(sourceNodeId, targetNodeId, 0) : null;

  return (
    <g data-tocb-waypoint-handles={`${sourceNodeId}->${targetNodeId}`}>
      {/* Midpoint affordance: smaller, translucent, on the curve. */}
      {midpoint && midpointBound && (
        <circle
          cx={midpoint.x}
          cy={midpoint.y}
          r={4}
          data-tocb-midpoint-handle={`${sourceNodeId}->${targetNodeId}|0`}
          onPointerDown={midpointBound.onPointerDown}
          onClick={(e) => e.stopPropagation()}
          style={{
            fill: 'rgba(99, 102, 241, 0.5)', // indigo-500 @ 50%
            stroke: 'white',
            strokeWidth: 1.5,
            cursor: 'crosshair',
            pointerEvents: 'auto',
            touchAction: 'none',
          }}
        >
          <title>Drag to bend this connection</title>
        </circle>
      )}

      {/* Waypoint handles: filled, opaque. More than one only for
          legacy charts saved by the old multi-waypoint build. */}
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
            onDoubleClick={bound.onDoubleClick}
            onClick={(e) => e.stopPropagation()}
            style={{
              fill: 'rgb(99, 102, 241)', // indigo-500
              stroke: 'white',
              strokeWidth: 2,
              cursor: 'move',
              pointerEvents: 'auto',
              touchAction: 'none',
            }}
          >
            <title>Drag to adjust; double-click to straighten</title>
          </circle>
        );
      })}
    </g>
  );
}
