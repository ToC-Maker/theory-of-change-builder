// Make-room maths for dropping a node into a column that already holds
// others. Given where the dropped node's box lands, it works out the
// vertical shifts that keep every node of the column clear of it, so the
// live drag preview and the drop commit share one answer and cannot
// disagree.
//
// Rules:
//   - Only the target column's nodes move, and only vertically; they keep
//     their order.
//   - Nodes whose centre is at or below the dropped centre move down, the
//     others up, each just far enough to leave `gap` between boxes. A node
//     moves only when it is closer than `gap` to the dropped box or to the
//     node before it in the cascade, as that one now sits; nodes that clear
//     it stay where they are.
//   - Upward moves stop at the top of the column (a box may not rise above
//     y = 0, the clamp `clampNodeCenterY` applies). When the nodes above
//     cannot fit even then, the dropped node moves down by the shortfall
//     and the downward cascade starts from there.
import type { Node } from '../types';
import { resolveNodeCenterY } from './nodePosition';

/**
 * Minimum space kept between stacked node boxes, in column-content px.
 * The canvas has no minimum spacing of its own: double-click adds a node
 * at the click, the arrow keys move in 20px steps, and unpositioned nodes
 * stack 180px top to top. So 16px is chosen here.
 */
export const MAKE_ROOM_GAP_PX = 16;

export interface MakeRoomNode {
  id: string;
  /** Centre Y as the node renders, column-local px. */
  centerY: number;
  height: number;
}

export interface MakeRoomArgs {
  /** Centre Y where the dropped node's box lands (already clamped). */
  droppedCenterY: number;
  droppedHeight: number;
  /** The column's nodes, without the dropped one. */
  nodes: readonly MakeRoomNode[];
  gap?: number;
}

export interface MakeRoomResult {
  /** Where the dropped node ends up: the requested centre, or lower when pushed. */
  droppedCenterY: number;
  /** New centre Y by node id, for the nodes that moved only. */
  shifted: Record<string, number>;
}

/**
 * Shifts nodes away from `droppedTop` toward the top of the column.
 * Returns each moved node's new centre and the highest top edge reached
 * (negative when the stack does not fit).
 */
function cascadeUp(
  above: readonly MakeRoomNode[],
  droppedTop: number,
  gap: number,
): { moved: Record<string, number>; minTop: number } {
  const moved: Record<string, number> = {};
  let minTop = Infinity;
  let ceiling = droppedTop - gap;
  for (let i = above.length - 1; i >= 0; i--) {
    const { id, centerY, height } = above[i];
    if (centerY + height / 2 <= ceiling) continue;
    const top = ceiling - height;
    moved[id] = top + height / 2;
    minTop = Math.min(minTop, top);
    ceiling = top - gap;
  }
  return { moved, minTop };
}

export function computeMakeRoom({
  droppedCenterY,
  droppedHeight,
  nodes,
  gap = MAKE_ROOM_GAP_PX,
}: MakeRoomArgs): MakeRoomResult {
  const sorted = nodes
    .map((node, order) => ({ node, order }))
    .sort((a, b) => a.node.centerY - b.node.centerY || a.order - b.order)
    .map(({ node }) => node);
  const above = sorted.filter((node) => node.centerY < droppedCenterY);
  const below = sorted.filter((node) => node.centerY >= droppedCenterY);

  let landingCenterY = droppedCenterY;
  let up = cascadeUp(above, landingCenterY - droppedHeight / 2, gap);
  while (up.minTop < 0) {
    landingCenterY -= up.minTop;
    up = cascadeUp(above, landingCenterY - droppedHeight / 2, gap);
  }

  const shifted: Record<string, number> = { ...up.moved };
  let floor = landingCenterY + droppedHeight / 2 + gap;
  for (const { id, centerY, height } of below) {
    if (centerY - height / 2 >= floor) continue;
    shifted[id] = floor + height / 2;
    floor += height + gap;
  }
  return { droppedCenterY: landingCenterY, shifted };
}

export interface PlanColumnDropArgs {
  /** The target column's nodes in stored order (the dragged one may be among them). */
  columnNodes: readonly Node[];
  draggedId: string;
  draggedHeight: number;
  /** Where the dragged node's box lands: `computeDropCenterY`'s result. */
  landingCenterY: number;
  /** Measured heights by node id; unmeasured nodes count as 76px, like the renderer. */
  nodeHeights: Readonly<Record<string, number>>;
}

/**
 * `computeMakeRoom` for a column of stored nodes: reads each at the
 * centre it renders and leaves the dragged node's own slot out, so a
 * drag within a column is not blocked by where the node came from.
 */
export function planColumnDrop({
  columnNodes,
  draggedId,
  draggedHeight,
  landingCenterY,
  nodeHeights,
}: PlanColumnDropArgs): MakeRoomResult {
  const nodes: MakeRoomNode[] = [];
  columnNodes.forEach((node, index) => {
    if (node.id === draggedId) return;
    const height = nodeHeights[node.id] || 76;
    nodes.push({ id: node.id, height, centerY: resolveNodeCenterY(node.yPosition, index, height) });
  });
  return computeMakeRoom({ droppedCenterY: landingCenterY, droppedHeight: draggedHeight, nodes });
}
