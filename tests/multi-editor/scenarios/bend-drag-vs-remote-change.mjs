// A drags the midpoint handle of n1->n3 (adding a bend) while B changes the chart. The bend lands
// unless B deleted the connection, in which case it stays deleted.
//
// `tick`: a poll tick falls inside a hold. `mid`: a slow answer carrying B's change arrives mid-drag.
// `sweep`: the pointer never rests (an event every ~20 ms, so no idle commit) across the answer.
import { docState, midpointHandle, pathPoint, snap } from '../lib/editors.mjs';
import { connection, connections, titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { armHold, assertHoldingBack, endHold } from '../lib/holds.mjs';
import { deleteConnection, retitle } from '../lib/remote.mjs';
import { sleep } from '../lib/browser.mjs';

export const name = 'bend-drag-vs-remote-change';
export const runs = 3;
export const cases = ['tick', 'mid', 'sweep'].flatMap((timing) =>
  ['other', 'delete-connection'].map((change) => ({ name: `${timing}-${change}`, timing, change })),
);

const SWEEP = { delay: 16_000, readAt: 8_000 };

export async function run(ctx, { timing, change }) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  const slow = timing === 'sweep' ? SWEEP : undefined;
  const armed = await armHold(ctx, timing === 'sweep' ? 'mid' : timing, slow);

  ctx.mark('A holds the bend drag');
  const hover = await pathPoint(A, 0, 0.3);
  await A.move(hover.x, hover.y);
  await sleep(300);
  const handle = await midpointHandle(A, 'n1', 'n3');
  await A.move(handle.x, handle.y);
  await A.down();
  const t0 = Date.now();
  if (timing === 'sweep') {
    await A.glide(handle.x, handle.y - 40, { steps: 20, ms: 400 });
  } else {
    await A.glide(handle.x, handle.y - 60, { steps: 4 });
  }

  const bChange = (async () => {
    ctx.mark(`B changes: ${change}`);
    if (change === 'other') await retitle(ctx, B, 'n6', '-B1');
    else await deleteConnection(ctx, B);
  })();

  let duringHold;
  if (timing === 'sweep') {
    // One unbroken glide that ends 1.5 s after the slow answer is due.
    const total = SWEEP.delay + 1500 - (Date.now() - t0);
    await Promise.all([
      bChange,
      A.glide(handle.x + 50, handle.y - 90, { steps: Math.round(total / 20), ms: total }),
    ]);
    const answered = mock.since(
      armed.from,
      (e) => e.kind === 'POLL' && e.who === 'A' && e.delay === SWEEP.delay,
    )[0];
    if (!answered || answered.version !== mock.state(token).version) {
      throw new Error("the slow poll did not carry B's change");
    }
    await assertHoldingBack(ctx);
    duringHold = await snap(A);
  } else {
    await bChange;
    duringHold = await endHold(ctx, timing, armed, snap, slow);
  }
  // The bend is a preview in A's chart until the release. Without it the drag never started.
  const preview = connection((await docState(A)).live, 'n1', 'n3');
  if (preview?.waypoints?.length !== 1) throw new Error('the bend drag left no preview in A');
  await A.up();
  await sleep(500);

  const { checks } = ctx;
  const { server } = await settleAndCheck({ mock, token, pages: [A, B], checks });
  const chart = server.chart;
  if (change === 'other') {
    checks.eq('connections on the server', connections(chart), ['n1->n3', 'n2->n4', 'n3->n5']);
    const bend = connection(chart, 'n1', 'n3')?.waypoints;
    checks.ok(
      "A's bend landed on n1->n3",
      Array.isArray(bend) && bend.length === 1 && bend[0].dy < -20,
      JSON.stringify(bend),
    );
    checks.eq("B's retitle kept", titles(chart).n6, 'Foxtrot-B1');
  } else {
    checks.eq('connections on the server', connections(chart), ['n2->n4', 'n3->n5']);
    checks.eq(
      'both ends of the deleted connection remain',
      [titles(chart).n1, titles(chart).n3],
      ['Alpha', 'Charlie'],
    );
  }
  // Two routes are both right: the release is saved against the old version and answered 409, or
  // the next poll's landing merges into the released chart before the save leaves.
  checks.note(
    mock.since(armed.from, (e) => e.kind === 'POST-409' && e.who === 'A').length > 0
      ? "A's release was answered 409 and merged"
      : "the landing merged before A's save left",
  );
  checks.note(`during the hold A showed n6=${JSON.stringify(duringHold.titles.n6)}`);
}
