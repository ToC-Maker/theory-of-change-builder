/**
 * Makes an AI reply's chart safe to merge into the current one.
 *
 * The model sees the chart without section and column ids (`addNodePaths`) and
 * answers with edits by index path, so what it returns can lack ids, and the
 * node ids it invents repeat from one reply to the next. Two replies that both
 * add `new-node-id`, or both add a section at the same index, would otherwise
 * collide once merged into the same chart. The prepared result goes to
 * `ChartDocument.applyRebased(asSent, prepared)`.
 */
import {
  assertChartShape,
  newColumnId,
  newNodeId,
  newSectionId,
  normalizeChart,
  type ChartInput,
  type Node,
  type ToCData,
} from '../../shared/chart-model';

/**
 * `asSent` is the chart the reply was computed from; `result` is that chart
 * with the reply's edits applied. Node ids `asSent` did not have, and every
 * repeat of an id within `result`, are replaced by fresh ones, with connection
 * targets following; sections and columns without an id get random ones.
 * Throws `ChartShapeError` when `result` is not a chart. Ends in
 * `normalizeChart`: `graphEdits` fills `connections` only for inserted and
 * pushed nodes, so a node the reply rewrote whole may list `connectionIds`
 * only, which the merge would read as all of its edges deleted.
 */
export function prepareAIResult(asSent: ToCData, result: ChartInput): ToCData {
  // Model output: nothing has checked that it is a chart, and it is walked below.
  assertChartShape(result);
  const known = new Set(
    asSent.sections.flatMap((s) => s.columns.flatMap((c) => c.nodes.map((n) => n.id))),
  );
  const kept = new Set<string>();
  // The reply's own id for a node it created, to the id that node now has.
  const minted = new Map<string, string>();

  const retarget = (id: string) => minted.get(id) ?? id;
  const claim = (node: Node): string => {
    const given = typeof node.id === 'string' ? node.id : undefined;
    if (given !== undefined && known.has(given) && !kept.has(given)) {
      kept.add(given);
      return given;
    }
    const id = newNodeId();
    // Its own connections mean the first node it gave an id to; a repeat is just a new node.
    if (given !== undefined && !known.has(given) && !minted.has(given)) minted.set(given, id);
    return id;
  };

  // Ids first, so that a connection to a node created later in the reply follows it.
  const ids = new Map<Node, string>();
  for (const section of result.sections) {
    for (const column of section.columns) {
      for (const node of column.nodes) ids.set(node, claim(node));
    }
  }

  return normalizeChart({
    ...result,
    sections: result.sections.map((section) => ({
      ...section,
      id: section.id ?? newSectionId(),
      columns: section.columns.map((column) => ({
        ...column,
        id: column.id ?? newColumnId(),
        nodes: column.nodes.map((node) => ({
          ...node,
          id: ids.get(node),
          ...(Array.isArray(node.connections) && {
            connections: node.connections.map((c) => ({ ...c, targetId: retarget(c.targetId) })),
          }),
          connectionIds: Array.isArray(node.connectionIds) ? node.connectionIds.map(retarget) : [],
        })),
      })),
    })),
  });
}
