// Three clients edit one chart through a compare-and-swap server, with optimistic local
// edits, stale-base saves that merge on conflict, polls that merge into unsaved edits, and
// undo and redo in revert form. A violation reports the seed; `simulate(seed)` replays it.
import { describe, expect, it } from 'vitest';
import { mergeCharts, type ConflictWinner } from '../../shared/chart-merge';
import {
  deepEqual,
  idOf,
  normalizeChart,
  type Connection,
  type Node,
  type ToCData,
} from '../../shared/chart-model';
import { deepFreeze } from '../frontend/helpers/deepFreeze';
import {
  addConnection,
  columnsOf,
  connectedChart,
  edit,
  moveNode,
  node,
  nodesOf,
  removeColumn,
  removeNode,
  removeSection,
} from './chart-fixtures';

const RUNS = 500;
const STEPS = 60;
// About 4 s when the box is idle; the default 5 s limit is too close under load.
const TIMEOUT_MS = 60_000;

type Rng = (n: number) => number;

function rng(seed: number): Rng {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

const stats = { merges: 0, undoMerges: 0, mergesWithDanglingInput: 0 };

const connectionsOf = (chart: ToCData) =>
  nodesOf(chart).flatMap((n) => (n.connections ?? []).map((c) => ({ source: n, connection: c })));

function hasDanglingConnection(chart: ToCData): boolean {
  const ids = new Set(nodesOf(chart).map((n) => n.id));
  return connectionsOf(chart).some(({ connection }) => !ids.has(connection.targetId));
}

/** What the oracle tracks: the nodes, and the connections to nodes the chart has, by `source>target`. */
function trackedEntities(chart: ToCData): Map<string, Node | Connection> {
  const ids = new Set(nodesOf(chart).map((n) => n.id));
  const entities = new Map<string, Node | Connection>(nodesOf(chart).map((n) => [n.id, n]));
  for (const { source, connection } of connectionsOf(chart)) {
    if (ids.has(connection.targetId))
      entities.set(`${source.id}>${connection.targetId}`, connection);
  }
  return entities;
}

const TRACKED_FIELDS = ['title', 'text', 'evidence', 'assumptions'] as const;
const fieldOf = (entity: Node | Connection, field: (typeof TRACKED_FIELDS)[number]): unknown =>
  (entity as unknown as Record<string, unknown>)[field];

function assertUniqueIds(chart: ToCData, where: string): void {
  const lists = {
    section: chart.sections.map((s) => s.id),
    column: columnsOf(chart).map((c) => c.id),
    node: nodesOf(chart).map((n) => n.id),
  };
  for (const [kind, ids] of Object.entries(lists)) {
    if (new Set(ids).size !== ids.length) throw new Error(`${where}: duplicate ${kind} id`);
  }
}

/**
 * Sections, columns and nodes that both sides have, or that one side added, are never
 * deleted by the merge: no delete rule applies to them.
 */
function assertNothingDropped(base: ToCData, mine: ToCData, theirs: ToCData, out: ToCData): void {
  const idLists = (chart: ToCData) => ({
    section: new Set(chart.sections.map(idOf)),
    column: new Set(columnsOf(chart).map(idOf)),
    node: new Set(nodesOf(chart).map((n) => n.id)),
  });
  const [b, m, t, o] = [base, mine, theirs, out].map(idLists);
  for (const kind of ['section', 'column', 'node'] as const) {
    for (const id of new Set([...m[kind], ...t[kind]])) {
      const keptByRule = (m[kind].has(id) && t[kind].has(id)) || !b[kind].has(id);
      if (keptByRule && !o[kind].has(id)) throw new Error(`merge dropped ${kind} ${id}`);
    }
  }
}

/**
 * A section or column that either side no longer has, though the base did, survives only as
 * the home of something that survives: a column of a node, a section of a column.
 */
function assertDeletedContainersStayDeleted(
  base: ToCData,
  mine: ToCData,
  theirs: ToCData,
  out: ToCData,
): void {
  const deletedBySomeone = (kind: 'section' | 'column', id: string) => {
    const ids = (chart: ToCData) =>
      new Set(kind === 'section' ? chart.sections.map(idOf) : columnsOf(chart).map(idOf));
    return ids(base).has(id) && !(ids(mine).has(id) && ids(theirs).has(id));
  };
  for (const section of out.sections) {
    if (deletedBySomeone('section', idOf(section)) && section.columns.length === 0) {
      throw new Error(`merge kept deleted section ${section.id} with nothing in it`);
    }
    for (const column of section.columns) {
      if (deletedBySomeone('column', idOf(column)) && column.nodes.length === 0) {
        throw new Error(`merge kept deleted column ${column.id} with nothing in it`);
      }
    }
  }
}

type Fields = Record<string, unknown>;

interface Records {
  meta: Fields;
  sections: Map<string, Fields>;
  columns: Map<string, Fields>;
  nodes: Map<string, Fields>;
  connections: Map<string, Fields>;
}

const without = (source: object, keys: string[]): Fields =>
  Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));

/**
 * A chart as records of fields, read straight from its shape: where a node sits (column and
 * `yPosition`) and which section a column is in count as one field each, and a connection to
 * a node the chart lacks is left out.
 */
function recordsOf(chart: ToCData): Records {
  const nodeIds = new Set(nodesOf(chart).map((n) => n.id));
  const records: Records = {
    meta: without(chart, ['sections']),
    sections: new Map(),
    columns: new Map(),
    nodes: new Map(),
    connections: new Map(),
  };
  for (const section of chart.sections) {
    records.sections.set(idOf(section), without(section, ['id', 'columns']));
    for (const column of section.columns) {
      records.columns.set(idOf(column), {
        ...without(column, ['id', 'nodes']),
        section: idOf(section),
      });
      for (const n of column.nodes) {
        records.nodes.set(n.id, {
          ...without(n, ['id', 'connections', 'connectionIds', 'yPosition']),
          position: [idOf(column), n.yPosition],
        });
        for (const c of n.connections ?? []) {
          if (nodeIds.has(c.targetId)) {
            records.connections.set(`${n.id}>${c.targetId}`, without(c, ['targetId']));
          }
        }
      }
    }
  }
  return records;
}

/**
 * Every field of every record in the result is what the field rule gives: a side that left a
 * field as it was in the base takes the other side's value, otherwise a value both sides
 * agree on, otherwise the `onConflict` side's. A record only one side has comes through as
 * that side has it; one both sides added is merged against an empty base.
 */
function assertFieldsFollowFieldRule(
  base: ToCData,
  mine: ToCData,
  theirs: ToCData,
  out: ToCData,
  onConflict: ConflictWinner,
): void {
  const [b, m, t, o] = [base, mine, theirs, out].map(recordsOf);
  const ruled = (inBase: unknown, inMine: unknown, inTheirs: unknown): unknown => {
    if (deepEqual(inMine, inBase)) return inTheirs;
    if (deepEqual(inTheirs, inBase) || deepEqual(inMine, inTheirs)) return inMine;
    return onConflict === 'mine' ? inMine : inTheirs;
  };
  const merged = (inBase: Fields, inMine: Fields, inTheirs: Fields): Fields =>
    Object.fromEntries(
      [...new Set([...Object.keys(inMine), ...Object.keys(inTheirs)])].map((key) => [
        key,
        ruled(inBase[key], inMine[key], inTheirs[key]),
      ]),
    );
  const check = (what: string, actual: Fields, expected: Fields) => {
    for (const key of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
      if (!deepEqual(actual[key], expected[key])) {
        throw new Error(
          `${what}, field ${key}: merged ${JSON.stringify(actual[key])}, rules give ${JSON.stringify(expected[key])}`,
        );
      }
    }
  };
  check('chart', o.meta, merged(b.meta, m.meta, t.meta));
  for (const kind of ['sections', 'columns', 'nodes', 'connections'] as const) {
    for (const [id, actual] of o[kind]) {
      const inMine = m[kind].get(id);
      const inTheirs = t[kind].get(id);
      const survivor = inMine ?? inTheirs;
      if (!survivor) throw new Error(`${kind} ${id} is in the result but in neither input`);
      const expected =
        inMine && inTheirs ? merged(b[kind].get(id) ?? {}, inMine, inTheirs) : survivor;
      check(`${kind} ${id}`, actual, expected);
    }
  }
}

/** Each parent's children in order: sections, a section's columns, a column's nodes, a node's targets. */
function childLists(chart: ToCData): Map<string, string[]> {
  const nodeIds = new Set(nodesOf(chart).map((n) => n.id));
  const lists = new Map([['sections', chart.sections.map(idOf)]]);
  for (const section of chart.sections) {
    lists.set(`columns of ${section.id}`, section.columns.map(idOf));
    for (const column of section.columns) {
      lists.set(
        `nodes of ${column.id}`,
        column.nodes.map((n) => n.id),
      );
      for (const n of column.nodes) {
        const targets = (n.connections ?? [])
          .map((c) => c.targetId)
          .filter((id) => nodeIds.has(id));
        lists.set(`connections of ${n.id}`, targets);
      }
    }
  }
  return lists;
}

/**
 * In every list of the result, what theirs lists keeps theirs' order, and an item theirs does
 * not list (mine's) follows its nearest left neighbour in mine's list that is also in the
 * result, or comes first when it has none.
 */
function assertOrder(mine: ToCData, theirs: ToCData, out: ToCData): void {
  const [m, t, o] = [mine, theirs, out].map(childLists);
  for (const [parent, outList] of o) {
    const theirList = t.get(parent) ?? [];
    const mineList = m.get(parent) ?? [];
    const inOut = new Set(outList);
    const inTheirs = new Set(theirList);
    const kept = theirList.filter((id) => inOut.has(id));
    const keptInOut = outList.filter((id) => inTheirs.has(id));
    if (kept.join() !== keptInOut.join()) throw new Error(`${parent}: theirs' order not kept`);
    outList.forEach((id, i) => {
      if (inTheirs.has(id)) return;
      const at = mineList.indexOf(id);
      if (at < 0) throw new Error(`${parent}: ${id} is in neither input's list`);
      const left = mineList
        .slice(0, at)
        .reverse()
        .find((other) => inOut.has(other));
      const expected = left === undefined ? 0 : outList.indexOf(left) + 1;
      if (i !== expected) throw new Error(`${parent}: ${id} at ${i}, expected at ${expected}`);
    });
  }
}

/**
 * One of the edits the editor makes, applied to a draft. Column and section deletes leave
 * connections to the removed nodes behind, as the app's deletes do today.
 */
function randomEdit(draft: ToCData, r: Rng, next: () => number): void {
  const columns = columnsOf(draft);
  const nodes = nodesOf(draft);
  const connections = connectionsOf(draft);
  const pick = <T>(items: T[]): T | undefined => items[r(items.length)];
  switch (r(22)) {
    case 0: {
      const n = pick(nodes);
      if (n) n.title = `title ${next()}`;
      break;
    }
    case 1: {
      const n = pick(nodes);
      if (n) n.text = `text ${next()}`;
      break;
    }
    case 2: {
      const n = pick(nodes);
      if (n) n.color = `#${next()}`;
      break;
    }
    case 3: {
      const n = pick(nodes);
      if (n && nodes.length > 2) removeNode(draft, n.id);
      break;
    }
    case 4: {
      const column = pick(columns);
      if (column) column.nodes.push(node(`n${next()}`, r(500)));
      break;
    }
    case 5: {
      const n = pick(nodes);
      const column = pick(columns);
      if (n && column) moveNode(draft, n.id, idOf(column), r(500));
      break;
    }
    case 6: {
      const section = pick(draft.sections);
      section?.columns.splice(r(section.columns.length + 1), 0, { id: `cx${next()}`, nodes: [] });
      break;
    }
    case 7: {
      const column = pick(columns);
      if (column && columns.length > 1) removeColumn(draft, idOf(column));
      break;
    }
    case 8: {
      if (draft.sections.length < 6) {
        const id = next();
        draft.sections.splice(r(draft.sections.length + 1), 0, {
          id: `sx${id}`,
          title: 'S',
          columns: [{ id: `cx${id}`, nodes: [] }],
        });
      }
      break;
    }
    case 9: {
      const section = pick(draft.sections);
      if (section && draft.sections.length > 1) removeSection(draft, idOf(section));
      break;
    }
    case 10:
    case 11: {
      const from = pick(nodes);
      const to = pick(nodes);
      if (from && to && from !== to && !from.connections?.some((c) => c.targetId === to.id)) {
        const evidence = r(2) ? { evidence: `evidence ${next()}` } : {};
        addConnection(draft, from.id, to.id, { confidence: r(100), ...evidence });
      }
      break;
    }
    case 12: {
      const entry = pick(connections);
      if (entry) entry.connection.evidence = `evidence ${next()}`;
      break;
    }
    case 13: {
      const entry = pick(connections);
      if (entry) entry.connection.assumptions = `assumptions ${next()}`;
      break;
    }
    case 14: {
      const entry = pick(connections);
      if (entry) {
        entry.source.connections = entry.source.connections?.filter((c) => c !== entry.connection);
      }
      break;
    }
    case 15: {
      const entry = pick(connections);
      if (entry) entry.connection.confidence = r(100);
      break;
    }
    case 16: {
      const entry = pick(connections);
      if (entry) entry.connection.waypoints = [{ dx: r(100) - 50, dy: r(100) - 50 }];
      break;
    }
    case 17: {
      const section = pick(draft.sections);
      if (section) section.title = `section ${next()}`;
      break;
    }
    case 18: {
      const n = pick(nodes);
      if (n) n.width = 100 + r(200);
      break;
    }
    case 19: {
      const n = pick(nodes);
      if (n) n.yPosition = r(500);
      break;
    }
    case 20:
      draft.curvature = r(100) / 100;
      break;
    case 21: {
      const n = pick(nodes);
      if (n) Object.assign(n, { tag: `tag ${next()}` });
      break;
    }
  }
}

interface Entry {
  before: ToCData;
  after: ToCData;
}

interface Client {
  base: ToCData;
  baseVersion: number;
  local: ToCData;
  undo: Entry[];
  redo: Entry[];
}

/** Runs one three-client simulation; throws on the first violated invariant. */
function simulate(seed: number): void {
  const r = rng(seed);
  let uid = 0;
  const next = () => uid++;
  const server = { version: 0, chart: deepFreeze(connectedChart()) };
  const clients: Client[] = [0, 1, 2].map(() => ({
    base: server.chart,
    baseVersion: 0,
    local: server.chart,
    undo: [],
    redo: [],
  }));
  // The value each client last saved for a title, text, evidence or assumptions it changed,
  // keyed `entity|field`. A save that removes the entity drops its entries: a later save
  // that keeps it alive by another edit brings back that side's own, older, values.
  const lastSaved = new Map<string, unknown>();

  const merge = (
    base: ToCData,
    mine: ToCData,
    theirs: ToCData,
    onConflict: ConflictWinner,
    where: string,
  ): ToCData => {
    const out = mergeCharts(base, mine, theirs, { onConflict });
    assertUniqueIds(out, where);
    assertNothingDropped(base, mine, theirs, out);
    assertDeletedContainersStayDeleted(base, mine, theirs, out);
    // A merge that returns an input unchanged is a fast path; every other result is rebuilt.
    if (out !== mine && out !== theirs) {
      stats.merges++;
      if (where === 'undo' || where === 'redo') stats.undoMerges++;
      if (hasDanglingConnection(mine) || hasDanglingConnection(theirs)) {
        stats.mergesWithDanglingInput++;
      }
      if (hasDanglingConnection(out)) throw new Error(`${where}: connection to a missing node`);
      if (!deepEqual(normalizeChart(out), out)) throw new Error(`${where}: output not normalised`);
      assertFieldsFollowFieldRule(base, mine, theirs, out, onConflict);
      assertOrder(mine, theirs, out);
      // Merging again, now that the result already holds both sides, must change nothing.
      if (!deepEqual(mergeCharts(base, out, theirs, { onConflict }), out)) {
        throw new Error(`${where}: merging the result again changed it`);
      }
    }
    return deepFreeze(out);
  };

  const recordSaved = (base: ToCData, local: ToCData) => {
    const before = trackedEntities(base);
    const after = trackedEntities(local);
    for (const key of [...lastSaved.keys()]) {
      const entity = key.slice(0, key.indexOf('|'));
      if (before.has(entity) && !after.has(entity)) lastSaved.delete(key);
    }
    for (const [entity, now] of after) {
      for (const field of TRACKED_FIELDS) {
        const previous = before.get(entity);
        const was = previous === undefined ? undefined : fieldOf(previous, field);
        if (was !== fieldOf(now, field)) {
          lastSaved.set(`${entity}|${field}`, fieldOf(now, field));
        }
      }
    }
  };

  const assertLastSavedHolds = () => {
    const onServer = trackedEntities(server.chart);
    for (const [key, saved] of lastSaved) {
      const [entity, field] = key.split('|') as [string, (typeof TRACKED_FIELDS)[number]];
      const holder = onServer.get(entity);
      if (holder !== undefined && fieldOf(holder, field) !== saved) {
        throw new Error(
          `${key} was last saved as ${String(saved)} but the server has ${String(fieldOf(holder, field))}`,
        );
      }
    }
  };

  const save = (client: Client) => {
    if (deepEqual(client.local, client.base)) return;
    recordSaved(client.base, client.local);
    if (client.baseVersion !== server.version) {
      client.local = merge(client.base, client.local, server.chart, 'mine', 'save');
    }
    if (!deepEqual(client.local, server.chart)) {
      server.chart = client.local;
      server.version++;
    }
    client.base = server.chart;
    client.baseVersion = server.version;
    assertUniqueIds(server.chart, 'server');
    assertLastSavedHolds();
  };

  const poll = (client: Client) => {
    if (client.baseVersion === server.version) return;
    client.local = deepEqual(client.local, client.base)
      ? server.chart
      : merge(client.base, client.local, server.chart, 'mine', 'poll');
    client.base = server.chart;
    client.baseVersion = server.version;
  };

  for (let step = 0; step < STEPS; step++) {
    const client = clients[r(clients.length)];
    const action = r(20);
    if (action < 11) {
      const before = client.local;
      client.local = deepFreeze(edit(before, (draft) => randomEdit(draft, r, next)));
      if (!deepEqual(before, client.local)) {
        client.undo.push({ before, after: client.local });
        client.redo = [];
      }
    } else if (action < 14) {
      save(client);
    } else if (action < 16) {
      poll(client);
    } else if (action < 18) {
      const entry = client.undo.pop();
      if (entry) {
        client.local = merge(entry.after, entry.before, client.local, 'theirs', 'undo');
        client.redo.push(entry);
      }
    } else {
      const entry = client.redo.pop();
      if (entry) {
        client.local = merge(entry.before, entry.after, client.local, 'theirs', 'redo');
        client.undo.push(entry);
      }
    }
  }

  // Everyone saves, then pulls: each client ends on the server's chart.
  for (const client of clients) save(client);
  for (const client of clients) poll(client);
  clients.forEach((client, i) => {
    if (!deepEqual(client.local, server.chart))
      throw new Error(`client ${i} diverged from the server`);
  });
}

describe('mergeCharts fuzz', () => {
  it(
    `holds the invariants over ${RUNS} seeded three-client runs`,
    () => {
      for (let seed = 1; seed <= RUNS; seed++) {
        try {
          simulate(seed);
        } catch (error) {
          throw new Error(
            `merge fuzz violated an invariant at seed ${seed}: ${(error as Error).message}`,
            { cause: error },
          );
        }
      }
      // The runs must reach the cases the invariants are about, not pass vacuously.
      expect(stats.merges).toBeGreaterThan(1000);
      expect(stats.undoMerges).toBeGreaterThan(200);
      expect(stats.mergesWithDanglingInput).toBeGreaterThan(50);
    },
    TIMEOUT_MS,
  );
});
