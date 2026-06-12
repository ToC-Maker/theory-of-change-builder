// Pure alignment math for the "Align nodes" action (PR #34 round-4
// feedback 67).
//
// Extracted from `TheoryOfChangeGraph.straightenEdges`, which previously
// built its next state through a shallow `{ ...prevData }` copy and then
// assigned into the nested `sections[i].columns[j].nodes[k]` arrays —
// mutating the PREVIOUS state object in place. App.tsx's undo history
// snapshots the previous data object (`saveToHistory(dataRef.current)`,
// App.tsx:1050) when the change notification arrives, so the in-place
// mutation meant the undo entry already carried the aligned positions:
// Ctrl+Z after "Align nodes" restored the post-alignment state — a
// visual no-op (live evidence in the round-4 report; regression tests
// in `tests/frontend/TheoryOfChangeGraph.alignment.test.tsx`).
//
// This module is PURE: it never mutates its input, and it returns the
// input `sections` array by reference when nothing needs aligning (so
// callers can cheaply detect the no-op). Grouping behavior is ported
// verbatim from the inline implementation: greedy first-fit on the
// running group average with a 40px tolerance, group average rounded.

import type { ToCData } from '../types';

type Sections = ToCData['sections'];

/** Grouping tolerance: nodes within this distance of a group's running
 * average center Y are considered "nearly aligned" with that group.
 * Shared intent with the detection in `AlignmentSuggestionBanner`. */
export const ALIGNMENT_TOLERANCE_PX = 40;

/** Fallback node height when the caller has no measured height. */
const DEFAULT_NODE_HEIGHT = 76;

/**
 * Compute the center Y the renderer would use for a node: explicit
 * `yPosition` wins; otherwise the legacy stacked default.
 */
function nodeCenterY(
  node: Sections[number]['columns'][number]['nodes'][number],
  nodeIndex: number,
  height: number,
): number {
  return node.yPosition ?? nodeIndex * 180 + 30 + height / 2;
}

/**
 * Returns a NEW sections tree in which every group of nearly-aligned
 * nodes (≥ 2 members) sits at the group's rounded average center Y.
 * Nodes that don't move keep their object identity; if NO node moves,
 * the input `sections` array itself is returned.
 *
 * `nodeHeights` maps node id → measured height (px); missing or zero
 * entries fall back to 76 (matching the renderer's fallback).
 */
export function computeAlignedSections(
  sections: Sections,
  nodeHeights: { [key: string]: number },
): Sections {
  // ---- Collect all nodes with their effective center positions. ----
  const allNodes: { id: string; centerY: number }[] = [];
  sections.forEach((section) => {
    section.columns.forEach((column) => {
      column.nodes.forEach((node, nodeIndex) => {
        const height = nodeHeights[node.id] || DEFAULT_NODE_HEIGHT;
        allNodes.push({ id: node.id, centerY: nodeCenterY(node, nodeIndex, height) });
      });
    });
  });

  // ---- Group nodes by similar center Y (greedy first-fit on the
  // running group average — ported verbatim). ----
  const groups: (typeof allNodes)[] = [];
  allNodes.forEach((nodeData) => {
    let addedToGroup = false;
    for (const group of groups) {
      const avgCenterY = group.reduce((sum, n) => sum + n.centerY, 0) / group.length;
      if (Math.abs(nodeData.centerY - avgCenterY) <= ALIGNMENT_TOLERANCE_PX) {
        group.push(nodeData);
        addedToGroup = true;
        break;
      }
    }
    if (!addedToGroup) {
      groups.push([nodeData]);
    }
  });

  // ---- Target center per node: the rounded group average, for groups
  // with at least two members. ----
  const targetCenterById = new Map<string, number>();
  groups.forEach((group) => {
    if (group.length < 2) return;
    const avgCenterY = Math.round(group.reduce((sum, n) => sum + n.centerY, 0) / group.length);
    group.forEach(({ id }) => targetCenterById.set(id, avgCenterY));
  });
  if (targetCenterById.size === 0) return sections;

  // ---- Apply immutably; preserve identity wherever nothing changed. ----
  let anyChange = false;
  const next = sections.map((section) => {
    let sectionChanged = false;
    const columns = section.columns.map((column) => {
      let columnChanged = false;
      const nodes = column.nodes.map((node) => {
        const target = targetCenterById.get(node.id);
        if (target === undefined) return node;
        columnChanged = true;
        return { ...node, yPosition: target };
      });
      if (!columnChanged) return column;
      sectionChanged = true;
      return { ...column, nodes };
    });
    if (!sectionChanged) return section;
    anyChange = true;
    return { ...section, columns };
  });
  return anyChange ? next : sections;
}
