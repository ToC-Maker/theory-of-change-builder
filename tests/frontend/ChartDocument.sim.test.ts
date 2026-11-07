// Three tabs edit one chart through the real ChartDocument. A discrete-event simulation on a
// virtual clock supplies what the document's callers supply: a compare-and-swap server with
// random latency and lost requests and acknowledgements, a save loop that debounces 300 ms and
// keeps one request in flight, a poll every 2.5 s, typing and slider gestures that preview
// many times before they commit, undo, redo, whole-chart replacement and AI edits computed
// against the chart as it was sent.
//
// The edits are the merge fuzz's, and every merge the document performs is judged by the
// fuzz's merge oracles (the module's `mergeCharts` is wrapped below). A violation reports the
// seed; `simulate(seed)` replays it.
import { describe, expect, it, vi } from 'vitest';
import type { ConflictWinner } from '../../shared/chart-merge';
import { deepEqual, normalizeChart, type ToCData } from '../../shared/chart-model';
import { ChartDocument } from '../../src/sync/ChartDocument';
import { connectedChart, edit } from '../shared/chart-fixtures';
import {
  assertUniqueIds,
  createLastSavedOracle,
  EDIT_KINDS,
  FIELD_EDIT_KINDS,
  fieldOf,
  randomEdit,
  rng,
  TRACKED_FIELDS,
  trackedEntities,
  type MergeStats,
} from '../shared/chart-fuzz-helpers';
import { deepFreeze } from './helpers/deepFreeze';

const { mergeStats } = vi.hoisted((): { mergeStats: MergeStats } => ({
  mergeStats: { merges: 0, undoMerges: 0, mergesWithDanglingInput: 0 },
}));

vi.mock('../../shared/chart-merge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/chart-merge')>();
  const { checkedMerge } = await import('../shared/chart-fuzz-helpers');
  return {
    ...actual,
    mergeCharts: (
      base: ToCData,
      mine: ToCData,
      theirs: ToCData,
      opts: { onConflict: ConflictWinner },
    ) =>
      checkedMerge(
        actual.mergeCharts,
        base,
        mine,
        theirs,
        opts.onConflict,
        'document merge',
        mergeStats,
      ),
  };
});

const RUNS = 200;
const TABS = 3;
const POLL_MS = 2500;
const DEBOUNCE_MS = 300;
const RETRY_MS = 1000;
const EDITING_MS = 10_000;
// Long after the last edit and the last retry, so every tab has polled the final version.
const POLLING_ENDS_MS = EDITING_MS + 30_000;
const MAX_EVENTS = 200_000;
// About 7 s for the 200 runs when the box is idle; the default 5 s limit is too close.
const TIMEOUT_MS = 90_000;

const counts = {
  conflicts: 0,
  lostRequests: 0,
  lostAcknowledgements: 0,
  landingsDuringSave: 0,
  undos: 0,
  redos: 0,
  replaces: 0,
  aiEdits: 0,
};

/** Events in time order; ties run in the order they were scheduled. */
class Timeline {
  now = 0;
  private seq = 0;
  private queue: { at: number; seq: number; run: () => void }[] = [];

  after(delay: number, run: () => void): void {
    const entry = { at: this.now + delay, seq: this.seq++, run };
    let lo = 0;
    let hi = this.queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const other = this.queue[mid];
      if (other.at < entry.at || (other.at === entry.at && other.seq < entry.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.queue.splice(lo, 0, entry);
  }

  pop() {
    return this.queue.shift();
  }
}

/** How the database keeps a chart: no `undefined`, object keys shortest first, then in byte order. */
function asStored(chart: ToCData): ToCData {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.length - b.length || (a < b ? -1 : 1))
        .map(([key, v]) => [key, sorted(v)]),
    );
  };
  return deepFreeze(sorted(chart) as ToCData);
}

/**
 * What one tab has typed (or had an AI edit, an import or an undo set) in a title, text,
 * evidence or assumptions field that the server does not hold yet, keyed `entity|field`.
 * Such a value must stay visible in the tab until it is saved, and a save may change a field
 * only to a value the tab set itself. `view` says which chart the tab's base version holds on
 * the server and which save, if any, is in flight or ended without an answer (it may or may
 * not have landed).
 */
function createIntents(view: () => { held: ToCData; inDoubt: ToCData | null }) {
  const pending = new Map<string, string>();
  // Every `entity|field=value` this tab has set, saved or not.
  const typed = new Set<string>();
  // Entities that came back through a merge: this tab's edit kept one alive after a delete (by
  // another tab, or by this tab before an AI edit), or both tabs added it. Its fields then merge
  // against an empty base, so this tab's older values can replace newer ones.
  const reAdded = new Set<string>();
  const splitKey = (key: string) => key.split('|') as [string, (typeof TRACKED_FIELDS)[number]];

  return {
    /** Records what a local operation changed. */
    note(before: ToCData, after: ToCData) {
      const was = trackedEntities(before);
      const now = trackedEntities(after);
      const { held, inDoubt } = view();
      const onServer = trackedEntities(held);
      const sending = inDoubt && trackedEntities(inDoubt);
      for (const key of [...pending.keys()]) {
        if (!now.has(splitKey(key)[0])) pending.delete(key);
      }
      for (const [entity, current] of now) {
        for (const field of TRACKED_FIELDS) {
          const value = fieldOf(current, field);
          const previous = was.get(entity);
          if (previous !== undefined && fieldOf(previous, field) === value) continue;
          typed.add(`${entity}|${field}=${String(value)}`);
          const key = `${entity}|${field}`;
          const serverHas = onServer.get(entity);
          const carrier = sending?.get(entity);
          if (
            serverHas !== undefined &&
            fieldOf(serverHas, field) === value &&
            sending !== undefined &&
            (carrier === undefined || fieldOf(carrier, field) !== value)
          ) {
            // Back to what the server held while a save that changes it may or may not have
            // landed: if it did, the server's value stands and undoing it is lost (the document
            // cannot tell), so there is nothing to insist on.
            pending.delete(key);
          } else if (typeof value === 'string') {
            pending.set(key, value);
          } else {
            // A field emptied, say by undoing what was typed, is no longer something to save.
            pending.delete(key);
          }
        }
      }
    },

    /** The tab still shows everything it has typed and not yet saved. */
    assertShown(live: ToCData) {
      if (pending.size === 0) return;
      const shown = trackedEntities(live);
      for (const [key, value] of pending) {
        const [entity, field] = splitKey(key);
        const holder = shown.get(entity);
        const actual = holder === undefined ? 'no such entity' : String(fieldOf(holder, field));
        if (actual !== value)
          throw new Error(`${key}: typed ${value}, but the tab shows ${actual}`);
      }
    },

    /** The tab's base moved from `before` to `after` while it held `committed`. */
    baseMoved(before: ToCData, after: ToCData, committed: ToCData) {
      const was = trackedEntities(before);
      const mine = trackedEntities(committed);
      for (const entity of trackedEntities(after).keys()) {
        if (!was.has(entity) && mine.has(entity)) reAdded.add(entity);
      }
    },

    /** An operation that merged brought back entities `before` lacked. */
    broughtBack(before: ToCData, after: ToCData) {
      const was = trackedEntities(before);
      for (const entity of trackedEntities(after).keys()) {
        if (!was.has(entity)) reAdded.add(entity);
      }
    },

    /** A save changes a field of an entity the server already has only to a value this tab set. */
    assertAuthorised(sent: ToCData) {
      const onServer = trackedEntities(view().held);
      for (const [entity, current] of trackedEntities(sent)) {
        const held = onServer.get(entity);
        if (held === undefined || reAdded.has(entity)) continue;
        for (const field of TRACKED_FIELDS) {
          const value = fieldOf(current, field);
          if (value !== fieldOf(held, field) && !typed.has(`${entity}|${field}=${String(value)}`)) {
            throw new Error(
              `a save changed ${entity}|${field} to ${String(value)}, which this tab never set`,
            );
          }
        }
      }
    },

    /**
     * Forgets what the server holds. A save in doubt may change a field, so a value the server
     * holds is forgotten only if that save carries the same value.
     */
    settle() {
      if (pending.size === 0) return;
      const { held, inDoubt } = view();
      const onServer = trackedEntities(held);
      const sending = inDoubt && trackedEntities(inDoubt);
      for (const [key, value] of pending) {
        const [entity, field] = splitKey(key);
        const holder = onServer.get(entity);
        if (holder === undefined || fieldOf(holder, field) !== value) continue;
        const carrier = sending?.get(entity);
        if (sending && (carrier === undefined || fieldOf(carrier, field) !== value)) continue;
        pending.delete(key);
      }
    },

    assertNoneLeft() {
      if (pending.size > 0) {
        throw new Error(`never saved: ${[...pending].map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
    },
  };
}

type UpdateResponse =
  | { status: 200; version: number }
  | { status: 409; version: number; chart: ToCData }
  | { status: 500 };

/** Runs one three-tab simulation; throws on the first violated invariant. */
function simulate(seed: number): void {
  const r = rng(seed);
  const timeline = new Timeline();
  let uid = 0;
  const next = () => uid++;
  const latency = () => 20 + r(500);
  const saved = createLastSavedOracle();

  const server = { version: 1, chart: asStored(connectedChart()) };
  const versions = new Map([[server.version, server.chart]]);
  /** What a read returns: a fresh, normalised copy of the stored chart. */
  const serve = () => deepFreeze(normalizeChart(structuredClone(server.chart)));

  const sendUpdate = (
    baseVersion: number,
    chart: ToCData,
    respond: (response: UpdateResponse) => void,
  ) => {
    timeline.after(latency(), () => {
      const failure = r(100);
      if (failure < 3) {
        counts.lostRequests++;
        timeline.after(latency(), () => respond({ status: 500 }));
        return;
      }
      let response: UpdateResponse;
      if (server.version === baseVersion) {
        saved.recordSaved(server.chart, chart);
        // An identical write is acknowledged at the same version, as the database's trigger does.
        if (!deepEqual(chart, server.chart)) {
          server.chart = asStored(chart);
          versions.set(++server.version, server.chart);
        }
        assertUniqueIds(server.chart, 'server');
        saved.assertHolds(server.chart);
        response = { status: 200, version: server.version };
      } else {
        counts.conflicts++;
        response = { status: 409, version: server.version, chart: serve() };
      }
      if (response.status === 200 && failure < 6) {
        counts.lostAcknowledgements++;
        response = { status: 500 };
      }
      const answer = response;
      timeline.after(latency(), () => respond(answer));
    });
  };

  const sendPoll = (
    knownVersion: number,
    respond: (response: { version: number; chart?: ToCData }) => void,
  ) => {
    timeline.after(latency(), () => {
      const response =
        server.version === knownVersion
          ? { version: server.version }
          : { version: server.version, chart: serve() };
      timeline.after(latency(), () => respond(response));
    });
  };

  const tabs = Array.from({ length: TABS }, (_, id) => {
    const chart = serve();
    const doc = new ChartDocument({
      chart,
      editToken: 'tok',
      server: { version: server.version, chart },
      now: () => timeline.now,
    });
    const baseVersion = () => doc.getStatus().serverVersion!;
    // The chart of the save in flight, or of one that failed and may still have landed.
    let inDoubt: ToCData | null = null;
    const intents = createIntents(() => ({ held: versions.get(baseVersion())!, inDoubt }));

    // Notes that the document's base moved (a landing or a conflict), which a step may do
    // before it saves again.
    let knownVersion = baseVersion();
    const trackBase = () => {
      if (baseVersion() < knownVersion) throw new Error('the server version went backwards');
      if (baseVersion() > knownVersion) {
        inDoubt = null;
        intents.baseMoved(
          versions.get(knownVersion)!,
          versions.get(baseVersion())!,
          doc.getCommitted(),
        );
      }
      knownVersion = baseVersion();
    };

    // Wraps each step that touches this tab's document, then checks what it holds.
    const checked =
      <Args extends unknown[]>(step: (...args: Args) => void) =>
      (...args: Args) => {
        try {
          step(...args);
          trackBase();
          intents.assertShown(doc.getLive());
          intents.settle();
          assertUniqueIds(doc.getCommitted(), 'committed');
          assertUniqueIds(doc.getLive(), 'live');
        } catch (error) {
          throw new Error(`tab ${id}: ${(error as Error).message}`, { cause: error });
        }
      };

    /** A change this tab makes itself, to be recorded as typed. */
    const local = (change: () => void) => {
      const before = doc.getLive();
      change();
      intents.note(before, doc.getLive());
    };

    // The save loop.
    const flush = () => {
      const request = doc.takeSave();
      if (!request) return;
      trackBase();
      inDoubt = request.chart;
      intents.assertAuthorised(request.chart);
      sendUpdate(
        request.baseVersion,
        request.chart,
        checked((response: UpdateResponse) => {
          if (response.status !== 500) inDoubt = null;
          if (response.status === 200) {
            doc.saveSucceeded(response.version);
            if (doc.getStatus().unsaved) flush();
          } else if (response.status === 409) {
            doc.saveConflicted({ version: response.version, chart: response.chart });
            flush();
          } else {
            doc.saveFailed();
            timeline.after(RETRY_MS, flush);
          }
        }),
      );
    };
    let debounce = 0;
    doc.subscribe(() => {
      const status = doc.getStatus();
      if (!status.unsaved || status.saving || status.terminalError) return;
      const latest = ++debounce;
      timeline.after(DEBOUNCE_MS, () => {
        if (debounce === latest) flush();
      });
    });

    // The poll loop.
    const poll = () => {
      if (timeline.now > POLLING_ENDS_MS) return;
      if (doc.getStatus().saving) {
        timeline.after(POLL_MS, poll);
        return;
      }
      sendPoll(
        baseVersion(),
        checked((response) => {
          if (response.chart) {
            if (doc.getStatus().saving) counts.landingsDuringSave++;
            doc.receiveRemote({ version: response.version, chart: deepFreeze(response.chart) });
          }
          timeline.after(POLL_MS, poll);
        }),
      );
    };
    timeline.after(r(POLL_MS), poll);

    return { doc, intents, checked, local };
  });

  const edited = (chart: ToCData, edits: number) =>
    deepFreeze(
      edit(chart, (draft) => {
        for (let i = 0; i < edits; i++) randomEdit(draft, r, next);
      }),
    );

  /** One thing a person does in a tab. */
  const act = ({ doc, intents, checked, local }: (typeof tabs)[number]) => {
    const choice = r(100);
    if (choice < 66) {
      const kind = r(EDIT_KINDS);
      if (FIELD_EDIT_KINDS.has(kind)) {
        // Typing or dragging a slider: the same edit, previewed several times, then committed.
        const gesture = r(2 ** 30);
        let at = 0;
        for (let stroke = 1 + r(4); stroke > 0; stroke--) {
          timeline.after(
            at,
            checked(() =>
              local(() =>
                doc.preview((chart) =>
                  deepFreeze(edit(chart, (draft) => randomEdit(draft, rng(gesture), next, kind))),
                ),
              ),
            ),
          );
          at += 30 + r(150);
        }
        timeline.after(
          at + 200,
          checked(() => doc.commit()),
        );
      } else {
        local(() =>
          doc.preview((chart) =>
            deepFreeze(edit(chart, (draft) => randomEdit(draft, r, next, kind))),
          ),
        );
        timeline.after(
          r(100),
          checked(() => doc.commit()),
        );
      }
    } else if (choice < 78) {
      if (doc.getStatus().canUndo) counts.undos++;
      local(() => doc.undo());
    } else if (choice < 88) {
      if (doc.getStatus().canRedo) counts.redos++;
      local(() => doc.redo());
    } else if (choice < 96) {
      // The chart as sent to the model; the reply lands one to three seconds later.
      doc.commit();
      const asSent = doc.getCommitted();
      timeline.after(
        1000 + r(2000),
        checked(() => {
          counts.aiEdits++;
          const reply = edited(asSent, 2);
          const before = doc.getLive();
          doc.applyRebased(asSent, reply);
          // What the AI changed counts, not what merging brought in from other tabs.
          intents.note(asSent, reply);
          intents.broughtBack(before, doc.getLive());
        }),
      );
    } else {
      counts.replaces++;
      doc.commit();
      const imported = edited(doc.getCommitted(), 3);
      intents.note(doc.getLive(), imported);
      doc.replace(imported);
    }
  };

  for (const tab of tabs) {
    for (let at = r(500); at < EDITING_MS; at += 150 + r(1800)) {
      timeline.after(
        at,
        tab.checked(() => act(tab)),
      );
    }
  }

  for (let event = timeline.pop(), steps = 0; event; event = timeline.pop()) {
    if (++steps > MAX_EVENTS) throw new Error('the simulation did not settle');
    timeline.now = event.at;
    event.run();
  }

  tabs.forEach(({ doc, intents }, i) => {
    const status = doc.getStatus();
    if (status.terminalError) throw new Error(`tab ${i} stopped saving: ${status.terminalError}`);
    if (status.unsaved || status.saving) throw new Error(`tab ${i} is still unsaved at the end`);
    if (!deepEqual(doc.getCommitted(), server.chart)) {
      throw new Error(`tab ${i} diverged from the server`);
    }
    intents.assertNoneLeft();
  });
  assertUniqueIds(server.chart, 'server');
  saved.assertHolds(server.chart);
}

describe('ChartDocument simulation', () => {
  it(
    `keeps three tabs consistent and loses no typed text over ${RUNS} seeded runs`,
    () => {
      for (let seed = 1; seed <= RUNS; seed++) {
        try {
          simulate(seed);
        } catch (error) {
          throw new Error(
            `document simulation violated an invariant at seed ${seed}: ${(error as Error).message}`,
            { cause: error },
          );
        }
      }
      // The runs must reach the cases the invariants are about, not pass vacuously.
      const reached: Record<string, number> = { ...counts, ...mergeStats };
      const atLeast = {
        conflicts: 1000,
        lostRequests: 50,
        lostAcknowledgements: 20,
        landingsDuringSave: 100,
        undos: 200,
        redos: 20,
        replaces: 80,
        aiEdits: 150,
        merges: 1500,
        undoMerges: 100,
        mergesWithDanglingInput: 30,
      };
      for (const [what, minimum] of Object.entries(atLeast)) {
        expect(reached[what], what).toBeGreaterThan(minimum);
      }
    },
    TIMEOUT_MS,
  );
});
