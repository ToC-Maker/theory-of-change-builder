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
 *
 * Defensive: filters non-finite or non-`{x,y}` entries from
 * `waypoints` (and accepts a non-array `waypoints` value by treating it
 * as empty). A malformed JSON import with NaN coords or string coords
 * would otherwise produce an SVG `d` containing `NaN` (browsers
 * silently drop the path) or throw on null entries; both render the
 * canvas subtree unrendered. Filtering here closes that gap at the
 * renderer; the JSON-import boundary additionally rejects malformed
 * shapes before they reach state.
 */
export function computePathWithWaypoints(args: ComputePathArgs): string {
  const { source, target, waypoints, curvature, direction } = args;

  const safeWaypoints = sanitizeWaypoints(waypoints);
  if (safeWaypoints.length === 0) {
    return buildZeroWaypointPath(source, target, curvature, direction);
  }

  return buildMultiWaypointPath(source, target, safeWaypoints, curvature, direction);
}

/**
 * Compute the ON-CURVE midpoint (bezier `B(0.5)`) for every segment of
 * the rendered path. PR 7 feedback (A): the midpoint affordance circles
 * in `<ConnectionWaypointHandles>` previously used the straight chord
 * midpoint `(P0 + P3) / 2`, which sits noticeably off the actual bezier
 * for any non-trivial curvature — visually the dots appeared to "float"
 * above (or below) the connection line. Sharing the exact same control-
 * point math as `computePathWithWaypoints` and evaluating at t=0.5 puts
 * each handle ON the curve, regardless of waypoint position, curvature,
 * or chord asymmetry.
 *
 * Returns one `{x, y}` per segment, indexed identically to the segment
 * indexing in `<ConnectionWaypointHandles>` (segment i runs between
 * `anchors[i]` and `anchors[i+1]`, where `anchors = [source,
 * ...waypoints, target]`). A 0-waypoint connection returns one
 * midpoint (the single segment's B(0.5)).
 *
 * Pure function: identical args → identical result. Safe to call inside
 * render.
 */
export function computeSegmentMidpoints(args: ComputePathArgs): Point[] {
  const { source, target, waypoints, curvature, direction } = args;
  const safeWaypoints = sanitizeWaypoints(waypoints);

  if (safeWaypoints.length === 0) {
    // 0-waypoint case: one cubic bezier from source to target. Reuse
    // `buildZeroWaypointPath`'s control-point logic exactly so the
    // midpoint sits on the rendered curve.
    const offset = computeControlPointOffset(source.x, target.x, curvature, direction);
    let c1x: number, c2x: number;
    switch (direction) {
      case 'vertical':
        c1x = source.x + offset;
        c2x = target.x + offset;
        break;
      case 'backward':
        c1x = source.x - offset;
        c2x = target.x + offset;
        break;
      case 'forward':
      default:
        c1x = source.x + offset;
        c2x = target.x - offset;
        break;
    }
    return [bezierMidpoint(source, { x: c1x, y: source.y }, { x: c2x, y: target.y }, target)];
  }

  // Multi-waypoint case: reuse the segment + control-point compute from
  // `buildMultiWaypointPath`. We extract it into a shared helper so the
  // two callers can't drift.
  const segments = computeMultiWaypointSegments(
    source,
    target,
    safeWaypoints,
    curvature,
    direction,
  );
  return segments.map((s) => bezierMidpoint(s.p0, s.c1, s.c2, s.p3));
}

/**
 * Cubic bezier evaluation at t=0.5. Standard formula
 * `B(0.5) = (P0 + 3·P1 + 3·P2 + P3) / 8`.
 */
function bezierMidpoint(p0: Point, p1: Point, p2: Point, p3: Point): Point {
  return {
    x: (p0.x + 3 * p1.x + 3 * p2.x + p3.x) / 8,
    y: (p0.y + 3 * p1.y + 3 * p2.y + p3.y) / 8,
  };
}

function sanitizeWaypoints(input: unknown): Point[] {
  if (!Array.isArray(input)) return [];
  const out: Point[] = [];
  for (const w of input) {
    if (
      w &&
      typeof w === 'object' &&
      'x' in w &&
      'y' in w &&
      typeof (w as Point).x === 'number' &&
      typeof (w as Point).y === 'number' &&
      Number.isFinite((w as Point).x) &&
      Number.isFinite((w as Point).y)
    ) {
      out.push({ x: (w as Point).x, y: (w as Point).y });
    }
  }
  return out;
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
// Strategy (rewritten for PR 7 feedback item 17 — small drags must
// produce small curve deformations, no S-shapes near endpoints):
//
//   1. Collect anchors = [source, ...waypoints, target] (length N+2).
//
//   2. For each interior anchor i (1 ≤ i ≤ N), pick a tangent direction
//      parallel to the chord between its neighbors:
//        tangent_i = unit(anchors[i+1] - anchors[i-1])
//      This is the Catmull-Rom-like direction. It guarantees a smooth
//      visual flow through the waypoint.
//
//   3. **One magnitude per WAYPOINT (not per segment)**, used for BOTH
//      sides of the waypoint:
//        mag_i = factor(curvature) * min(|W_i - A|, |W_i - B|)
//      where A, B are the neighboring anchors. Using the SHORTER
//      neighbor chord clamps each control arm to within the segment
//      envelope, preventing the c2-overshoots-c1 S-shape that the
//      previous formula produced when one neighbor was much closer
//      than the other (the typical case during a fresh waypoint drag:
//      a new waypoint inserted at the midpoint then dragged slightly,
//      with source and target still roughly equidistant — but as the
//      user drags the waypoint near one node, that side's segment
//      shrinks and the OLD per-segment magnitude let the other side's
//      magnitude grow with the larger segment, producing the loop).
//
//      Because both sides of the waypoint use the same magnitude, the
//      incoming and outgoing controls are reflections across the
//      waypoint → C1 continuity → the dash pattern stays smooth across
//      the waypoint (the dash-phase test invariant from PR 7 Task 7.1).
//
//   4. Source-side outgoing control: along the first segment's chord
//      direction (source → first waypoint), magnitude = factor *
//      |source → firstWp|. Symmetric for target side. This replaces
//      the previous "always horizontal" tangent at the endpoints,
//      which was the SECOND source of S-shapes: a horizontal source
//      tangent reaching 34px right + an interior tangent reaching
//      back 42px to the left would cross each other.
//
//      The trade-off: the arrowhead no longer enters target strictly
//      horizontally when there are waypoints. In practice this looks
//      MORE natural — the curve smoothly flows toward the arrowhead
//      from the last waypoint's direction, rather than making a hard
//      90° turn to enter horizontally. The 0-waypoint case is
//      unchanged (byte-identical) and that's what most connections
//      look like, so the new behavior only surfaces when the user has
//      explicitly added a waypoint.
//
//   5. Scale `factor(curvature)` so that:
//        - At curvature=0: factor=0 (straight polyline segments).
//        - At curvature=0.5 (default): factor≈0.4 (gentle curves).
//        - At curvature=1.0: factor≈0.55 (pronounced curves).
//      The previous `(chord/2) * (0.1 + 1.9*curv)` peaked at half the
//      chord per side, which is geometrically the maximum sensible
//      magnitude before control arms invert. Using a smaller factor
//      (peaking at ~0.55 of the SHORTER chord) keeps the path within
//      the polyline envelope across the whole curvature slider range.
//
// Backward-compat:
//   The 0-waypoint shape goes through `buildZeroWaypointPath`, which is
//   unchanged. The byte-identical fallback test pins it. The 1+ -waypoint
//   shape changes intentionally — the previous shape was buggy under
//   small drags. The "single Move + N+1 Curves" structural test still
//   passes because we still emit one Move + (anchors.length-1) Curves.
//   The C1 reflection test passes because we now use the SAME magnitude
//   for both control points around an interior waypoint.

/**
 * Per-segment control-point + anchor record. Returned by
 * `computeMultiWaypointSegments` so the path-string builder and the
 * midpoint-affordance positioner share identical math.
 */
interface Segment {
  p0: Point;
  c1: Point;
  c2: Point;
  p3: Point;
}

/**
 * Compute the list of cubic bezier segments for a multi-waypoint
 * connection. Each segment has explicit P0/c1/c2/P3 so callers can
 * either render the path string or evaluate the bezier (e.g. for
 * on-curve midpoint affordances). Single source of truth for the
 * control-point geometry.
 */
function computeMultiWaypointSegments(
  source: Point,
  target: Point,
  waypoints: Point[],
  curvature: number,
  direction: ConnectionPathDirection,
): Segment[] {
  // Anchors include source and target at the ends.
  const anchors: Point[] = [source, ...waypoints, target];

  // Curvature → magnitude scale. Zero at curvature=0 (straight
  // segments), ~0.4 at the default 0.5, ~0.55 at curvature=1.
  // Keeping the scale below 0.6 prevents control-arm-inversion S-shapes
  // even when the user drags a waypoint very close to a neighbor.
  const factor = curvature === 0 ? 0 : 0.25 + curvature * 0.3;

  // Helper: chord length between two points.
  const chord = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

  // For each interior anchor i (waypoint), compute:
  //   - unit tangent along (anchors[i+1] - anchors[i-1])
  //   - magnitude = factor * min(|W - prev|, |W - next|)  (one per WAYPOINT)
  // The single-magnitude-per-waypoint choice is what makes the path
  // C1-continuous across that waypoint (incoming and outgoing controls
  // become reflections of each other across W).
  const interior: Array<{
    ux: number;
    uy: number;
    mag: number;
  }> = [];
  for (let i = 1; i < anchors.length - 1; i++) {
    const prev = anchors[i - 1];
    const here = anchors[i];
    const next = anchors[i + 1];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const tangentLen = Math.hypot(dx, dy);
    let ux: number, uy: number;
    if (tangentLen === 0) {
      // Degenerate: source==target with waypoints collapsed. Default to
      // horizontal in the direction's natural sense so the renderer
      // still produces a finite path.
      const sign = direction === 'backward' ? -1 : 1;
      ux = sign;
      uy = 0;
    } else {
      ux = dx / tangentLen;
      uy = dy / tangentLen;
    }
    const segIn = chord(prev, here);
    const segOut = chord(here, next);
    const mag = factor * Math.min(segIn, segOut);
    interior.push({ ux, uy, mag });
  }

  // Source-side outgoing control: along (source → firstWaypoint)
  // direction, magnitude = factor * |source → firstWaypoint|. Falls
  // back to a horizontal degenerate when source == firstWaypoint.
  const firstWp = anchors[1];
  const sdx = firstWp.x - source.x;
  const sdy = firstWp.y - source.y;
  const sourceSegLen = Math.hypot(sdx, sdy);
  let sourceOutX: number, sourceOutY: number;
  if (sourceSegLen === 0 || factor === 0) {
    sourceOutX = source.x;
    sourceOutY = source.y;
  } else {
    const sMag = factor * sourceSegLen;
    sourceOutX = source.x + (sdx / sourceSegLen) * sMag;
    sourceOutY = source.y + (sdy / sourceSegLen) * sMag;
  }

  // Target-side incoming control: along (lastWaypoint → target),
  // magnitude = factor * |lastWaypoint → target|. Same degenerate
  // handling.
  const lastWp = anchors[anchors.length - 2];
  const tdx = target.x - lastWp.x;
  const tdy = target.y - lastWp.y;
  const targetSegLen = Math.hypot(tdx, tdy);
  let targetInX: number, targetInY: number;
  if (targetSegLen === 0 || factor === 0) {
    targetInX = target.x;
    targetInY = target.y;
  } else {
    const tMag = factor * targetSegLen;
    // Control points sit BEFORE the target along the segment direction.
    targetInX = target.x - (tdx / targetSegLen) * tMag;
    targetInY = target.y - (tdy / targetSegLen) * tMag;
  }

  // Build segments. For each segment i from anchors[i] to anchors[i+1]:
  //   - c1 (leaving anchor[i]) and c2 (arriving anchor[i+1]).
  // Source's c1 = sourceOut; target's c2 = targetIn. Interior endpoints
  // place controls along their tangent at +/- mag from the anchor, with
  // the SAME mag for both sides of any given waypoint (C1 invariant).
  const segments: Segment[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];

    // c1: leaving anchor a.
    let c1x: number, c1y: number;
    if (i === 0) {
      c1x = sourceOutX;
      c1y = sourceOutY;
    } else {
      // anchors[i] is interior waypoint with index i-1 in `interior`.
      const t = interior[i - 1];
      c1x = a.x + t.ux * t.mag;
      c1y = a.y + t.uy * t.mag;
    }

    // c2: arriving anchor b.
    let c2x: number, c2y: number;
    if (i === anchors.length - 2) {
      c2x = targetInX;
      c2y = targetInY;
    } else {
      // anchors[i+1] is interior waypoint with index i in `interior`.
      const t = interior[i];
      c2x = b.x - t.ux * t.mag;
      c2y = b.y - t.uy * t.mag;
    }

    segments.push({ p0: a, c1: { x: c1x, y: c1y }, c2: { x: c2x, y: c2y }, p3: b });
  }

  return segments;
}

function buildMultiWaypointPath(
  source: Point,
  target: Point,
  waypoints: Point[],
  curvature: number,
  direction: ConnectionPathDirection,
): string {
  const segments = computeMultiWaypointSegments(source, target, waypoints, curvature, direction);
  // Stringify exactly as before — the unit tests pin the byte shape
  // (single Move + N+1 Curves, anchor coordinates round-tripping).
  const segStrs = segments.map(
    (s) => `C ${s.c1.x} ${s.c1.y}, ${s.c2.x} ${s.c2.y}, ${s.p3.x} ${s.p3.y}`,
  );
  return `M ${source.x} ${source.y} ${segStrs.join(' ')}`;
}
