// A types into n1's title while B's change to n2 lands. The typed text must reach the chart and the
// server, the input must never show an earlier value, and focus and caret must stay.
//
// A's poll is held back so its answer, which carries B's retitle, arrives at a chosen moment:
// the keys are typed 40-300 ms before it, or the last key inside the response handler itself
// (the closest a keystroke can come before the app processes the answer).
import { focusTitle, hide, selectNode } from '../lib/editors.mjs';
import { titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { retitle } from '../lib/remote.mjs';
import { sleep } from '../lib/browser.mjs';

export const name = 'title-typing-across-landing';
export const runs = 8;
export const cases = [
  { name: 'keys-300-190-80', before: [300, 190, 80] },
  { name: 'keys-250-150-60', before: [250, 150, 60] },
  { name: 'keys-120-80-40', before: [120, 80, 40] },
  { name: 'last-key-in-response-handler', before: [300, 150], inHandler: true },
];

const DELAY = 1500;
// A keystroke costs the page several hundred milliseconds here (React in development mode, a loaded
// machine), so which of these runs before the answer is processed varies from run to run. Each key
// appends to the input as typing does, so the final text is `base` plus the keys in the order they ran.
const CHARS = ['X', 'Y', 'Z'];

const script = ({ before, inHandler }) => `(() => {
  const input = () => document.querySelector('.node-editor input[aria-label="Node title"]');
  const setValue = (v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input(), v);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  };
  const base = input().value;
  const t0 = performance.now();
  const T = () => Math.round(performance.now() - t0);
  window.__trace = [];
  const log = (kind, detail) => window.__trace.push({ t: T(), kind, detail });
  const sampler = setInterval(() => {
    const i = input();
    const s = window.__snap();
    window.__trace.push({
      t: T(), kind: 'S', input: i && i.value, n1: s.titles.n1, n2: s.titles.n2, pill: s.pill,
      focused: !!i && document.activeElement === i, caret: i && i.selectionStart,
    });
  }, 20);
  setTimeout(() => clearInterval(sampler), ${DELAY} + 3000);
  const keys = ${JSON.stringify(before)};
  const chars = ${JSON.stringify(CHARS)};
  const type = (ch, kind) => { setValue(input().value + ch); log(kind, ch); };
  keys.forEach((k, n) => setTimeout(() => type(chars[n], 'KEY'), ${DELAY} - k));
  ${
    inHandler
      ? `const original = window.fetch;
  let armed = false;
  window.fetch = function (url, ...rest) {
    const mine = /pollChart/.test(String(url)) && !armed && (armed = true);
    return original.call(this, url, ...rest).then((res) => {
      if (mine) type(chars[keys.length], 'KEY in response handler');
      return res;
    });
  };`
      : ''
  }
  delete document.hidden;
  document.dispatchEvent(new Event('visibilitychange'));
  return base;
})()`;

export async function run(ctx, kase) {
  const { before, inHandler } = kase;
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  await selectNode(A, 'n1');
  await focusTitle(A);
  // Hidden, A does not poll, so B's save below is not seen until the held-back poll.
  await hide(A);
  await retitle(ctx, B, 'n2', '-B');
  mock.next('A', 'pollChart', { delay: DELAY });
  const base = await A.eval(script(kase));
  await sleep(DELAY + 3200);
  const trace = await A.eval('window.__trace');

  const { checks } = ctx;
  const keysRun = trace.filter((e) => e.kind.startsWith('KEY'));
  const typedAll = base + keysRun.map((e) => e.detail).join('');
  const samples = trace.filter((e) => e.kind === 'S');
  const firstKey = keysRun[0]?.t ?? 0;
  const landing = samples.find((e) => e.n2 === 'Bravo-B');
  checks.eq('keys typed', keysRun.length, before.length + (inHandler ? 1 : 0));
  checks.ok("B's retitle reached A's canvas", !!landing);
  if (landing) {
    const keysAfter = keysRun.filter((e) => e.t > landing.t).length;
    checks.note(`${keysAfter} of ${keysRun.length} keys ran after the landing was shown`);
  }
  // Never an earlier value than one already shown, never lost focus, caret at the end of what is typed.
  let longest = 0;
  for (const e of samples.filter((s) => s.t >= firstKey)) {
    // A closed editor shows no input: that is a failure to report, not a crash.
    const value = e.input ?? '';
    checks.ok(
      `input kept its text at ${e.t} ms`,
      e.input !== null && value.startsWith(base) && value.length >= longest,
      JSON.stringify(e.input),
    );
    longest = Math.max(longest, value.length);
    checks.ok(`input kept focus at ${e.t} ms`, e.focused);
    checks.ok(
      `caret at the end of the input at ${e.t} ms`,
      e.caret === value.length,
      `${e.caret}/${value.length}`,
    );
    if (checks.lost.length > 6) break;
  }
  checks.eq('input text at the end', samples.at(-1)?.input, typedAll);

  const settled = await settleAndCheck({ mock, token, pages: [A, B], checks });
  checks.eq('n1 on the server', titles(settled.server.chart).n1, typedAll);
  checks.eq('n2 on the server', titles(settled.server.chart).n2, 'Bravo-B');
  checks.eq("A's canvas n1", settled.models[0].titles.n1, typedAll);
}
