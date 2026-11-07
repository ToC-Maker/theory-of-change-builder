// A types without pausing, in the middle of n1's title, for 16 seconds while B retitles n6 three
// times. Three landings arrive during the typing; the caret must stay one place right of the last
// key after every keystroke, focus must stay in the input, and every key must reach the server.
import { Checks } from '../lib/checks.mjs';
import { focusTitle, selectNode, titleInput } from '../lib/editors.mjs';
import { titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { retitle } from '../lib/remote.mjs';
import { sleep } from '../lib/browser.mjs';

export const name = 'continuous-typing-across-landings';
export const runs = 6;

const TYPING_MS = 16_000;

export async function run(ctx) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  const from = mock.events.length;
  await selectNode(A, 'n1');
  await focusTitle(A);
  await A.eval(`(() => {
    const i = document.querySelector('.node-editor input[aria-label="Node title"]');
    i.setSelectionRange(3, 3);
    window.__focusLog = [];
    let last = '';
    setInterval(() => {
      const a = document.activeElement;
      const label = a ? a.getAttribute('aria-label') || a.tagName : 'none';
      if (label !== last) { last = label; window.__focusLog.push([Math.round(performance.now()), label]); }
    }, 10);
    return true;
  })()`);

  ctx.mark('A types, B retitles n6 three times');
  const remote = (async () => {
    for (const suffix of ['-B1', '-B2', '-B3']) {
      await sleep(1500);
      await retitle(ctx, B, 'n6', suffix);
    }
  })();

  const checks = new Checks();
  let jumps = 0;
  let typed = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < TYPING_MS) {
    await A.type('a');
    typed++;
    const now = await titleInput(A);
    if (!now?.focused || now.start !== 3 + typed || now.end !== 3 + typed) {
      jumps++;
      if (jumps <= 5) checks.lost.push(`after key ${typed}: ${JSON.stringify(now)}`);
    }
  }
  await remote;
  const focusLog = await A.eval('window.__focusLog');
  const expected = 'Alp' + 'a'.repeat(typed) + 'ha';
  checks.ok(
    'focus stayed on the title input throughout',
    focusLog.every(([, label]) => label === 'Node title'),
    JSON.stringify(focusLog),
  );
  checks.eq('input text', (await titleInput(A))?.value, expected);

  const settled = await settleAndCheck({ mock, token, pages: [A, B], checks });
  checks.eq('n1 on the server', titles(settled.server.chart).n1, expected);
  checks.eq('n6 on the server', titles(settled.server.chart).n6, 'Foxtrot-B1-B2-B3');
  checks.note(
    `${typed} keys typed; landings: ${mock.since(from, (e) => e.kind === 'POLL' && e.who === 'A' && e.changed).length} changed polls`,
  );
  return { checks, caretJumps: jumps };
}
