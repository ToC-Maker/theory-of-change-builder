// Shared node-id-in-data lookup used by drag hooks for stale-node
// guards (cross-tab race aborts where a node is deleted between
// pointerdown and pointerup). Lifted from useConnectionDrag.ts +
// usePointerDrag.ts where the same body was duplicated verbatim.

import type { ToCData } from '../types';

/**
 * Walk sections × columns × nodes and return true iff a node with the
 * given id exists in `data`. O(N) where N = total node count; cheap
 * relative to a typical render.
 */
export function nodeExistsInData(data: ToCData, nodeId: string): boolean {
  for (const section of data.sections) {
    for (const column of section.columns) {
      for (const node of column.nodes) {
        if (node.id === nodeId) return true;
      }
    }
  }
  return false;
}
