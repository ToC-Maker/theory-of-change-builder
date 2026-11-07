// A types into n1's details (the rich-text editor) at the moment B's change to n2 arrives. The typed
// text must reach the chart and the server, and the editor must keep focus.
//
// The keystroke is made inside the response handler of A's held-back poll: the closest a keystroke
// can come before the app processes the answer.
import { Checks } from '../lib/checks.mjs';
import { centerOfSelector, detailsText, hide, selectNode } from '../lib/editors.mjs';
import { nodeById, titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { retitle } from '../lib/remote.mjs';
import { sleep } from '../lib/browser.mjs';

export const name = 'details-typing-across-landing';
export const runs = 8;

const DELAY = 1500;
const EDITOR = '.node-editor [contenteditable=true]';

const script = `(() => {
  const editor = () => document.querySelector('${EDITOR}');
  const t0 = performance.now();
  window.__trace = [];
  const sampler = setInterval(() => {
    const e = editor();
    const s = window.__snap();
    window.__trace.push({
      t: Math.round(performance.now() - t0), kind: 'S', text: e && e.innerText.replace(/\\n+/g, '|'),
      n2: s.titles.n2, focused: !!e && e.contains(document.activeElement),
    });
  }, 20);
  setTimeout(() => clearInterval(sampler), ${DELAY} + 3000);
  const original = window.fetch;
  let armed = false;
  window.fetch = function (url, ...rest) {
    const mine = /pollChart/.test(String(url)) && !armed && (armed = true);
    return original.call(this, url, ...rest).then((res) => {
      if (mine) {
        editor().focus();
        const ok = document.execCommand('insertText', false, 'XYZ');
        window.__trace.push({ t: Math.round(performance.now() - t0), kind: 'KEY in response handler', ok });
      }
      return res;
    });
  };
  delete document.hidden;
  document.dispatchEvent(new Event('visibilitychange'));
  return 'armed';
})()`;

export async function run(ctx) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  await selectNode(A, 'n1');
  await A.waitFor(`document.querySelector('${EDITOR}')`, { what: 'the details editor' });
  const editor = await centerOfSelector(A, EDITOR);
  await A.click(editor.x, editor.y);
  await A.press('Control+End');
  await hide(A);
  await retitle(ctx, B, 'n2', '-B');
  mock.next('A', 'pollChart', { delay: DELAY });
  const before = await detailsText(A);
  await A.eval(script);
  await sleep(DELAY + 3200);
  const trace = await A.eval('window.__trace');

  const checks = new Checks();
  const key = trace.find((e) => e.kind.startsWith('KEY'));
  checks.ok('the keystroke was typed (execCommand accepted it)', key?.ok === true);
  const samples = trace.filter((e) => e.kind === 'S');
  const landing = samples.find((e) => e.n2 === 'Bravo-B');
  checks.ok("B's retitle reached A's canvas", !!landing);
  checks.ok(
    'the editor kept focus through the landing',
    samples.filter((e) => e.t >= key.t).every((e) => e.focused),
  );
  const final = await detailsText(A);
  checks.ok("typed text is in A's editor", final.includes('XYZ'), `${before} -> ${final}`);

  const settled = await settleAndCheck({ mock, token, pages: [A, B], checks });
  const text = nodeById(settled.server.chart, 'n1').node.text;
  checks.ok('typed text reached the server', text.includes('XYZ'), JSON.stringify(text));
  checks.eq('n2 on the server', titles(settled.server.chart).n2, 'Bravo-B');
  checks.note(`n1.text on the server: ${JSON.stringify(text)}`);
  return { checks };
}
