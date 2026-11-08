// A types without pausing, in the middle of n1's title, while B retitles n6 three times with more
// than a poll interval between them. Each retitle is its own landing, so three arrive during the
// typing; the caret must stay one place right of the last key after every keystroke, focus must stay
// in the input, and every key must reach the server.
import { focusTitle, selectNode, titleInput } from '../lib/editors.mjs';
import { titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { retitle } from '../lib/remote.mjs';
import { sleep } from '../lib/browser.mjs';

export const name = 'continuous-typing-across-landings';
export const runs = 6;

// B waits one poll interval before each retitle, so a poll tick falls between any two of them. The
// typing outlasts all three plus the tick that brings the last one; one retitle takes B up to
// RETITLE_MS.
const RETITLE_MS = 3500;
const typingMs = (pollMs) => 3 * (pollMs + RETITLE_MS) + pollMs + 1000;

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
  let remoteError;
  const remote = (async () => {
    for (const suffix of ['-B1', '-B2', '-B3']) {
      await sleep(ctx.pollMs);
      await retitle(ctx, B, 'n6', suffix);
    }
  })().catch((error) => {
    remoteError = error;
  });

  const { checks } = ctx;
  let typed = 0;
  let expectedCaret = 3;
  const t0 = Date.now();
  while (Date.now() - t0 < typingMs(ctx.pollMs) && !remoteError) {
    await A.type('a');
    typed++;
    expectedCaret++;
    const now = await titleInput(A);
    if (!now?.focused || now.start !== expectedCaret || now.end !== expectedCaret) {
      // Counted once, then followed: one jump must not count again for every later key.
      checks.caretJumps++;
      checks.lost.push(`after key ${typed}: ${JSON.stringify(now)}`);
      expectedCaret = now?.start ?? expectedCaret;
    }
  }
  await remote;
  if (remoteError) throw remoteError;
  const landings = mock.since(from, (e) => e.kind === 'POLL' && e.who === 'A' && e.changed).length;
  // The scenario is about landings during typing; without one it has tested nothing.
  if (landings === 0) throw new Error('no remote change reached A while it was typing');
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
  checks.note(`${typed} keys typed; ${landings} polls brought a change`);
}
