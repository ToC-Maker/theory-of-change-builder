// An AI chat reply is computed against the chart as it was sent and merged into whatever the chart
// is when it arrives: other people's edits and the sender's own hand edits made while it streamed
// are kept, and where the reply and a person changed the same thing the person wins.
//
// edits-elsewhere: B retitles n2 and A retitles n1 while the reply (which retitles n6) streams.
// yields-on-same-field: the reply retitles n2 and n6; B retitles n2 meanwhile, so B's title stays.
// edit-of-deleted-node: the reply retitles n4; B deletes n4 meanwhile, so n4 stays deleted.
// column-insert-during-drag: the reply inserts a column at the front of the second section while A
//   holds a node drag over a column; on release the node lands in the column under the pointer.
import {
  closeEditor,
  columnAt,
  docState,
  editTitle,
  holdNodeDrag,
  sendChat,
} from '../lib/editors.mjs';
import { connections, nodeById, places, titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { dropPoint, landed, remove, retitle } from '../lib/remote.mjs';
import { sleep } from '../lib/browser.mjs';

export const name = 'ai-reply-merges';
export const runs = 4;
export const cases = [
  { name: 'edits-elsewhere' },
  { name: 'yields-on-same-field' },
  { name: 'edit-of-deleted-node' },
  { name: 'column-insert-during-drag' },
];

const update = (path, value) => ({ type: 'update', path, value });
const N2 = 'sections.0.columns.0.nodes.1.title';
const N4 = 'sections.1.columns.0.nodes.1.title';
const N6 = 'sections.1.columns.1.nodes.1.title';
const AI_COLUMN = {
  type: 'insert',
  path: 'sections.1.columns.0',
  value: {
    nodes: [
      {
        id: 'ai-node',
        title: 'AI node',
        text: 'Added by the reply.',
        connectionIds: [],
        connections: [],
        yPosition: 120,
        width: 192,
        color: '#ffffff',
      },
    ],
  },
};

// The reply must still be streaming once A's edit and B's edit are made and A's tab has taken B's by
// polling: 11.5 s for the two edits and the saves, plus one poll interval.
const streamMs = (pollMs) => 11_500 + pollMs;

async function replyApplied(ctx, from) {
  const { mock, A } = ctx;
  await mock.waitFor(() => mock.since(from, (e) => e.kind === 'AI-end').length, {
    timeout: 40_000,
    what: 'the reply to finish streaming',
  });
  // The reply is merged and saved by A, then B's tab takes it by polling.
  await sleep(500);
  await A.waitFor(`window.__doc().getStatus().unsaved === false`, {
    timeout: 20_000,
    what: 'A to save the merged reply',
  });
}

export async function run(ctx, kase) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  const { checks } = ctx;
  const from = mock.events.length;

  const edits = {
    'edits-elsewhere': [update(N6, 'Foxtrot +AI')],
    'yields-on-same-field': [update(N2, 'Bravo +AI'), update(N6, 'Foxtrot +AI')],
    'edit-of-deleted-node': [update(N4, 'Delta +AI')],
    'column-insert-during-drag': [AI_COLUMN],
  }[kase.name];
  mock.nextAi({ ms: streamMs(ctx.pollMs), edits });
  ctx.mark('A sends a chat message');
  await sendChat(A, 'Please improve the chart');
  await mock.waitFor(() => mock.since(from, (e) => e.kind === 'AI-start').length, {
    what: 'the reply to start',
  });

  if (kase.name === 'column-insert-during-drag') {
    // Held 40 px left of the middle of n5's column: the inserted column re-centres the chart, and the
    // middle of the column would end up in the gap between two columns.
    const target = await dropPoint(A, 'n5', 'n6');
    await holdNodeDrag(A, 'n1', target.x - 40, target.y);
    await mock.waitFor(() => mock.since(from, (e) => e.kind === 'AI-end').length, {
      timeout: 40_000,
      what: 'the reply',
    });
    await A.waitFor(`window.__doc().getCommitted().sections[1].columns.length === 3`, {
      timeout: 15_000,
      what: "the reply's column to reach A",
    });
    await sleep(800);
    const under = await columnAt(A, A.pointer.x, A.pointer.y);
    if (!under) {
      await ctx.shot(A, 'no-column-under-pointer');
      const columns = await A.eval(
        `[...document.querySelectorAll('[data-column]')].map((c) => [c.dataset.column, Math.round(c.getBoundingClientRect().x), Math.round(c.getBoundingClientRect().right), Math.round(c.getBoundingClientRect().y), Math.round(c.getBoundingClientRect().bottom)])`,
      );
      throw new Error(
        `no column under the pointer at ${A.pointer.x},${A.pointer.y}: ${JSON.stringify(columns)}`,
      );
    }
    await A.up();
    await replyApplied(ctx, from);
    const settled = await settleAndCheck({ mock, token, pages: [A, B], checks });
    const chart = settled.server.chart;
    const [section, column] = under.split('-').map(Number);
    const staleTarget = places((await docState(A)).committed).n5;
    checks.note(`column under the pointer ${under}; n5's column (the stale target) ${staleTarget}`);
    if (`s${section}c${column}` === staleTarget) {
      throw new Error(
        "the column under the pointer is still n5's: this run could not tell a stale target from a fresh one",
      );
    }
    checks.eq(
      'n1 landed in the column under the pointer',
      places(chart).n1,
      `s${section}c${column}`,
    );
    checks.eq(
      "the reply's column and node are there",
      [
        chart.sections[1].columns.length,
        !!nodeById(chart, 'ai-node') || Object.values(titles(chart)).includes('AI node'),
      ],
      [3, true],
    );
    checks.note(`column under the pointer at release: ${under}`);
    return;
  }

  // A changes n1 and B changes something else while the reply streams.
  await editTitle(A, 'n1', '-A');
  await closeEditor(A);
  if (kase.name === 'edit-of-deleted-node') await remove(ctx, B, 'n4');
  else await retitle(ctx, B, 'n2', '-B');
  // Both people's edits must be on the server and in A's chart before the reply arrives, or the
  // reply would not be merged against anything and the outcome would say nothing about merging.
  await landed(ctx, A);
  await A.waitFor(`window.__doc().getStatus().unsaved === false`, { what: "A's own edit saved" });
  if (mock.since(from, (e) => e.kind === 'AI-end').length) {
    throw new Error('the reply finished before the edits it must be merged with were made');
  }
  await replyApplied(ctx, from);

  const settled = await settleAndCheck({ mock, token, pages: [A, B], checks });
  const chart = settled.server.chart;
  const want = {
    'edits-elsewhere': {
      n1: 'Alpha-A',
      n2: 'Bravo-B',
      n3: 'Charlie',
      n4: 'Delta',
      n5: 'Echo',
      n6: 'Foxtrot +AI',
    },
    'yields-on-same-field': {
      n1: 'Alpha-A',
      n2: 'Bravo-B',
      n3: 'Charlie',
      n4: 'Delta',
      n5: 'Echo',
      n6: 'Foxtrot +AI',
    },
    'edit-of-deleted-node': {
      n1: 'Alpha-A',
      n2: 'Bravo',
      n3: 'Charlie',
      n5: 'Echo',
      n6: 'Foxtrot',
    },
  }[kase.name];
  checks.eq('titles on the server', titles(chart), want);
  if (kase.name === 'edit-of-deleted-node')
    checks.eq('connections', connections(chart), ['n1->n3', 'n3->n5']);
  checks.eq("the reply reached B's page", settled.models[1].titles, want);
}
