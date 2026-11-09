// A draws fifteen new connections, one drag after another, while B saves every couple of seconds
// (it keeps typing and deleting a character in n6's title). Every connection A made must be on the
// server at the end, none overwritten by one of B's saves, and B's own typing must settle.
import { centerOf, docState, focusTitle, handleCenter, selectNode } from '../lib/editors.mjs';
import { connections, titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { sleep } from '../lib/browser.mjs';

export const name = 'connection-drags-while-other-saves';
export const runs = 3;

const PAIRS = [
  ['n1', 'n4'],
  ['n1', 'n5'],
  ['n1', 'n6'],
  ['n1', 'n2'],
  ['n2', 'n3'],
  ['n2', 'n5'],
  ['n2', 'n6'],
  ['n2', 'n1'],
  ['n3', 'n4'],
  ['n3', 'n6'],
  ['n4', 'n3'],
  ['n4', 'n5'],
  ['n4', 'n6'],
  ['n5', 'n6'],
  ['n6', 'n5'],
];
const SEED = ['n1->n3', 'n2->n4', 'n3->n5'];

const localHas = async (b, source, target) =>
  (await docState(b)).committed.sections
    .flatMap((s) => s.columns.flatMap((c) => c.nodes))
    .find((n) => n.id === source)
    ?.connections.some((c) => c.targetId === target);

/** Draws source->target by dragging from the source's handle to the target node. */
async function drawConnection(b, source, target) {
  const from = await centerOf(b, source);
  const to = await centerOf(b, target);
  await b.move(from.x, from.y);
  await b.waitFor(`document.querySelector('button[data-tocb-connection-handle^="${source}|"]')`, {
    what: `handles of ${source}`,
  });
  const handle = await handleCenter(b, source, to.x < from.x ? 'left' : 'right');
  await b.move(handle.x, handle.y);
  await b.down();
  await b.glide(to.x, to.y, { steps: 3 });
  await b.up();
}

export async function run(ctx) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  const from = mock.events.length;
  await selectNode(B, 'n6');
  await focusTitle(B);

  let stop = false;
  let toggles = 0;
  let bError;
  const bSaves = (async () => {
    // Type then delete one character, about every 1.5 s: a save from B every ~2 s.
    while (!stop) {
      await B.type('x');
      await sleep(1500);
      await B.press('Backspace');
      toggles++;
      await sleep(1500);
    }
  })().catch((error) => {
    bError = error;
  });

  const { checks } = ctx;
  const made = [];
  try {
    await sleep(3000);
    for (const [source, target] of PAIRS) {
      ctx.mark(`A draws ${source}->${target}`);
      for (let attempt = 1; attempt <= 2; attempt++) {
        await drawConnection(A, source, target);
        await sleep(700);
        if (await localHas(A, source, target)) {
          made.push(`${source}->${target}`);
          break;
        }
        if (attempt === 2)
          throw new Error(
            `the drag ${source}->${target} made no connection locally: harness gesture`,
          );
      }
      await sleep(600);
    }
  } finally {
    // B's loop always finishes its type-and-delete pair, so n6 ends as it began.
    stop = true;
    await bSaves;
  }
  if (bError) throw bError;

  const settled = await settleAndCheck({ mock, token, pages: [A, B], checks, timeout: 45_000 });
  const onServer = connections(settled.server.chart);
  const want = [...SEED, ...made].sort();
  checks.eq('connections on the server', onServer, want);
  checks.eq(
    'connections A drew that reached the server',
    onServer.filter((c) => !SEED.includes(c)).length,
    PAIRS.length,
  );
  checks.eq('n6 on the server', titles(settled.server.chart).n6, 'Foxtrot');
  checks.note(
    `${made.length} drags made locally; B toggled its title ${toggles} times; conflicts answered: ${mock.since(from, (e) => e.kind === 'POST-409' && e.who === 'A').length} for A, ${mock.since(from, (e) => e.kind === 'POST-409' && e.who === 'B').length} for B`,
  );
}
