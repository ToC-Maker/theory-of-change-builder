// Where a connection attaches to its nodes, and how its custom bend
// (`Connection.waypoints`) maps onto the canvas.
//
// A waypoint is stored as an offset `{dx, dy}` from the midpoint of the
// straight line between the source and target anchors, so the bend stays
// in the same place relative to its nodes whenever the layout moves them.
// Rendering turns offsets into canvas points with `resolveWaypoints`;
// dragging turns the pointer position back into an offset with
// `offsetFromMidpoint`. `connectionPath.ts` and the waypoint handles
// only ever see canvas points.

import type { WaypointOffset } from '../types';
import type { ConnectionPathDirection } from './connectionPath';

interface Point {
  x: number;
  y: number;
}

interface Box extends Point {
  width: number;
  height: number;
}

interface GridCell {
  sectionIndex: number;
  columnIndex: number;
}

/** Gap kept between the target anchor and the node so the arrowhead fits. */
const ARROW_OFFSET_PX = 14;

/**
 * Same column: vertical. Target in an earlier column or section:
 * backward. Otherwise forward.
 */
export function getConnectionDirection(
  source: GridCell,
  target: GridCell,
): ConnectionPathDirection {
  if (source.sectionIndex === target.sectionIndex && source.columnIndex === target.columnIndex) {
    return 'vertical';
  }
  const targetIsEarlier =
    target.sectionIndex < source.sectionIndex ||
    (target.sectionIndex === source.sectionIndex && target.columnIndex < source.columnIndex);
  return targetIsEarlier ? 'backward' : 'forward';
}

/**
 * The two points a connection runs between, in container-local pixels.
 * `sourceBox` and `targetBox` are the nodes' position and size in the
 * same space (`getLocalPosition`).
 */
export function computeConnectionAnchors(
  sourceBox: Box,
  targetBox: Box,
  direction: ConnectionPathDirection,
): { source: Point; target: Point } {
  switch (direction) {
    case 'vertical': {
      const x1 = sourceBox.x + sourceBox.width / 2;
      const x2 = targetBox.x + targetBox.width / 2;
      return sourceBox.y < targetBox.y
        ? {
            source: { x: x1, y: sourceBox.y + sourceBox.height },
            target: { x: x2, y: targetBox.y - ARROW_OFFSET_PX },
          }
        : {
            source: { x: x1, y: sourceBox.y },
            target: { x: x2, y: targetBox.y + targetBox.height + ARROW_OFFSET_PX },
          };
    }
    case 'backward':
      return {
        source: { x: sourceBox.x, y: sourceBox.y + sourceBox.height / 2 },
        target: {
          x: targetBox.x + targetBox.width + ARROW_OFFSET_PX,
          y: targetBox.y + targetBox.height / 2,
        },
      };
    case 'forward':
      return {
        source: { x: sourceBox.x + sourceBox.width, y: sourceBox.y + sourceBox.height / 2 },
        target: { x: targetBox.x - ARROW_OFFSET_PX, y: targetBox.y + targetBox.height / 2 },
      };
  }
}

/** Midpoint of the straight line between the anchors: the origin of waypoint offsets. */
export function lineMidpoint(source: Point, target: Point): Point {
  return { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
}

/** The offset that puts a waypoint at canvas point `point`. */
export function offsetFromMidpoint(point: Point, midpoint: Point): WaypointOffset {
  return { dx: point.x - midpoint.x, dy: point.y - midpoint.y };
}

/**
 * The entries of `waypoints` that are finite `{dx, dy}` offsets. Anything
 * else (the earlier absolute `{x, y}` format, a malformed import) is
 * dropped, which leaves the connection on its automatic curve until the
 * next drag overwrites the array.
 */
export function validWaypointOffsets(waypoints: unknown): WaypointOffset[] {
  if (!Array.isArray(waypoints)) return [];
  return waypoints.filter(
    (w): w is WaypointOffset =>
      typeof w === 'object' &&
      w !== null &&
      Number.isFinite((w as WaypointOffset).dx) &&
      Number.isFinite((w as WaypointOffset).dy),
  );
}

/** Canvas points for a connection's waypoints, given its line midpoint. */
export function resolveWaypoints(waypoints: unknown, midpoint: Point): Point[] {
  return validWaypointOffsets(waypoints).map((w) => ({
    x: midpoint.x + w.dx,
    y: midpoint.y + w.dy,
  }));
}
