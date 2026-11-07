// Three clients edit one chart through a compare-and-swap server, with optimistic local
// edits, stale-base saves that merge on conflict, polls that merge into unsaved edits, and
// undo and redo in revert form. A violation reports the seed; `simulate(seed)` replays it.
// The edits and the checks on each merge live in `chart-fuzz-helpers.ts`, shared with the
// simulation of the client document.
import { describe, expect, it } from 'vitest';
import { mergeCharts, type ConflictWinner } from '../../shared/chart-merge';
import { deepEqual, type ToCData } from '../../shared/chart-model';
import { deepFreeze } from '../frontend/helpers/deepFreeze';
import {
  checkedMerge,
  createLastSavedOracle,
  assertUniqueIds,
  newMergeStats,
  randomEdit,
  rng,
} from './chart-fuzz-helpers';
import { connectedChart, edit } from './chart-fixtures';

const RUNS = 500;
const STEPS = 60;
// About 4 s when the box is idle; the default 5 s limit is too close under load.
const TIMEOUT_MS = 60_000;

const stats = newMergeStats();

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
  const saved = createLastSavedOracle();

  const merge = (
    base: ToCData,
    mine: ToCData,
    theirs: ToCData,
    onConflict: ConflictWinner,
    where: string,
  ): ToCData => checkedMerge(mergeCharts, base, mine, theirs, onConflict, where, stats);

  const save = (client: Client) => {
    if (deepEqual(client.local, client.base)) return;
    saved.recordSaved(client.base, client.local);
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
    saved.assertHolds(server.chart);
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
