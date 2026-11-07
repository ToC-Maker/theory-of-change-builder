// A has n1's title input focused, with the caret inside the text, when B's change lands. Focus and
// caret must stay, the next keystroke must go where the caret is, and nothing typed may be lost.
//
// typed-then-409: A types a burst while B's change is already on the server and A has not polled, so
//   A's save is answered 409 and merged while the input has focus.
// idle-poll: A is idle in the input; its poll lands B's change to another node.
// idle-poll-same-field: B rewrites the very title A has focused; the input follows B's text, keeps
//   focus, and the caret's new position is recorded.
import { Checks } from '../lib/checks.mjs';
import { focusTitle, hide, selectNode, show, titleInput } from '../lib/editors.mjs';
import { titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { landed, retitle } from '../lib/remote.mjs';

export const name = 'title-focus-through-landing';
export const runs = 6;
export const cases = [
  { name: 'typed-then-409' },
  { name: 'idle-poll' },
  { name: 'idle-poll-same-field' },
];

/** Moves the caret to `at` in the focused title input, as a click or arrow keys would. */
const placeCaret = (b, at) =>
  b.eval(`(() => {
    const i = document.querySelector('.node-editor input[aria-label="Node title"]');
    i.focus();
    i.setSelectionRange(${at}, ${at});
    return true;
  })()`);

export async function run(ctx, kase) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  await selectNode(A, 'n1');
  await focusTitle(A);
  await placeCaret(A, 3);
  const checks = new Checks();
  let expectedValue;
  let expectedCaret;

  if (kase.name === 'typed-then-409') {
    await hide(A);
    await retitle(ctx, B, 'n6', '-B1');
    await A.type('abc');
    await landed(ctx, A);
    expectedValue = 'Alpabcha';
    expectedCaret = 6;
  } else if (kase.name === 'idle-poll') {
    await retitle(ctx, B, 'n6', '-B1');
    await landed(ctx, A);
    expectedValue = 'Alpha';
    expectedCaret = 3;
  } else {
    await retitle(ctx, B, 'n1', '-B1');
    await landed(ctx, A);
    expectedValue = 'Alpha-B1';
    expectedCaret = null;
  }
  if (kase.name === 'typed-then-409') await show(A);

  const after = await titleInput(A);
  checks.ok('the title editor is still open', !!after);
  checks.ok('the input kept focus', after?.focused, JSON.stringify(after));
  checks.eq('input text', after?.value, expectedValue);
  if (expectedCaret !== null) {
    checks.eq('caret', [after?.start, after?.end], [expectedCaret, expectedCaret]);
  } else {
    checks.note(`caret after B rewrote the focused title: ${after?.start}/${after?.value.length}`);
  }

  // The next keystroke goes where the caret is.
  await A.type('Z');
  const next = await titleInput(A);
  const at = expectedCaret ?? after.start;
  const wantText = expectedValue.slice(0, at) + 'Z' + expectedValue.slice(at);
  checks.eq('input text after one more key', next?.value, wantText);
  checks.eq('caret after one more key', [next?.start, next?.end], [at + 1, at + 1]);

  const settled = await settleAndCheck({ mock, token, pages: [A, B], checks });
  checks.eq('n1 on the server', titles(settled.server.chart).n1, wantText);
  checks.eq(
    'n6 on the server',
    titles(settled.server.chart).n6,
    kase.name === 'idle-poll-same-field' ? 'Foxtrot' : 'Foxtrot-B1',
  );
  return { checks };
}
