/**
 * Chart data model, id minting and normalisation, shared by the client and
 * the Worker.
 *
 * Consumed by:
 *  - the client, through `src/types/index.ts` (which re-exports this file),
 *    compiled under `tsconfig.app.json`;
 *  - the other `shared/` modules (the chart merge), compiled under
 *    `worker/tsconfig.json` as well, so the Worker can run them later.
 *
 * It therefore touches neither the DOM nor Workers-only types: only
 * `crypto.getRandomValues`, which both runtimes provide as a global.
 *
 * Anything that reaches the running tab from outside (server, file import,
 * AI reply, template) is a `ChartInput` until `normalizeChart` has given it
 * ids and canonical connections.
 */

/**
 * A custom bend point, stored as a pixel offset from the midpoint of
 * the straight line between a connection's source and target anchors.
 * Relative to the nodes, so it follows them through any layout change.
 */
export interface WaypointOffset {
  dx: number;
  dy: number;
}

export interface Connection {
  targetId: string;
  confidence: number; // 0-100 scale
  evidence?: string; // Evidence supporting this connection
  assumptions?: string; // Key assumptions underlying this connection
  /**
   * Optional custom bend points as offsets from the connection's line
   * midpoint (see `WaypointOffset`; the conversion to canvas
   * coordinates lives in `src/utils/connectionGeometry.ts`). When
   * present, the connection path runs source -> waypoint -> target as
   * a multi-segment cubic bezier (one `<path>` element, see
   * `src/utils/connectionPath.ts`). When absent, empty or not made of
   * finite `{dx, dy}` entries (including the earlier absolute `{x, y}`
   * format), the renderer draws the automatic curve.
   *
   * The UI reads and writes AT MOST ONE entry. Dragging replaces the
   * whole array with the dragged waypoint, and double-clicking a
   * handle clears it (see `useWaypointDrag`).
   */
  waypoints?: WaypointOffset[];
}

export interface Node {
  id: string;
  title: string;
  text: string;
  connectionIds: string[];
  connections?: Connection[];
  yPosition?: number;
  width?: number; // Width in pixels (default 192px = w-48)
  color?: string; // Background color (default white)
}

export interface Column {
  id?: string;
  nodes: Node[];
}

export interface Section {
  id?: string;
  title: string;
  columns: Column[];
}

export interface ToCData {
  title?: string; // Optional title for the theory of change
  color?: string; // Section header background color (default gray-700)
  sections: Section[];
  textSize?: number; // Optional text size scaling factor (0.5 to 2.0)
  curvature?: number; // Optional curve shape setting (0.0 to 1.0)
  columnPadding?: number; // Optional column spacing in pixels (default 24px)
  sectionPadding?: number; // Optional section spacing in pixels (default 32px)
  fontFamily?: string; // Optional font family (default system font)
}

/**
 * A chart from outside the running tab (server, file, AI reply, template).
 * Section and column ids are optional here; `normalizeChart` supplies them.
 */
export interface ChartInput extends Omit<ToCData, 'sections'> {
  sections: {
    id?: string;
    title: string;
    columns: { id?: string; nodes: Node[] }[];
  }[];
}

/**
 * `normalizeChart` was given something that is not a chart. `raw` is that
 * value; `reason` names the first malformed part by its index path
 * (`sections[0].columns is not an array`), for callers that frame it
 * themselves, such as the import dialog.
 */
export class ChartShapeError extends Error {
  readonly raw: unknown;
  readonly reason: string;

  constructor(raw: unknown, reason = 'sections is not an array') {
    super(`Chart data is malformed: ${reason}`);
    this.name = 'ChartShapeError';
    this.raw = raw;
    this.reason = reason;
  }
}

/**
 * Gives every section and column an id, makes node ids unique across the
 * chart (filling missing ones) and makes each node's `connections` canonical:
 * built from the legacy `connectionIds` at confidence 50 when absent, a
 * repeated target dropped (the first is kept), and `connectionIds` rewritten
 * to list the same targets. Pure, deterministic (two tabs reading the same
 * id-less chart agree on every id) and idempotent. Never mutates `raw`; parts
 * it does not touch are shared with it, not copied.
 *
 * Only the first occurrence of a stored id keeps it. All stored ids are
 * reserved before any id is minted, so a positional id that collides with one
 * gets a `~k` suffix, and so does a later repeat of a stored id.
 *
 * Throws `ChartShapeError` (its `reason` an index path) when the chart is not
 * an object with a `sections` array, a section, column, node or connection is
 * not an object, a section lacks its `columns` array, a column its `nodes`
 * array, or a node's `connections` is present but not an array.
 */
export function normalizeChart(raw: unknown): ToCData {
  assertChartShape(raw);
  const chart = raw;

  const sectionId = idAssigner(chart.sections.map((s) => s.id));
  const columnId = idAssigner(chart.sections.flatMap((s) => s.columns.map((c) => c.id)));
  const nodeId = idAssigner(
    chart.sections.flatMap((s) => s.columns.flatMap((c) => c.nodes.map((n) => n.id))),
  );

  return {
    ...chart,
    sections: chart.sections.map((section, i) => ({
      ...section,
      id: sectionId(section.id, `s${i}`),
      columns: section.columns.map((column, j) => ({
        ...column,
        id: columnId(column.id, `c${i}.${j}`),
        nodes: column.nodes.map((node, k) =>
          normalizeNode(node, nodeId(node.id, `n${i}.${j}.${k}`)),
        ),
      })),
    })),
  };
}

/**
 * Returns a function that settles ids in document order. A stored id's first
 * occurrence keeps it; a missing id takes `positional`, a repeated one takes
 * its own value, and either gets `~2`, `~3`, ... until it is neither stored
 * elsewhere nor already handed out.
 */
function idAssigner(stored: unknown[]) {
  const reserved = new Set(stored.filter((id): id is string => typeof id === 'string'));
  const handedOut = new Set<string>();
  return (id: unknown, positional: string): string => {
    const base = typeof id === 'string' ? id : positional;
    let candidate = base;
    if (typeof id !== 'string' || handedOut.has(id)) {
      for (let k = 2; reserved.has(candidate) || handedOut.has(candidate); k++) {
        candidate = `${base}~${k}`;
      }
    }
    handedOut.add(candidate);
    return candidate;
  };
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Throws `ChartShapeError` unless `raw` is shaped like a chart, down to its
 * connections. For code that has to look inside a chart before it can
 * normalise it (an AI reply's edits are not shape-checked).
 */
export function assertChartShape(raw: unknown): asserts raw is ChartInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new ChartShapeError(raw, 'top-level is not an object');
  }
  const chart = raw as ChartInput;
  if (!Array.isArray(chart.sections)) throw new ChartShapeError(raw);
  const sections: unknown[] = chart.sections;
  const fail = (reason: string): never => {
    throw new ChartShapeError(chart, reason);
  };
  sections.forEach((section, i) => {
    const at = `sections[${i}]`;
    if (!isObject(section)) fail(`${at} is not an object`);
    if (!Array.isArray((section as { columns?: unknown }).columns)) {
      fail(`${at}.columns is not an array`);
    }
    (section as { columns: unknown[] }).columns.forEach((column, j) => {
      const inColumn = `${at}.columns[${j}]`;
      if (!isObject(column)) fail(`${inColumn} is not an object`);
      if (!Array.isArray((column as { nodes?: unknown }).nodes)) {
        fail(`${inColumn}.nodes is not an array`);
      }
      (column as { nodes: unknown[] }).nodes.forEach((node, k) => {
        const inNode = `${inColumn}.nodes[${k}]`;
        if (!isObject(node)) fail(`${inNode} is not an object`);
        const { connections } = node as { connections?: unknown };
        if (connections === undefined) return;
        if (!Array.isArray(connections)) fail(`${inNode}.connections is not an array`);
        (connections as unknown[]).forEach((connection, m) => {
          if (!isObject(connection)) fail(`${inNode}.connections[${m}] is not an object`);
        });
      });
    });
  });
}

function normalizeNode(node: Node, id: string): Node {
  // The renderer draws `connections` whenever it is an array (even an empty
  // one) and `connectionIds` at confidence 50 otherwise.
  const listed: Connection[] = Array.isArray(node.connections)
    ? node.connections
    : (Array.isArray(node.connectionIds) ? node.connectionIds : []).map((targetId) => ({
        targetId,
        confidence: 50,
      }));
  const seen = new Set<string>();
  const connections = listed.filter((c) => {
    if (seen.has(c.targetId)) return false;
    seen.add(c.targetId);
    return true;
  });
  return { ...node, id, connections, connectionIds: connections.map((c) => c.targetId) };
}

function randomBase36(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
    (byte % 36).toString(36),
  ).join('');
}

/** A fresh random section id, e.g. `sec-k3j9x0a1bz`. */
export function newSectionId(): string {
  return `sec-${randomBase36(10)}`;
}

/** A fresh random column id, e.g. `col-k3j9x0a1bz`. */
export function newColumnId(): string {
  return `col-${randomBase36(10)}`;
}

/** A fresh node id, e.g. `node-1731000000000-k3j9x0a1b`. */
export function newNodeId(): string {
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Structural equality for chart data: key order does not matter, a missing
 * key equals one holding `undefined`, array order does matter.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]))
    );
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const defined = (obj: Record<string, unknown>) =>
    Object.keys(obj).filter((key) => obj[key] !== undefined);
  const leftKeys = defined(left);
  return (
    leftKeys.length === defined(right).length &&
    leftKeys.every((key) => deepEqual(left[key], right[key]))
  );
}

/**
 * The id of a section or column, for code that needs one while the types
 * still make it optional; throws when it is missing.
 */
export function idOf(x: { id?: string }): string {
  if (x.id === undefined) throw new Error('Section or column has no id');
  return x.id;
}
