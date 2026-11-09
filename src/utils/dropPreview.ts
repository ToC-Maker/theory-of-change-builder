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
//
// The same call works out how the target column's other nodes shift to
// make room (`planColumnDrop`, which the drop commit also runs). When the
// nodes above cannot all move up far enough the landing spot itself moves
// down, and the copy shows that spot.
import type { DragState } from '../hooks/usePointerDrag';
import type { LayoutSnapshot } from '../hooks/useGraphLayout';
import type { ToCData } from '../types';
import { planColumnDrop } from './makeRoom';
import { computeDropCenterY } from './nodePosition';

export interface DropPreview {
  sectionIndex: number;
  columnIndex: number;
  /** Column-local centre Y the dropped node will have, after any push down. */
  centerY: number;
  /** Top-left of the copy, content space. */
  copy: { left: number; top: number };
  /** New centre Y by node id, for the target column's nodes that move. */
  shifted: Record<string, number>;
}

export interface DropPreviewArgs {
  dragState: DragState;
  snapshot: LayoutSnapshot;
  zoomScale: number;
  sections: ToCData['sections'];
  /** Measured node heights by id; the dragged node's is read as `handleDrop` reads it. */
  nodeHeights: Readonly<Record<string, number>>;
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
  sections,
  nodeHeights,
}: DropPreviewArgs): DropPreview | null {
  const target = dragState.dragOverLocation;
  if (!dragState.hasMoved || !target) return null;
  if (target.kind !== 'node-slot' && target.kind !== 'over-node') return null;

  const col = snapshot.columnRects[target.sectionIndex]?.[target.columnIndex];
  const column = sections[target.sectionIndex]?.columns[target.columnIndex];
  if (!col || !column) return null;

  const nodeHeight = nodeHeights[dragState.nodeId] || 76;
  const { droppedCenterY, shifted } = planColumnDrop({
    columnNodes: column.nodes,
    draggedId: dragState.nodeId,
    draggedHeight: nodeHeight,
    landingCenterY: computeDropCenterY({
      cursorColumnLocalY: target.yPosition,
      pointerOffsetY: dragState.pointerOffset.y,
      zoomScale,
      nodeHeight,
    }),
    nodeHeights,
  });
  return {
    sectionIndex: target.sectionIndex,
    columnIndex: target.columnIndex,
    centerY: droppedCenterY,
    copy: {
      left: (col.left + col.right) / 2 - dragState.nodeSize.width / 2,
      top: col.top + droppedCenterY - nodeHeight / 2,
    },
    shifted,
  };
}
