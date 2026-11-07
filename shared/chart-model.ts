/* eslint-disable @typescript-eslint/no-unused-vars -- signatures only; bodies land with the implementation */
/**
 * Chart data model, id minting and normalisation, shared by the client and
 * the Worker.
 *
 * Consumed by:
 *  - the client, through `src/types/index.ts` (which re-exports this file),
 *    compiled under `tsconfig.app.json`;
 *  - the Worker and the merge module, compiled under `worker/tsconfig.json`.
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
 * A chart from outside the running tab. Section and column ids stay optional
 * here for good; `ToCData` will require them, and `normalizeChart` is the
 * only way across.
 */
export interface ChartInput extends Omit<ToCData, 'sections'> {
  sections: {
    id?: string;
    title: string;
    columns: { id?: string; nodes: Node[] }[];
  }[];
}

/** `normalizeChart` was given something that is not a chart; `raw` is that value. */
export class ChartShapeError extends Error {
  readonly raw: unknown;

  constructor(raw: unknown) {
    super('Chart data has no sections array');
    this.name = 'ChartShapeError';
    this.raw = raw;
  }
}

/**
 * Gives every section and column an id, makes node ids unique and builds
 * `connections` from the legacy `connectionIds`. Pure, deterministic and
 * idempotent; never mutates `raw`.
 */
export function normalizeChart(_raw: unknown): ToCData {
  throw new Error('not implemented');
}

/** A fresh random section id, e.g. `sec-k3j9x0a1bz`. */
export function newSectionId(): string {
  throw new Error('not implemented');
}

/** A fresh random column id, e.g. `col-k3j9x0a1bz`. */
export function newColumnId(): string {
  throw new Error('not implemented');
}

/** A fresh node id, e.g. `node-1731000000000-k3j9x0a1b`. */
export function newNodeId(): string {
  throw new Error('not implemented');
}

/**
 * Structural equality for chart data: key order does not matter, a missing
 * key equals one holding `undefined`, array order does matter.
 */
export function deepEqual(_a: unknown, _b: unknown): boolean {
  throw new Error('not implemented');
}

/**
 * The id of a section or column while ids are still optional in the types;
 * throws when it is missing. Goes away once `ToCData` requires them.
 */
export function idOf(_x: { id?: string }): string {
  throw new Error('not implemented');
}
