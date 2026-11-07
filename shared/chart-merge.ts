/**
 * Field-level three-way merge of Theory of Change charts, shared by the client
 * and the Worker.
 *
 * Consumed by:
 *  - the client, to fold another editor's chart into the local one (a 409, a
 *    poll landing) with `onConflict: 'mine'`, to replay an AI edit computed
 *    against the chart as sent (that chart is `base`), and to undo or redo in
 *    revert form (`mergeCharts(after, before, current, { onConflict: 'theirs' })`),
 *    compiled under `tsconfig.app.json`;
 *  - the Worker, once saves merge on the server, compiled under
 *    `worker/tsconfig.json`.
 *
 * It therefore touches neither the DOM nor Workers-only types, and imports
 * only `./chart-model`. Inputs are normalised charts (`normalizeChart`).
 *
 * `mergeCharts(base, mine, theirs, { onConflict })` applies what each side
 * changed since `base`. Each chart is flattened once into records keyed by
 * id: chart meta (every top-level key but `sections`), sections, columns,
 * nodes (a node's `[columnId, yPosition]` is one atomic `pos` field) and
 * connections (keyed by source and target; `waypoints` is one atomic value).
 * Fields no rule mentions, unknown ones included, merge like any other.
 *
 * 1. A field changed on one side takes that side's value; changed on both,
 *    `onConflict` decides ('mine': the save that lands last; 'theirs': undo
 *    and redo, which yield to whoever changed the field since). Same-field
 *    prose (`text`, `evidence`, `assumptions`) is whole-value, not line-merged.
 *    Equality ignores key order and treats an absent key as `undefined`.
 * 2. A record on both sides merges field by field; on one side only, absent
 *    from `base`, it is an add and is kept. A record both sides added merges
 *    against an empty base: a field only one side set is kept, and one both
 *    set differently goes to `onConflict`.
 * 3. A record deleted on one side and present on the other survives only if
 *    the survivor changed a content field relative to `base` (node `title`,
 *    `text`; connection `evidence`, `assumptions`). A move, resize, recolour,
 *    confidence change, waypoint change or unknown field loses to the delete.
 *    With `onConflict: 'theirs'` a delete by theirs always stands.
 * 4. A connection that survives by content under rule 3, or that one side
 *    added with non-empty `evidence` or `assumptions`, keeps both end nodes:
 *    an end node rule 3 would drop survives with the record of the side that
 *    still had it. With `onConflict: 'theirs'` it does so only when both end
 *    nodes exist in theirs.
 * 5. A connection survives only if both end nodes do. A connection whose
 *    target is not a node of the same chart counts as absent: the app's
 *    column and section deletes leave such connections behind.
 * 6. A column deleted by either side survives only if a surviving node's `pos`
 *    points at it; a section deleted by either side survives only if a
 *    surviving column belongs to it (so a rename loses to the delete).
 * 7. Every list (the sections, a section's columns, a column's nodes, a
 *    node's connections) is theirs' order minus what is gone, then mine's new
 *    items, each after its nearest surviving left neighbour in mine, or first
 *    when it has none. A reorder by mine is therefore lost whenever theirs
 *    changed anything; nothing reorders sections, columns or nodes today.
 * 8. The result is rebuilt as a normalised chart: `connectionIds` from
 *    `connections`, `yPosition` from `pos`, no keys holding `undefined`.
 * 9. If theirs equals base the result is `mine` itself, and if mine equals
 *    base it is `theirs` itself (same object, no rebuild).
 *
 * Pure: never mutates its inputs. It throws only on a section, column or node
 * id that repeats within a chart, which `normalizeChart` rules out, and, while
 * the types still allow it, on a section or column without an id (`idOf`).
 */
import {
  deepEqual,
  idOf,
  type Connection,
  type Node,
  type Section,
  type ToCData,
} from './chart-model';

export type ConflictWinner = 'mine' | 'theirs';

type Fields = Record<string, unknown>;

interface Rec {
  fields: Fields;
}

/** A record with an ordered list of children, in the order this chart has them. */
interface Parent extends Rec {
  kids: string[];
}

interface ConnectionRecord extends Rec {
  source: string;
  target: string;
}

interface Flat {
  meta: Fields;
  sectionOrder: string[];
  sections: Map<string, Parent>; // kids: column ids
  columns: Map<string, Parent>; // kids: node ids
  nodes: Map<string, Parent>; // kids: connection target ids
  connections: Map<string, ConnectionRecord>;
}

type Kind = 'sections' | 'columns' | 'nodes';

// Structural facts stored beside a record's own fields so they merge like any
// field; the NUL prefix keeps them from colliding with a stored key.
const POS = '\u0000pos'; // node: [columnId, yPosition]
const SECTION = '\u0000section'; // column: id of its section

const NODE_CONTENT = ['title', 'text'] as const;
const CONNECTION_CONTENT = ['evidence', 'assumptions'] as const;

const connectionKey = (source: string, target: string) => `${source}\u0000${target}`;
const hasContent = (value: unknown) => value !== undefined && value !== null && value !== '';
const columnOf = (nodeFields: Fields) => (nodeFields[POS] as [string, number | undefined])[0];

/** The own entries of `source` except `dropped` and those holding `undefined`. */
function omit(source: object, dropped: readonly string[]): Fields {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => value !== undefined && !dropped.includes(key)),
  );
}

function register<T>(map: Map<string, T>, kind: string, id: string, record: T): void {
  if (map.has(id)) throw new Error(`Chart repeats ${kind} id ${id}`);
  map.set(id, record);
}

function flatten(chart: ToCData): Flat {
  const flat: Flat = {
    meta: omit(chart, ['sections']),
    sectionOrder: [],
    sections: new Map(),
    columns: new Map(),
    nodes: new Map(),
    connections: new Map(),
  };
  const nodes: Node[] = [];
  for (const section of chart.sections) {
    const sectionId = idOf(section);
    flat.sectionOrder.push(sectionId);
    register(flat.sections, 'section', sectionId, {
      fields: omit(section, ['id', 'columns']),
      kids: section.columns.map(idOf),
    });
    for (const column of section.columns) {
      const columnId = idOf(column);
      register(flat.columns, 'column', columnId, {
        fields: { ...omit(column, ['id', 'nodes']), [SECTION]: sectionId },
        kids: column.nodes.map((n) => n.id),
      });
      for (const node of column.nodes) {
        register(flat.nodes, 'node', node.id, {
          fields: {
            ...omit(node, ['id', 'connections', 'connectionIds', 'yPosition']),
            [POS]: [columnId, node.yPosition],
          },
          kids: [],
        });
        nodes.push(node);
      }
    }
  }
  // Once every node is known, so a connection to a node this chart lacks is skipped.
  for (const node of nodes) {
    for (const connection of node.connections ?? []) {
      const key = connectionKey(node.id, connection.targetId);
      if (!flat.nodes.has(connection.targetId)) continue;
      flat.connections.set(key, {
        source: node.id,
        target: connection.targetId,
        fields: omit(connection, ['targetId']),
      });
      flat.nodes.get(node.id)!.kids.push(connection.targetId);
    }
  }
  return flat;
}

function mergeField(
  base: unknown,
  mine: unknown,
  theirs: unknown,
  winner: ConflictWinner,
): unknown {
  if (deepEqual(mine, base)) return theirs;
  if (deepEqual(theirs, base)) return mine;
  return winner === 'mine' ? mine : theirs;
}

// Own keys only: a field named `constructor` or `toString` must not read as Object's.
const own = (fields: Fields, key: string): unknown =>
  Object.hasOwn(fields, key) ? fields[key] : undefined;

function mergeFields(base: Fields, mine: Fields, theirs: Fields, winner: ConflictWinner): Fields {
  const entries: [string, unknown][] = [];
  for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const value = mergeField(own(base, key), own(mine, key), own(theirs, key), winner);
    if (value !== undefined) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

/**
 * Field-merges a record that exists on at least one side. With a base, a side
 * that deleted the record stands in as the base, leaving the other side's
 * changes whole. Without one (an add), the base is empty: a field only one
 * side set is kept, and one both set differently goes to `onConflict`.
 */
function mergeRecord(
  base: Rec | undefined,
  mine: Rec | undefined,
  theirs: Rec | undefined,
  winner: ConflictWinner,
): Fields {
  if (!base) return mergeFields({}, mine?.fields ?? {}, theirs?.fields ?? {}, winner);
  return mergeFields(base.fields, (mine ?? base).fields, (theirs ?? base).fields, winner);
}

type Fate = 'both' | 'added' | 'edited' | 'gone';

/**
 * What the add and delete rules (2 and 3) make of a node or connection, before pinning (4), the
 * rule that a connection needs both end nodes (5) and the container rules (6).
 */
function fateOf(
  base: Rec | undefined,
  mine: Rec | undefined,
  theirs: Rec | undefined,
  content: readonly string[],
  winner: ConflictWinner,
): Fate {
  if (mine && theirs) return 'both';
  const survivor = mine ?? theirs;
  if (!survivor) return 'gone';
  if (!base) return 'added';
  // Undo and redo must not bring back what a collaborator deleted.
  if (winner === 'theirs' && mine) return 'gone';
  return content.some((key) => !deepEqual(base.fields[key], survivor.fields[key]))
    ? 'edited'
    : 'gone';
}

function mergeOrder(mine: string[], theirs: string[], members: string[]): string[] {
  const alive = new Set(members);
  const out = theirs.filter((id) => alive.has(id));
  mine.forEach((id, i) => {
    if (!alive.has(id) || out.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const left = out.indexOf(mine[j]);
      if (left >= 0) {
        at = left + 1;
        break;
      }
    }
    out.splice(at, 0, id);
  });
  return out;
}

function groupBy(pairs: [child: string, parent: string][]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [child, parent] of pairs) {
    const group = groups.get(parent);
    if (group) group.push(child);
    else groups.set(parent, [child]);
  }
  return groups;
}

export function mergeCharts(
  base: ToCData,
  mine: ToCData,
  theirs: ToCData,
  opts: { onConflict: ConflictWinner },
): ToCData {
  const winner = opts.onConflict;
  if (deepEqual(theirs, base)) return mine;
  if (deepEqual(mine, base)) return theirs;

  const b = flatten(base);
  const m = flatten(mine);
  const t = flatten(theirs);
  const idsOf = (kind: Kind | 'connections') =>
    new Set([...b[kind].keys(), ...m[kind].keys(), ...t[kind].keys()]);

  const nodes = new Map<string, Fields>();
  for (const id of idsOf('nodes')) {
    const [bn, mn, tn] = [b.nodes.get(id), m.nodes.get(id), t.nodes.get(id)];
    if (fateOf(bn, mn, tn, NODE_CONTENT, winner) !== 'gone') {
      nodes.set(id, mergeRecord(bn, mn, tn, winner));
    }
  }

  const connections = new Map<string, ConnectionRecord>();
  const kept: string[] = []; // end nodes of connections that survive by content
  for (const key of idsOf('connections')) {
    const [bc, mc, tc] = [b.connections.get(key), m.connections.get(key), t.connections.get(key)];
    const survivor = mc ?? tc;
    const fate = fateOf(bc, mc, tc, CONNECTION_CONTENT, winner);
    if (!survivor || fate === 'gone') continue;
    const { source, target } = survivor;
    connections.set(key, { source, target, fields: mergeRecord(bc, mc, tc, winner) });
    const byContent =
      fate === 'edited' ||
      (fate === 'added' && CONNECTION_CONTENT.some((field) => hasContent(survivor.fields[field])));
    if (byContent && (winner === 'mine' || (t.nodes.has(source) && t.nodes.has(target)))) {
      kept.push(source, target);
    }
  }
  for (const id of kept) {
    if (!nodes.has(id)) nodes.set(id, (m.nodes.get(id) ?? t.nodes.get(id))!.fields);
  }
  for (const [key, { source, target }] of connections) {
    if (!nodes.has(source) || !nodes.has(target)) connections.delete(key);
  }

  const mergeContainers = (kind: 'sections' | 'columns', needed: Set<string>) => {
    const merged = new Map<string, Fields>();
    for (const id of idsOf(kind)) {
      const [bc, mc, tc] = [b[kind].get(id), m[kind].get(id), t[kind].get(id)];
      const deleted = bc !== undefined && (mc === undefined || tc === undefined);
      if (!deleted || needed.has(id)) merged.set(id, mergeRecord(bc, mc, tc, winner));
    }
    return merged;
  };
  const columns = mergeContainers('columns', new Set([...nodes.values()].map(columnOf)));
  const sectionOf = (columnFields: Fields) => columnFields[SECTION] as string;
  const sections = mergeContainers('sections', new Set([...columns.values()].map(sectionOf)));

  const nodesByColumn = groupBy([...nodes].map(([id, fields]) => [id, columnOf(fields)]));
  const columnsBySection = groupBy([...columns].map(([id, fields]) => [id, sectionOf(fields)]));
  const targetsBySource = groupBy([...connections.values()].map((c) => [c.target, c.source]));
  const kidsOf = (kind: Kind, parentId: string, groups: Map<string, string[]>) =>
    mergeOrder(
      m[kind].get(parentId)?.kids ?? [],
      t[kind].get(parentId)?.kids ?? [],
      groups.get(parentId) ?? [],
    );

  const buildNode = (id: string, fields: Fields): Node => {
    const nodeConnections = kidsOf('nodes', id, targetsBySource).map(
      (target) =>
        ({ ...connections.get(connectionKey(id, target))!.fields, targetId: target }) as Connection,
    );
    const y = (fields[POS] as [string, number | undefined])[1];
    return {
      ...omit(fields, [POS]),
      id,
      ...(y === undefined ? {} : { yPosition: y }),
      connections: nodeConnections,
      connectionIds: nodeConnections.map((c) => c.targetId),
    } as Node;
  };

  const sectionList = mergeOrder(m.sectionOrder, t.sectionOrder, [...sections.keys()]).map(
    (sectionId) =>
      ({
        ...sections.get(sectionId),
        id: sectionId,
        columns: kidsOf('sections', sectionId, columnsBySection).map((columnId) => ({
          ...omit(columns.get(columnId)!, [SECTION]),
          id: columnId,
          nodes: kidsOf('columns', columnId, nodesByColumn).map((nodeId) =>
            buildNode(nodeId, nodes.get(nodeId)!),
          ),
        })),
      }) as Section,
  );

  return { ...mergeFields(b.meta, m.meta, t.meta, winner), sections: sectionList } as ToCData;
}
