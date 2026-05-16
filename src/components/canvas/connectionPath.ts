// PR 5 Task 5.2: small reusable utility extracted from
// `ConnectionsComponent`'s ghost-path renderer. The drag-to-connect
// gesture (`useConnectionDrag`) needs the same cubic-bezier shape as
// the existing select-2 ghost preview, so factoring this out lets both
// callsites share the math.
//
// Shape parameters mirror the inline logic at the old
// `ConnectionsComponent.tsx:670-714` callsite. The function is pure:
// given a {start, end, curvature, direction}, returns an SVG `d`
// attribute value.
//
// Direction semantics:
//   - 'forward'  : left-to-right node-to-node (most common case)
//   - 'backward' : right-to-left (target left of source)
//   - 'vertical' : same-column (straight bezier, no horizontal offset)
//
// The connection-drag ghost (cursor follows the pointer) is always
// 'forward' from a 'right' handle and 'backward' from a 'left' handle,
// because the cursor's container-local x is what determines layout.
// Same-column dragging isn't a meaningful preview state for the drag
// gesture (the drag is purely visual; the actual connection is only
// committed on drop over a target node).

export type ConnectionPathDirection = 'forward' | 'backward' | 'vertical';

export interface BuildPathArgs {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  /** 0..1, see `ConnectionsComponent`'s curvature slider. */
  curvature: number;
  direction: ConnectionPathDirection;
}

/**
 * Compute the SVG `d` attribute for a cubic-bezier connection path.
 * Pure function; safe to call inside a render.
 */
export function buildConnectionPath({
  startX,
  startY,
  endX,
  endY,
  curvature,
  direction,
}: BuildPathArgs): string {
  const controlPointOffset = computeControlPointOffset({ startX, endX, curvature, direction });

  switch (direction) {
    case 'vertical':
      // Straight vertical: control points sit at startX+offset / endX+offset.
      // With offset=0 (the vertical case) this collapses to a straight
      // line, matching the existing renderer's behavior.
      return `M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX + controlPointOffset} ${endY}, ${endX} ${endY}`;
    case 'backward':
      // Right-to-left: control points reach left of source and right of target.
      return `M ${startX} ${startY} C ${startX - controlPointOffset} ${startY}, ${endX + controlPointOffset} ${endY}, ${endX} ${endY}`;
    case 'forward':
    default:
      // Left-to-right: control points reach right of source and left of target.
      return `M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX - controlPointOffset} ${endY}, ${endX} ${endY}`;
  }
}

interface OffsetArgs {
  startX: number;
  endX: number;
  curvature: number;
  direction: ConnectionPathDirection;
}

function computeControlPointOffset({ startX, endX, curvature, direction }: OffsetArgs): number {
  if (direction === 'vertical') return 0;
  const baseOffset = Math.abs(endX - startX) / 2;
  return curvature === 0 ? 0 : baseOffset * (0.1 + curvature * 1.9);
}
