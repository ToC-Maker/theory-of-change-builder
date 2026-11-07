// A is composing text with an input method in n1's title (the composition is underlined and not yet
// committed) when a change to another field lands. The composition must not be interrupted: the same
// input element stays, keeps focus, no compositionend fires before the commit, and the committed
// text reaches the server along with the remote change.
//
// other-node: B retitles n6. same-node-other-fields: a collaborator's save changes n1's details,
// width and colour but not its title.
import { focusTitle, selectNode, titleInput } from '../lib/editors.mjs';
import { nodeById, titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { landed, retitle } from '../lib/remote.mjs';
import { sleep } from '../lib/browser.mjs';

export const name = 'ime-composition-during-landing';
export const runs = 5;
export const cases = [{ name: 'other-node' }, { name: 'same-node-other-fields' }];

const TITLE = '.node-editor input[aria-label="Node title"]';

export async function run(ctx, kase) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  await selectNode(A, 'n1');
  await focusTitle(A);
  await A.eval(`(() => {
    const input = document.querySelector('${TITLE}');
    window.__ime = { input, events: [] };
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input', 'blur', 'focus']) {
      input.addEventListener(type, (e) => window.__ime.events.push({ type, data: e.data ?? null, value: input.value }), true);
    }
    return true;
  })()`);

  await A.imeCompose('ni');
  await sleep(300);
  const during = (await titleInput(A)).value;
  ctx.mark('the landing, mid-composition');
  if (kase.name === 'other-node') {
    await retitle(ctx, B, 'n6', '-B1');
  } else {
    const chart = mock.state(token).chart;
    const n1 = nodeById(chart, 'n1').node;
    Object.assign(n1, { text: 'Remote details.', width: 272, color: '#fde68a' });
    mock.writeDirect(token, chart);
  }
  await landed(ctx, A);
  await sleep(400);
  const afterLanding = await titleInput(A);
  await A.imeCompose('nihao');
  await sleep(300);
  await A.insertText('你好');
  await sleep(600);

  const { checks } = ctx;
  const state = await A.eval(`(() => ({
    sameInput: window.__ime.input === document.querySelector('${TITLE}'),
    events: window.__ime.events,
  }))()`);
  const types = state.events.map((e) => e.type);
  const end = types.indexOf('compositionend');
  checks.ok('the title input is the same element throughout', state.sameInput);
  checks.eq('compositionstart fired once', types.filter((t) => t === 'compositionstart').length, 1);
  checks.ok(
    'the composition ended only at the commit',
    end === types.length - 1 || types.slice(end + 1).every((t) => t === 'input'),
    types.join(','),
  );
  checks.ok('no blur during the composition', !types.slice(0, end).includes('blur'));
  checks.ok(
    'the input kept focus through the landing',
    afterLanding?.focused,
    JSON.stringify(afterLanding),
  );
  checks.note(
    `value mid-composition: ${JSON.stringify(during)}; right after the landing: ${JSON.stringify(afterLanding?.value)}`,
  );
  checks.eq('input text after the commit', (await titleInput(A))?.value, 'Alpha你好');

  const settled = await settleAndCheck({ mock, token, pages: [A, B], checks });
  const chart = settled.server.chart;
  checks.eq('n1 on the server', titles(chart).n1, 'Alpha你好');
  if (kase.name === 'other-node') checks.eq("B's retitle kept", titles(chart).n6, 'Foxtrot-B1');
  else {
    const n1 = nodeById(chart, 'n1').node;
    checks.eq(
      "the collaborator's fields kept",
      [n1.text, n1.width, n1.color],
      ['Remote details.', 272, '#fde68a'],
    );
  }
}
