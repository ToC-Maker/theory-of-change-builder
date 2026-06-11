// Node vertical positioning helpers (PR #34 feedback 45/46).
//
// `yPosition` semantics (see CLAUDE.md "Node Positioning"): the CENTER
// Y of the node, in column-content-local coordinates. y=0 is the top of
// the column body, which sits just below the section title bar — so a
// center above `height/2` renders the node's top edge at a negative
// offset, overlapping the title.
//
// `clampNodeCenterY` is the single constraint shared by every write
// path (drop, double-click create, arrow-key move) and by the
// render-time visual clamp. The renderer clamps visually WITHOUT
// rewriting stored data, so legacy charts with out-of-range values stay
// byte-identical but display inside the column body.

/**
 * Clamp a node's center Y so its top edge stays at or below the top of
 * the column content area (i.e. below the section title bar).
 */
export function clampNodeCenterY(centerY: number, nodeHeight: number): number {
  return Math.max(nodeHeight / 2, centerY);
}

/**
 * Historical default center Y for drop targets that carry no cursor Y.
 * Kept for the new-column drop (the node lands at the top of the
 * freshly created column), clamped via `clampNodeCenterY` so a typical
 * node no longer pokes above the column body.
 */
export const DEFAULT_DROP_CENTER_Y = 20;

export interface DropCenterYArgs {
  /**
   * The cursor's Y in column-content-local coords at drop time (from
   * `classifyRegion` — node-slot and over-node targets), or null when
   * the target carries no cursor Y (new-column).
   */
  cursorColumnLocalY: number | null;
  /**
   * Offset from cursor to the dragged node's top edge at drag start, in
   * viewport px (captured before any zoom translation).
   */
  pointerOffsetY: number;
  /** Current zoom scale (1 = no zoom). */
  zoomScale: number;
  /** The dragged node's measured height in container-local px. */
  nodeHeight: number;
}

/**
 * Compute the dropped node's new center Y so the grab point stays under
 * the cursor, clamped below the section title.
 *
 * Extracted from `handleDrop` (TheoryOfChangeGraph) so the math is
 * unit-testable: `cursorColumnLocalY` is container-local (the drag hook
 * already divided by zoom), while `pointerOffsetY` is viewport-space —
 * divide by zoom to put both in the same coordinate system before
 * subtracting.
 */
export function computeDropCenterY({
  cursorColumnLocalY,
  pointerOffsetY,
  zoomScale,
  nodeHeight,
}: DropCenterYArgs): number {
  if (cursorColumnLocalY === null) {
    return clampNodeCenterY(DEFAULT_DROP_CENTER_Y, nodeHeight);
  }
  const nodeTopLocal = cursorColumnLocalY - pointerOffsetY / zoomScale;
  return clampNodeCenterY(nodeTopLocal + nodeHeight / 2, nodeHeight);
}
