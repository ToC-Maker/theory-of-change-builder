// Where the dragged node's copy sits while the pointer is over a column,
// in CONTENT space (container-relative px with the zoom transform factored
// out, the same space as the layout snapshot's column rects).
//
// Over a column the copy snaps into it, horizontally centred the way the
// node will sit, at the height the drop will place it. The height goes
// through `computeDropCenterY`, the single placement formula `handleDrop`
// uses, so the copy shows exactly where the node lands, clamp included.
// Everywhere else (a gap between columns, outside every drop region) there
// is nothing to snap to and the copy follows the cursor.
import type { DragState } from '../hooks/usePointerDrag';
import type { LayoutSnapshot } from '../hooks/useGraphLayout';
import { computeDropCenterY } from './nodePosition';

export interface DropPreview {
  sectionIndex: number;
  columnIndex: number;
  /** Column-local centre Y the dropped node will have. */
  centerY: number;
  /** Top-left of the copy, content space. */
  copy: { left: number; top: number };
}

export interface DropPreviewArgs {
  dragState: DragState;
  snapshot: LayoutSnapshot;
  zoomScale: number;
  /** The dragged node's height as `handleDrop` measures it. */
  nodeHeight: number;
}

/**
 * The snapped placement for the current drag frame, or null when the copy
 * should follow the cursor: before the pointer has left the tap dead-zone,
 * outside every drop region, and over targets that are not a column body
 * (a new-column gap, which draws its own indicator, and `new-section`,
 * which `handleDrop` ignores).
 *
 * The column grows to fit a node wider than it (empty columns are 128px),
 * widening around its centre, so the copy is centred on the column either
 * way.
 */
export function computeDropPreview({
  dragState,
  snapshot,
  zoomScale,
  nodeHeight,
}: DropPreviewArgs): DropPreview | null {
  const target = dragState.dragOverLocation;
  if (!dragState.hasMoved || !target) return null;
  if (target.kind !== 'node-slot' && target.kind !== 'over-node') return null;

  const col = snapshot.columnRects[target.sectionIndex]?.[target.columnIndex];
  if (!col) return null;

  const centerY = computeDropCenterY({
    cursorColumnLocalY: target.yPosition,
    pointerOffsetY: dragState.pointerOffset.y,
    zoomScale,
    nodeHeight,
  });
  return {
    sectionIndex: target.sectionIndex,
    columnIndex: target.columnIndex,
    centerY,
    copy: {
      left: (col.left + col.right) / 2 - dragState.nodeSize.width / 2,
      top: col.top + centerY - nodeHeight / 2,
    },
  };
}
