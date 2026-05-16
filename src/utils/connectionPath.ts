// PR 7 Task 7.1: bezier-through-waypoints path math.
//
// Builds a single SVG `M ... C ... [C ...]*` path string that runs from
// source through any number of intermediate waypoints to target. Used
// by `ConnectionsComponent` when `connection.waypoints` is defined.
//
// Why a single multi-segment path (not many small `<path>` elements):
//   Dashed/dotted strokes (confidence < 80) compute their dash phase
//   along the WHOLE path. Splitting a connection into multiple SVG
//   `<path>` elements causes each segment's dasharray to restart at
//   phase 0, producing visible double-dots / skipped-dashes at every
//   waypoint corner. The red-team Critical (plan/figma-redesign.md:160-
//   163) called this out explicitly; the test file pins the shape.
//
// Smoothness at waypoint corners (C1 continuity):
//   For each interior waypoint W, the control point LEAVING W is the
//   reflection across W of the control point ARRIVING into W. That
//   guarantees a continuous tangent — the path has no kink at the
//   waypoint, so the dash pattern flows through smoothly.
//
// 0-waypoint backward compatibility:
//   With an empty waypoints array, the output is BYTE-IDENTICAL to the
//   inline auto-bezier string previously built at
//   `ConnectionsComponent.tsx:497-501` / `:534-538` / `:557-561`.
//   The test file's `0 waypoints — backward-compat fallback` block pins
//   this exactly (forward / backward / vertical / curvature=0 cases).
//
// Pure function: safe to call inside render, deterministic, no DOM
// reads, no allocations beyond the returned string.

export type ConnectionPathDirection = 'forward' | 'backward' | 'vertical';

interface Point {
  x: number;
  y: number;
}

export interface ComputePathArgs {
  source: Point;
  target: Point;
  waypoints: Point[];
  /** 0..1, mirrors the existing curvature slider in ConnectionsComponent. */
  curvature: number;
  /**
   * Direction hint used ONLY when waypoints is empty (the 0-waypoint
   * fallback must match the existing inline auto-bezier byte-for-byte,
   * which uses a direction-dependent sign on the horizontal control
   * offset). With one or more waypoints, the connection's overall
   * direction is implicit in source → waypoints[0] → ... → target, so
   * the direction hint applies only to the source and target endpoint
   * tangents (we always orient the source-side control horizontally
   * toward the first waypoint and the target-side control horizontally
   * away from the last waypoint).
   */
  direction: ConnectionPathDirection;
}

/**
 * Compute the SVG `d` attribute for a multi-segment cubic-bezier path
 * passing through every waypoint. Returns:
 *   - 0 waypoints: `M sx sy C c1x c1y, c2x c2y, tx ty`
 *   - 1 waypoint:  `M sx sy C c1x c1y, c2x c2y, wx wy C c3x c3y, c4x c4y, tx ty`
 *   - N waypoints: one Move + (N+1) Curve segments.
 */
export function computePathWithWaypoints(args: ComputePathArgs): string {
  const { source, target, waypoints, curvature, direction } = args;

  if (waypoints.length === 0) {
    return buildZeroWaypointPath(source, target, curvature, direction);
  }

  return buildMultiWaypointPath(source, target, waypoints, curvature, direction);
}

// ---------------------------------------------------------------------------
// 0-waypoint fallback (byte-identical to existing inline auto-bezier)
// ---------------------------------------------------------------------------

function buildZeroWaypointPath(
  source: Point,
  target: Point,
  curvature: number,
  direction: ConnectionPathDirection,
): string {
  const offset = computeControlPointOffset(source.x, target.x, curvature, direction);
  const { x: sx, y: sy } = source;
  const { x: tx, y: ty } = target;

  switch (direction) {
    case 'vertical':
      return `M ${sx} ${sy} C ${sx + offset} ${sy}, ${tx + offset} ${ty}, ${tx} ${ty}`;
    case 'backward':
      return `M ${sx} ${sy} C ${sx - offset} ${sy}, ${tx + offset} ${ty}, ${tx} ${ty}`;
    case 'forward':
    default:
      return `M ${sx} ${sy} C ${sx + offset} ${sy}, ${tx - offset} ${ty}, ${tx} ${ty}`;
  }
}

function computeControlPointOffset(
  startX: number,
  endX: number,
  curvature: number,
  direction: ConnectionPathDirection,
): number {
  if (direction === 'vertical') return 0;
  const baseOffset = Math.abs(endX - startX) / 2;
  return curvature === 0 ? 0 : baseOffset * (0.1 + curvature * 1.9);
}

// ---------------------------------------------------------------------------
// N-waypoint multi-segment bezier
// ---------------------------------------------------------------------------
//
// Strategy:
//   1. Collect anchors = [source, ...waypoints, target] (length N+2).
//   2. For each interior anchor i (1 ≤ i ≤ N), pick an "incoming control
//      direction" parallel to the local segment chord (anchors[i+1] -
//      anchors[i-1]). This gives a smooth tangent through the waypoint.
//   3. Place the incoming control at (anchor[i] - dir * incomingMag) and
//      the outgoing control at (anchor[i] + dir * outgoingMag). Both
//      live ON the same tangent line, so they are reflections across
//      the anchor and the path is C1-continuous.
//   4. Source side: the outgoing control of source is horizontally
//      offset toward waypoints[0] by the same |Δx|/2 * (0.1 + curvature*1.9)
//      formula (matching the 0-waypoint shape's source-side tangent).
//   5. Target side: the incoming control of target is horizontally
//      offset away from waypoints[last] by the same formula (so the
//      arrowhead tangent stays horizontal, matching the 0-waypoint
//      behaviour and keeping the visual feel consistent).

function buildMultiWaypointPath(
  source: Point,
  target: Point,
  waypoints: Point[],
  curvature: number,
  direction: ConnectionPathDirection,
): string {
  // Anchors include source and target at the ends.
  const anchors: Point[] = [source, ...waypoints, target];

  // Per-segment magnitude: half the segment's chord length, scaled by
  // curvature (using the same formula as the 0-waypoint case so the
  // visual feel is consistent at curvature=0 and curvature=1).
  //
  // For curvature=0 the magnitude is 0 (anchors collapse to a polyline
  // of straight cubic-segments where both control points sit on the
  // endpoints — still a valid bezier, still a single path string).
  const segMagnitude = (a: Point, b: Point): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const chord = Math.hypot(dx, dy);
    return curvature === 0 ? 0 : (chord / 2) * (0.1 + curvature * 1.9);
  };

  // For each interior anchor i, compute the unit tangent along
  // (anchors[i+1] - anchors[i-1]) — i.e., the chord between its
  // neighbors. This is the "Catmull-Rom-like" tangent direction. The
  // magnitude on each side scales by the local segment's chord length.
  const interiorTangents: Array<{ ux: number; uy: number }> = [];
  for (let i = 1; i < anchors.length - 1; i++) {
    const prev = anchors[i - 1];
    const next = anchors[i + 1];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy);
    // Guard against degenerate zero-length tangent (source==target with
    // waypoints folded onto the same point). Default to horizontal
    // pointing in the direction's natural sense.
    if (len === 0) {
      const sign = direction === 'backward' ? -1 : 1;
      interiorTangents.push({ ux: sign, uy: 0 });
    } else {
      interiorTangents.push({ ux: dx / len, uy: dy / len });
    }
  }

  // Source-side outgoing control: horizontal offset matching the
  // 0-waypoint source-side shape (so the connection's first segment
  // leaves the source with the same tangent style).
  const firstWp = anchors[1];
  const sourceOffset = computeControlPointOffset(source.x, firstWp.x, curvature, direction);
  const sourceOutX = direction === 'backward' ? source.x - sourceOffset : source.x + sourceOffset;
  const sourceOutY = source.y;

  // Target-side incoming control: horizontal offset matching the
  // 0-waypoint target-side shape (so the arrowhead tangent stays
  // horizontal at the target).
  const lastWp = anchors[anchors.length - 2];
  const targetOffset = computeControlPointOffset(lastWp.x, target.x, curvature, direction);
  // The target-side control offset SIGN mirrors the 0-waypoint shape:
  //   forward  : target - offset (control sits left of target).
  //   backward : target + offset (control sits right of target).
  //   vertical : target + offset (no-op when offset=0).
  const targetInX =
    direction === 'forward'
      ? target.x - targetOffset
      : direction === 'backward'
        ? target.x + targetOffset
        : target.x + targetOffset;
  const targetInY = target.y;

  // Build segments. For each segment i from anchors[i] to anchors[i+1]:
  //   - c1 (leaving anchor[i]) and c2 (arriving anchor[i+1]).
  // Endpoints: source's c1 = sourceOut (computed above); target's c2 =
  // targetIn (computed above). Interior endpoints place controls along
  // their tangent at +/- segMagnitude from the anchor.
  const segments: string[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    const mag = segMagnitude(a, b);

    // c1: leaving anchor a.
    let c1x: number, c1y: number;
    if (i === 0) {
      c1x = sourceOutX;
      c1y = sourceOutY;
    } else {
      const t = interiorTangents[i - 1];
      c1x = a.x + t.ux * mag;
      c1y = a.y + t.uy * mag;
    }

    // c2: arriving anchor b.
    let c2x: number, c2y: number;
    if (i === anchors.length - 2) {
      c2x = targetInX;
      c2y = targetInY;
    } else {
      // anchors[i+1] is an interior waypoint; use the tangent at index
      // i (0-based interior tangents array).
      const t = interiorTangents[i];
      c2x = b.x - t.ux * mag;
      c2y = b.y - t.uy * mag;
    }

    segments.push(`C ${c1x} ${c1y}, ${c2x} ${c2y}, ${b.x} ${b.y}`);
  }

  return `M ${source.x} ${source.y} ${segments.join(' ')}`;
}
