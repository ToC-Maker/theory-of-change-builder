/**
 * The tab's one synchronous chart store. The canvas, App and the save and poll
 * hooks all read and write through it, so a chart from the server and a
 * keystroke in progress are applied to the same object in the same task and
 * neither can be dropped by a stale copy of the other.
 *
 * Four things are tracked. Charts are immutable and shared by reference:
 * nothing is deep-cloned, and a merge result may carry dangling connections
 * that came in on one of its inputs.
 *  - `server.chart`: the last chart the server confirmed, at `server.version`;
 *  - `committed`: what saves send and App renders;
 *  - `live`: `committed` plus the previews of typing, sliders and drags, what
 *    the canvas renders. `commit()` promotes it, so a notification can never
 *    carry a chart derived from before a landing;
 *  - history: `{ before, after }` pairs, replayed in revert form so undo and
 *    redo never overwrite what someone else changed since.
 *
 * A chart arriving from the server is merged into `committed` with the local
 * side winning a same-field conflict (the local save lands later), and `live` is
 * rebased onto the result with the preview winning. Nothing here asserts a
 * relation between versions: a response that arrives out of order is ignored
 * or merged, and saving never stops because of it.
 *
 * A method notifies subscribers after its state is complete (`edit` is a
 * preview then a commit, so it notifies twice). A merge that throws (a chart
 * with repeated ids) changes no chart and no history; the call has only
 * committed a pending preview or ended the save in flight beforehand.
 *
 * Limit: a save whose acknowledgement was lost looks like someone else's
 * write. If it did land and the user then returns that field to its old value
 * before the next poll, the landed value comes back.
 */
import { mergeCharts } from '../../shared/chart-merge';
import { deepEqual } from '../../shared/chart-model';
import type { ToCData } from '../types';

export interface ServerState {
  version: number;
  chart: ToCData;
}

/** What the canvas needs; the view route and tests use `staticStore`. */
export interface ChartStore {
  subscribe(listener: () => void): () => void;
  getLive(): ToCData;
  getCommitted(): ToCData;
  getCommitCount(): number;
  preview(updater: ToCData | ((prev: ToCData) => ToCData)): void;
  commit(): void;
}

export interface DocStatus {
  canUndo: boolean;
  canRedo: boolean;
  unsaved: boolean;
  saving: boolean;
  serverVersion: number | null;
  editToken: string | null;
  terminalError: string | null;
}

interface HistoryEntry {
  before: ToCData;
  after: ToCData;
}

interface SaveInFlight {
  sent: ToCData;
  baseVersion: number;
}

// Commits closer together than this share one undo step.
const GROUPING_WINDOW_MS = 300;

const WENT_BACKWARDS = 'The saved chart went back to an older version. Reload to continue.';

export class ChartDocument implements ChartStore {
  private committed: ToCData;
  private live: ToCData;
  private server: ServerState | null;
  private editToken: string | null;
  private readonly now: () => number;

  private commitCount = 0;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  // The top undo entry while later commits may still extend it.
  private openEntry: HistoryEntry | null = null;
  private lastCommitAt = 0;

  private inFlight: SaveInFlight | null = null;
  private terminalError: string | null = null;

  private readonly listeners = new Set<() => void>();
  private status: DocStatus | null = null;

  constructor(init: {
    chart: ToCData;
    editToken: string | null;
    server: ServerState | null;
    now?: () => number;
  }) {
    this.committed = this.live = init.chart;
    this.editToken = init.editToken;
    this.server = init.server;
    this.now = init.now ?? Date.now;
  }

  // The `ChartStore` members and `getStatus` are arrow properties: `useSyncExternalStore`
  // takes them as bare function references, and the canvas passes the store's members around.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getLive = (): ToCData => this.live;
  getCommitted = (): ToCData => this.committed;
  getCommitCount = (): number => this.commitCount;

  /** The same object until a field changes, as `useSyncExternalStore` requires. */
  getStatus = (): DocStatus => {
    const next: DocStatus = {
      // Undo commits a pending preview first, so a preview alone is undoable.
      canUndo: this.undoStack.length > 0 || this.live !== this.committed,
      canRedo: this.redoStack.length > 0,
      unsaved:
        this.live !== this.committed ||
        this.inFlight !== null ||
        (this.server ? this.committed !== this.server.chart : this.commitCount > 0),
      saving: this.inFlight !== null,
      serverVersion: this.server?.version ?? null,
      editToken: this.editToken,
      terminalError: this.terminalError,
    };
    const previous = this.status;
    const unchanged =
      previous !== null &&
      (Object.keys(next) as (keyof DocStatus)[]).every((key) => previous[key] === next[key]);
    return unchanged ? previous : (this.status = next);
  };

  preview = (updater: ToCData | ((prev: ToCData) => ToCData)): void => {
    const next = typeof updater === 'function' ? updater(this.live) : updater;
    // A gesture that ends where it began leaves nothing unsaved.
    const live = deepEqual(next, this.committed) ? this.committed : next;
    if (live === this.live) return;
    this.live = live;
    this.emit();
  };

  commit = (): void => {
    if (this.settle()) this.emit();
  };

  edit(updater: (prev: ToCData) => ToCData): void {
    this.preview(updater);
    this.commit();
  }

  undo(): void {
    this.beginForeignChange();
    const entry = this.undoStack.at(-1);
    if (entry) {
      this.adopt(mergeCharts(entry.after, entry.before, this.committed, { onConflict: 'theirs' }));
      this.undoStack.pop();
      this.redoStack.push(entry);
      this.commitCount++;
    }
    this.emit();
  }

  redo(): void {
    this.beginForeignChange();
    const entry = this.redoStack.at(-1);
    if (entry) {
      this.adopt(mergeCharts(entry.before, entry.after, this.committed, { onConflict: 'theirs' }));
      this.redoStack.pop();
      this.undoStack.push(entry);
      this.commitCount++;
    }
    this.emit();
  }

  /** Import or Generate: the local chart becomes exactly `chart`; later remote edits merge into it. */
  replace(chart: ToCData): void {
    this.beginForeignChange();
    this.undoStack.push({ before: this.committed, after: chart });
    this.redoStack = [];
    this.committed = this.live = chart;
    this.commitCount++;
    this.emit();
  }

  /** An AI edit computed against `base`, the chart as it was sent, lands on the current chart. */
  applyRebased(base: ToCData, next: ToCData): void {
    this.beginForeignChange();
    const merged = mergeCharts(base, next, this.committed, { onConflict: 'mine' });
    if (!deepEqual(merged, this.committed)) {
      this.undoStack.push({ before: this.committed, after: merged });
      this.redoStack = [];
      this.commitCount++;
      this.adopt(merged);
    }
    this.emit();
  }

  /** After createChart. The first server wins when two creators race; edits made meanwhile go out on its version. */
  attachServer(editToken: string, server: ServerState): void {
    if (this.server) return;
    this.editToken = editToken;
    this.server = server;
    this.emit();
  }

  takeSave(): { editToken: string; baseVersion: number; chart: ToCData } | null {
    const { server, editToken, committed } = this;
    if (
      !server ||
      !editToken ||
      this.inFlight ||
      this.terminalError ||
      committed === server.chart
    ) {
      return null;
    }
    if (deepEqual(committed, server.chart)) {
      this.server = { version: server.version, chart: committed };
      this.emit();
      return null;
    }
    this.inFlight = { sent: committed, baseVersion: server.version };
    this.emit();
    return { editToken, baseVersion: server.version, chart: committed };
  }

  saveSucceeded(version: number): void {
    // Only one save is in flight and no landing is absorbed meanwhile, so the
    // acknowledged chart is the sent one; an identical write returns the same version.
    this.server = { version, chart: this.endFlight().sent };
    this.emit();
  }

  saveConflicted(theirs: ServerState): void {
    const { baseVersion } = this.endFlight();
    try {
      if (theirs.version < baseVersion) {
        // The stored chart went backwards (a database restore); merging would resurrect lost state.
        this.terminalError = WENT_BACKWARDS;
      } else {
        this.absorb(theirs);
      }
    } finally {
      this.emit();
    }
  }

  saveFailed(): void {
    this.inFlight = null;
    this.emit();
  }

  /** A poll landing. During a save the save's own 200 or 409 brings the newer state. */
  receiveRemote(theirs: ServerState): void {
    if (!this.inFlight && this.absorb(theirs)) this.emit();
  }

  /**
   * Starts a change that is not a continuation of the user's typing: a pending preview is
   * committed first, and no later commit may extend the entry the user was building, so no
   * entry's diff contains someone else's edit.
   */
  private beginForeignChange(): void {
    this.settle();
    this.openEntry = null;
  }

  /** Promotes the preview layer to committed; false when there was nothing to promote. */
  private settle(): boolean {
    if (this.live === this.committed) return false;
    if (deepEqual(this.live, this.committed)) {
      this.live = this.committed;
      return true;
    }
    const before = this.committed;
    this.committed = this.live;
    this.commitCount++;
    const at = this.now();
    if (this.openEntry && at - this.lastCommitAt < GROUPING_WINDOW_MS) {
      this.openEntry.after = this.committed;
    } else {
      this.openEntry = { before, after: this.committed };
      this.undoStack.push(this.openEntry);
    }
    this.lastCommitAt = at;
    this.redoStack = [];
    return true;
  }

  /** Makes `next` the committed chart and rebases the preview layer onto it (the preview wins). */
  private adopt(next: ToCData): void {
    const live =
      this.live === this.committed
        ? next
        : mergeCharts(this.committed, this.live, next, { onConflict: 'mine' });
    this.committed = next;
    this.live = live;
  }

  /** Merges a newer server chart into the committed one; false when `theirs` is stale or an echo. */
  private absorb(theirs: ServerState): boolean {
    const { server } = this;
    if (!server) throw new Error('Chart has no server state to merge against');
    if (theirs.version <= server.version) return false;
    this.openEntry = null;
    this.adopt(mergeCharts(server.chart, this.committed, theirs.chart, { onConflict: 'mine' }));
    this.server = theirs;
    return true;
  }

  private endFlight(): SaveInFlight {
    const flight = this.inFlight;
    if (!flight) throw new Error('No save is in flight');
    this.inFlight = null;
    return flight;
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export function staticStore(chart: ToCData): ChartStore {
  return {
    subscribe: () => () => {},
    getLive: () => chart,
    getCommitted: () => chart,
    getCommitCount: () => 0,
    preview: () => {},
    commit: () => {},
  };
}
