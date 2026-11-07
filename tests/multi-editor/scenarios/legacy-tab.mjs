// A tab still running the previous client (it sends no version, so the server applies its whole-chart
// save as the last write and advances the version) shares a chart with a tab running the current one.
//
// old-saves-while-new-is-stale: the old tab saves; the current tab, which has not yet polled, then
//   edits another node. Its save is answered 409 and merged around the old tab's write.
// old-saves-while-new-types: the old tab saves while the current tab is typing; the typed text and
//   the old tab's change both end up on the server.
// old-tab-overwrites-newer-edit: the old tab, which never saw the current tab's edit, saves its whole
//   chart over it. This is the accepted behaviour of the transition (an old tab can overwrite a
//   collaborator, as before versions); the check is that it happens as documented and that the
//   current tab then follows the server instead of getting stuck.
import { Checks } from '../lib/checks.mjs';
import {
  closeEditor,
  editTitle,
  focusTitle,
  hide,
  selectNode,
  show,
  snap,
  untilServer,
} from '../lib/editors.mjs';
import { titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { sleep } from '../lib/browser.mjs';
import { isDeepStrictEqual } from 'node:util';

export const name = 'legacy-tab';
export const runs = 4;
export const needs = ['A', 'old'];
export const cases = [
  { name: 'old-saves-while-new-is-stale' },
  { name: 'old-saves-while-new-types' },
  { name: 'old-tab-overwrites-newer-edit' },
];

/** The old tab edits n2's title and saves; resolves once the server holds it. */
async function oldRetitles(ctx) {
  const { mock, token, old } = ctx;
  await editTitle(old, 'n2', '-O');
  await closeEditor(old);
  await untilServer(mock, token, (c) => titles(c).n2 === 'Bravo-O', { what: "the old tab's save" });
}

export async function run(ctx, kase) {
  const { mock, token, A, old } = ctx;
  await ctx.open({ A: 'new', old: 'old' });
  const from = mock.events.length;
  const checks = new Checks();
  let want;

  if (kase.name === 'old-saves-while-new-is-stale') {
    await hide(A);
    await oldRetitles(ctx);
    const sent = mock.events.length;
    await editTitle(A, 'n1', '-A');
    await closeEditor(A);
    // The save must leave before the tab polls again, or the poll's landing would pre-empt the 409.
    await mock.waitFor(
      () => mock.since(sent, (e) => e.kind === 'POST-start' && e.who === 'A').length,
      {
        what: "the current tab's save",
      },
    );
    await show(A);
    want = { n1: 'Alpha-A', n2: 'Bravo-O' };
    await untilServer(
      mock,
      token,
      (c) => titles(c).n1 === 'Alpha-A' && titles(c).n2 === 'Bravo-O',
      {
        what: 'both edits on the server',
      },
    );
    checks.ok(
      'the current tab was answered 409 and merged',
      mock.since(from, (e) => e.kind === 'POST-409' && e.who === 'A').length > 0,
    );
  } else if (kase.name === 'old-saves-while-new-types') {
    await selectNode(A, 'n1');
    await focusTitle(A);
    await hide(A);
    await oldRetitles(ctx);
    mock.next('A', 'pollChart', { delay: 1500 });
    await show(A);
    await A.type('XYZ');
    want = { n1: 'AlphaXYZ', n2: 'Bravo-O' };
    await untilServer(
      mock,
      token,
      (c) => titles(c).n1 === 'AlphaXYZ' && titles(c).n2 === 'Bravo-O',
      {
        what: 'both edits on the server',
      },
    );
  } else {
    await editTitle(A, 'n1', '-A');
    await closeEditor(A);
    await untilServer(mock, token, (c) => titles(c).n1 === 'Alpha-A', {
      what: "the current tab's save",
    });
    await oldRetitles(ctx);
    want = { n1: 'Alpha', n2: 'Bravo-O' };
    checks.note("the old tab's whole-chart save reverted n1 to Alpha: accepted legacy behaviour");
  }

  const legacy = mock.since(from, (e) => e.kind === 'updateChart.legacy');
  checks.ok("the old tab's save was applied as a legacy save", legacy.length >= 1);
  checks.ok(
    'only the old tab saved without a version',
    legacy.every((e) => e.who === 'old'),
  );

  const settled = await settleAndCheck({ mock, token, pages: [A], checks });
  const chart = settled.server.chart;
  checks.eq('the titles that were edited', { n1: titles(chart).n1, n2: titles(chart).n2 }, want);
  checks.eq(
    'the other titles',
    { n3: titles(chart).n3, n4: titles(chart).n4, n5: titles(chart).n5, n6: titles(chart).n6 },
    {
      n3: 'Charlie',
      n4: 'Delta',
      n5: 'Echo',
      n6: 'Foxtrot',
    },
  );

  // The old tab polls the chart itself every 10 s or more; it follows the server once it has no unsaved change.
  const t0 = Date.now();
  let oldTitles;
  while (Date.now() - t0 < 90_000) {
    oldTitles = (await snap(old)).titles;
    if (isDeepStrictEqual(oldTitles, titles(chart))) break;
    await sleep(2000);
  }
  checks.note(
    `the old tab showed the server's titles after ${Math.round((Date.now() - t0) / 1000)} s: ${isDeepStrictEqual(oldTitles, titles(chart))}`,
  );
  return { checks };
}
