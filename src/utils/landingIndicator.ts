// Where the drag landing indicator draws, in CONTENT space (container-
// relative px with the zoom transform factored out — the same space as
// the layout snapshot's column rects).
//
// The indicator exists for the one target the dragged node's copy cannot
// show by itself: a new column, whose drop point is the gutter between
// two columns. Over a column body the copy snaps into place (see
// `computeDropPreview`), so no mark is drawn there.
import type { DragState } from '../hooks/usePointerDrag';
import type { LayoutSnapshot } from '../hooks/useGraphLayout';

/** Highlight of the gutter a new column would be inserted into. */
export type LandingIndicator = {
  kind: 'gutter';
  left: number;
  top: number;
  width: number;
  height: number;
};

export interface LandingIndicatorArgs {
  dragState: DragState;
  snapshot: LayoutSnapshot;
}

/**
 * The indicator for the current drag frame, or null when nothing should
 * be drawn: before the pointer has left the tap dead-zone, while the
 * cursor is outside every drop region, over a column body (the copy marks
 * it), and for targets the drop ignores (`new-section`: `handleDrop`
 * returns early, so a landing mark there would promise a move that never
 * happens).
 */
export function computeLandingIndicator({
  dragState,
  snapshot,
}: LandingIndicatorArgs): LandingIndicator | null {
  const target = dragState.dragOverLocation;
  if (!dragState.hasMoved || target?.kind !== 'new-column') return null;

  const columns = snapshot.columnRects[target.sectionIndex];
  const before = columns?.[target.columnIndex - 1];
  const after = columns?.[target.columnIndex];
  if (!before || !after) return null;
  const top = Math.min(before.top, after.top);
  return {
    kind: 'gutter',
    left: before.right,
    width: after.left - before.right,
    top,
    height: Math.max(before.bottom, after.bottom) - top,
  };
}
