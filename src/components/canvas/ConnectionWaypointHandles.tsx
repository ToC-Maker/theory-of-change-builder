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

import React from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

/**
 * PR #34 round-4 feedback 69: minimum press-target radius, in SCREEN
 * (CSS) pixels. The visible dots are deliberately small (r=4 / r=6 —
 * measured 6.7px / 10.1px effective at the default fit zoom), so each
 * handle renders an additional INVISIBLE hit circle: same center, same
 * handlers, `fill: transparent`, radius `HIT_RADIUS_SCREEN_PX /
 * zoomScale` so the effective on-screen target stays ≥ 24px however
 * far the canvas is zoomed out (never smaller than the visible dot at
 * high zoom). Standard SVG enlarged-hit-area pattern; the visible
 * circle becomes purely decorative (`pointerEvents: 'none'`).
 *
 * The data attributes ride on the HIT circle — it is the element that
 * receives the press, which is what `excludeFromPan` (App.tsx) and the
 * gesture tests hit-test against.
 */
const HIT_RADIUS_SCREEN_PX = 12;

function hitRadius(visibleR: number, zoomScale: number): number {
  const z = zoomScale > 0 ? zoomScale : 1;
  return Math.max(visibleR, HIT_RADIUS_SCREEN_PX / z);
}

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
  /**
   * Current canvas zoom (camera.z). The invisible hit circles divide
   * by it so the effective on-screen press target stays ≥ 24px at any
   * zoom-out level (feedback 69). Defaults to 1.
   */
  zoomScale?: number;
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
  zoomScale = 1,
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
      {/* Midpoint affordance: smaller, translucent, on the curve.
          Two circles per handle (feedback 69): the small decorative
          dot, and an invisible enlarged hit circle that owns the
          handlers + data attribute. */}
      {midpoint && midpointBound && (
        <>
          <circle
            cx={midpoint.x}
            cy={midpoint.y}
            r={4}
            style={{
              fill: 'rgba(99, 102, 241, 0.5)', // indigo-500 @ 50%
              stroke: 'white',
              strokeWidth: 1.5,
              pointerEvents: 'none', // decorative — the hit circle presses
            }}
          />
          <circle
            cx={midpoint.x}
            cy={midpoint.y}
            r={hitRadius(4, zoomScale)}
            data-tocb-midpoint-handle={`${sourceNodeId}->${targetNodeId}|0`}
            onPointerDown={midpointBound.onPointerDown}
            onClick={(e) => e.stopPropagation()}
            style={{
              fill: 'transparent',
              cursor: 'crosshair',
              pointerEvents: 'auto',
              touchAction: 'none',
            }}
          >
            <title>Drag to bend this connection</title>
          </circle>
        </>
      )}

      {/* Waypoint handles: filled, opaque. More than one only for
          legacy charts saved by the old multi-waypoint build. */}
      {waypoints.map(({ x, y, index }) => {
        const bound = bindWaypoint(sourceNodeId, targetNodeId, index);
        return (
          <React.Fragment key={`waypoint-${index}`}>
            <circle
              cx={x}
              cy={y}
              r={6}
              style={{
                fill: 'rgb(99, 102, 241)', // indigo-500
                stroke: 'white',
                strokeWidth: 2,
                pointerEvents: 'none', // decorative — the hit circle presses
              }}
            />
            <circle
              cx={x}
              cy={y}
              r={hitRadius(6, zoomScale)}
              data-tocb-waypoint-handle={`${sourceNodeId}->${targetNodeId}|${index}`}
              onPointerDown={bound.onPointerDown}
              onDoubleClick={bound.onDoubleClick}
              onClick={(e) => e.stopPropagation()}
              style={{
                fill: 'transparent',
                cursor: 'move',
                pointerEvents: 'auto',
                touchAction: 'none',
              }}
            >
              <title>Drag to adjust; double-click to straighten</title>
            </circle>
          </React.Fragment>
        );
      })}
    </g>
  );
}
