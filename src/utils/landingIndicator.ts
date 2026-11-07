// Where the drag landing indicator draws, in CONTENT space (container-
// relative px with the zoom transform factored out — the same space as
// the layout snapshot's column rects).
//
// The indicator must agree with what `handleDrop` does on release, so
// node targets go through `computeDropCenterY` (the single placement
// formula) instead of re-deriving it. Note the Y conventions: the drop
// target's `yPosition` is the CURSOR's Y, and a node's stored
// `yPosition` is its CENTER Y, both column-local (0 is the top of the
// column body), as is the `top` of the node wrapper, which renders at
// `centerY - height/2`. That is the edge the line marks, so the column's
// content-space `top` is added to reach content space.
import type { DragState } from '../hooks/usePointerDrag';
import type { LayoutSnapshot } from '../hooks/useGraphLayout';
import { computeDropCenterY } from './nodePosition';

export type LandingIndicator =
  /** Insertion line across the target column, at the dropped node's top edge. */
  | { kind: 'line'; left: number; top: number; width: number }
  /** Highlight of the gutter a new column would be inserted into. */
  | { kind: 'gutter'; left: number; top: number; width: number; height: number };

export interface LandingIndicatorArgs {
  dragState: DragState;
  snapshot: LayoutSnapshot;
  zoomScale: number;
  /** The dragged node's height as `handleDrop` measures it. */
  nodeHeight: number;
}

/**
 * The indicator for the current drag frame, or null when nothing should
 * be drawn: before the pointer has left the tap dead-zone, while the
 * cursor is outside every drop region, and for targets the drop ignores
 * (`new-section`: `handleDrop` returns early, so a landing mark there
 * would promise a move that never happens).
 */
export function computeLandingIndicator({
  dragState,
  snapshot,
  zoomScale,
  nodeHeight,
}: LandingIndicatorArgs): LandingIndicator | null {
  const target = dragState.dragOverLocation;
  if (!dragState.hasMoved || !target) return null;

  switch (target.kind) {
    case 'node-slot':
    case 'over-node': {
      const col = snapshot.columnRects[target.sectionIndex]?.[target.columnIndex];
      if (!col) return null;
      const centerY = computeDropCenterY({
        cursorColumnLocalY: target.yPosition,
        pointerOffsetY: dragState.pointerOffset.y,
        zoomScale,
        nodeHeight,
      });
      // The column grows to fit a node wider than it (empty columns are
      // 128px), widening around its centre, so span the post-drop width.
      const colWidth = col.right - col.left;
      const width = Math.max(colWidth, dragState.nodeSize.width);
      return {
        kind: 'line',
        left: col.left - (width - colWidth) / 2,
        width,
        top: col.top + centerY - nodeHeight / 2,
      };
    }
    case 'new-column': {
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
    case 'new-section':
      return null;
  }
}
