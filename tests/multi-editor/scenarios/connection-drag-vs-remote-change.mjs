// A drags a new connection from n1 to n4 and holds over n4 while B changes the chart. On the release
// the connection must exist exactly when both ends survive; a deleted end stays deleted.
import { Checks } from '../lib/checks.mjs';
import { centerOf, handleCenter, snap } from '../lib/editors.mjs';
import { connection, connections, nodeById, places, titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { armHold, endHold } from '../lib/holds.mjs';
import { moveBetween, remove, retitle, savedBy } from '../lib/remote.mjs';
import { sleep } from '../lib/browser.mjs';

export const name = 'connection-drag-vs-remote-change';
export const runs = 3;
export const cases = ['tick', 'mid'].flatMap((timing) =>
  ['other', 'delete-source', 'delete-target', 'move-target'].map((change) => ({
    name: `${timing}-${change}`,
    timing,
    change,
  })),
);

export async function run(ctx, { timing, change }) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  const armed = await armHold(ctx, timing);

  ctx.mark('A holds the connection drag');
  const n1 = await centerOf(A, 'n1');
  const n4 = await centerOf(A, 'n4');
  await A.move(n1.x, n1.y);
  await A.waitFor(`document.querySelector('button[data-tocb-connection-handle="n1|right"]')`, {
    what: 'the connection handle of n1',
  });
  const handle = await handleCenter(A, 'n1', 'right');
  await A.move(handle.x, handle.y);
  await A.down();
  await A.glide(n4.x, n4.y, { steps: 4 });

  ctx.mark(`B changes: ${change}`);
  if (change === 'other') await retitle(ctx, B, 'n6', '-B1');
  if (change === 'delete-source') await remove(ctx, B, 'n1');
  if (change === 'delete-target') await remove(ctx, B, 'n4');
  if (change === 'move-target') await moveBetween(ctx, B, 'n4', 'n5', 'n6');
  const duringHold = await endHold(ctx, timing, armed, snap);
  await A.up();
  await sleep(500);

  const checks = new Checks();
  const { server } = await settleAndCheck({ mock, token, pages: [A, B], checks });
  const chart = server.chart;
  const expected = {
    other: { gone: [], conns: ['n1->n3', 'n1->n4', 'n2->n4', 'n3->n5'] },
    'delete-source': { gone: ['n1'], conns: ['n2->n4', 'n3->n5'] },
    'delete-target': { gone: ['n4'], conns: ['n1->n3', 'n3->n5'] },
    'move-target': { gone: [], conns: ['n1->n3', 'n1->n4', 'n2->n4', 'n3->n5'] },
  }[change];
  for (const id of expected.gone) checks.ok(`${id} stays deleted`, !nodeById(chart, id));
  checks.eq('connections on the server', connections(chart), expected.conns);
  if (change === 'other') checks.eq("B's retitle kept", titles(chart).n6, 'Foxtrot-B1');
  if (change === 'move-target') checks.eq("B's move of n4 kept", places(chart).n4, 's1c1');
  if (expected.conns.includes('n1->n4')) {
    checks.ok(
      'the new connection has the default confidence',
      typeof connection(chart, 'n1', 'n4').confidence === 'number',
    );
  }
  checks.ok(
    "A's drag made the connection locally (a save carried it)",
    savedBy(ctx, 'A', armed.from, (c) => c.connections.includes('n1->n4')),
  );
  // After the release the connection ghost and handles must be gone: nothing stuck mid-gesture.
  checks.eq(
    'no connection drag left on A',
    await A.eval(`!!document.querySelector('[data-testid=connection-drag-ghost]')`),
    false,
  );
  checks.note(`during the hold A showed n6=${JSON.stringify(duringHold.titles.n6)}`);
  return { checks };
}
