// Node and column widths, in content pixels.
//
// One width is a node's default, the width of a node you add and the width
// of an empty column, so adding the first node to a new column or section
// does not widen it.

/** Width of a node that has none of its own (Tailwind `w-48`). */
export const DEFAULT_NODE_WIDTH = 192;

/** A column with nodes is never narrower than this, whatever its nodes' widths. */
export const MIN_COLUMN_WIDTH = 128;

/** Width of a column: its widest node, at least MIN_COLUMN_WIDTH; an empty one is a new node wide. */
export function columnWidth(nodes: readonly { width?: number }[]): number {
  if (nodes.length === 0) return DEFAULT_NODE_WIDTH;
  return Math.max(...nodes.map((node) => node.width || DEFAULT_NODE_WIDTH), MIN_COLUMN_WIDTH);
}
