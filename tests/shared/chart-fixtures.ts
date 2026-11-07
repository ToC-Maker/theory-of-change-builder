// Chart fixtures and the edits the app makes, shared by the merge tests. Every
// chart goes through `normalizeChart`, so connection ids stay consistent with
// the connections and nothing here depends on how the merge builds its output.
import {
  normalizeChart,
  type Column,
  type Connection,
  type Node,
  type ToCData,
} from '../../shared/chart-model';

export function node(id: string, y = 100, extra: Record<string, unknown> = {}): Node {
  return {
    id,
    title: id.toUpperCase(),
    text: `${id} body`,
    width: 192,
    color: '#fff',
    yPosition: y,
    connectionIds: [],
    connections: [],
    ...extra,
  };
}

/** Two sections with two columns each; nodes a, b | c in the first, d | nothing in the second. */
export function seedChart(): ToCData {
  return normalizeChart({
    title: 'T',
    curvature: 0.5,
    sections: [
      {
        id: 's1',
        title: 'One',
        columns: [
          { id: 'c1', nodes: [node('a'), node('b', 300)] },
          { id: 'c2', nodes: [node('c')] },
        ],
      },
      {
        id: 's2',
        title: 'Two',
        columns: [
          { id: 'c3', nodes: [node('d')] },
          { id: 'c4', nodes: [] },
        ],
      },
    ],
  });
}

/** `seedChart` with the connection a -> c at confidence 75. */
export function connectedChart(): ToCData {
  return edit(seedChart(), (draft) => addConnection(draft, 'a', 'c', { confidence: 75 }));
}

/** Applies `mutate` to a copy of `chart` and normalises the result. */
export function edit(chart: ToCData, mutate: (draft: ToCData) => void): ToCData {
  const draft = structuredClone(chart);
  mutate(draft);
  return normalizeChart(draft);
}

export const columnsOf = (chart: ToCData): Column[] => chart.sections.flatMap((s) => s.columns);
export const nodesOf = (chart: ToCData): Node[] => columnsOf(chart).flatMap((c) => c.nodes);
export const findNode = (chart: ToCData, id: string): Node | undefined =>
  nodesOf(chart).find((n) => n.id === id);
export const hasNode = (chart: ToCData, id: string): boolean => findNode(chart, id) !== undefined;
export const connectionOf = (chart: ToCData, from: string, to: string): Connection | undefined =>
  findNode(chart, from)?.connections?.find((c) => c.targetId === to);

/** The node in `draft`; throws when a test names one that is not there. */
export function nodeIn(draft: ToCData, id: string): Node {
  const found = findNode(draft, id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

export function columnIn(draft: ToCData, id: string): Column {
  const found = columnsOf(draft).find((c) => c.id === id);
  if (!found) throw new Error(`no column ${id}`);
  return found;
}

export function addConnection(
  draft: ToCData,
  from: string,
  to: string,
  props: Partial<Connection> = {},
): void {
  const source = nodeIn(draft, from);
  (source.connections ??= []).push({ targetId: to, confidence: 50, ...props });
}

/** Deletes a node; `cleanup` also drops the connections that pointed at it, as the app's node delete does. */
export function removeNode(draft: ToCData, id: string, cleanup = true): void {
  for (const column of columnsOf(draft)) column.nodes = column.nodes.filter((n) => n.id !== id);
  if (!cleanup) return;
  for (const n of nodesOf(draft)) {
    n.connections = n.connections?.filter((c) => c.targetId !== id);
  }
}

/** The app's column delete: its nodes go, connections to them stay behind, and an emptied section collapses. */
export function removeColumn(draft: ToCData, columnId: string): void {
  for (const section of draft.sections) {
    section.columns = section.columns.filter((c) => c.id !== columnId);
  }
  draft.sections = draft.sections.filter((s) => s.columns.length > 0);
}

/** The app's section delete: its nodes go, connections to them stay behind. */
export function removeSection(draft: ToCData, sectionId: string): void {
  draft.sections = draft.sections.filter((s) => s.id !== sectionId);
}

/** Moves a node to the end of another column; connections stay as they are. */
export function moveNode(draft: ToCData, id: string, columnId: string, y: number): void {
  const moved = nodeIn(draft, id);
  removeNode(draft, id, false);
  moved.yPosition = y;
  columnIn(draft, columnId).nodes.push(moved);
}
