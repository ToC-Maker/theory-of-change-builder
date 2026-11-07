// A holds a node drag for several seconds while B changes the chart. Nothing may be lost or come
// back: B's change is kept, A's drop lands, and a delete beats the move.
//
// `tick-*`: a poll tick falls inside the hold (polls are skipped during a drag).
// `mid-*`: a slow poll is already in flight when the drag starts, and its answer, which carries B's
// change, arrives mid-drag (the answer is dropped and fetched again after the release).
import { Checks } from '../lib/checks.mjs';
import { holdNodeDrag, snap } from '../lib/editors.mjs';
import { connections, places, titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { dropPoint, moveBetween, remove, retitle, savedBy } from '../lib/remote.mjs';
import { armHold, endHold } from '../lib/holds.mjs';

export const name = 'node-drag-vs-remote-change';
export const runs = 4;
export const cases = ['tick', 'mid'].flatMap((timing) =>
  ['other', 'move', 'delete'].map((change) => ({ name: `${timing}-${change}`, timing, change })),
);

const SEED_TITLES = {
  n1: 'Alpha',
  n2: 'Bravo',
  n3: 'Charlie',
  n4: 'Delta',
  n5: 'Echo',
  n6: 'Foxtrot',
};

export async function run(ctx, { timing, change }) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  const target = await dropPoint(A, 'n5', 'n6');

  const armed = await armHold(ctx, timing);
  ctx.mark('A holds the drag');
  await holdNodeDrag(A, 'n1', target.x, target.y);

  ctx.mark(`B changes: ${change}`);
  if (change === 'other') await retitle(ctx, B, 'n6', '-B1');
  if (change === 'move') await moveBetween(ctx, B, 'n1', 'n3', 'n4');
  if (change === 'delete') await remove(ctx, B, 'n1');
  const duringHold = await endHold(ctx, timing, armed, snap);
  await A.up();

  const checks = new Checks();
  const { server } = await settleAndCheck({ mock, token, pages: [A, B], checks });
  const expectedTitles = { ...SEED_TITLES };
  const expectedConnections = ['n1->n3', 'n2->n4', 'n3->n5'];
  if (change === 'other') expectedTitles.n6 = 'Foxtrot-B1';
  if (change === 'delete') {
    delete expectedTitles.n1;
    expectedConnections.splice(0, 1);
  }
  checks.eq('titles on the server', titles(server.chart), expectedTitles);
  checks.eq('connections on the server', connections(server.chart), expectedConnections);
  if (change !== 'delete') {
    checks.eq("A's drop target holds n1", places(server.chart).n1, 's1c1');
  }
  checks.ok(
    "A's drop moved n1 locally (a save carried it)",
    savedBy(ctx, 'A', armed.from, (c) => c.places.n1 === 's1c1'),
  );
  checks.ok(
    'A saved the drop against the old version and merged around B (a 409)',
    mock.since(armed.from, (e) => e.kind === 'POST-409' && e.who === 'A').length > 0,
  );
  checks.note(
    `during the hold A showed ${JSON.stringify(duringHold.titles.n6)} for n6 (B's change: ${change})`,
  );
  return { checks };
}
