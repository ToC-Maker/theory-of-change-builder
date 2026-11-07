// B rewrites the details of the node whose details editor A has open and focused. A's editor takes
// B's text; the caret's position (by design it moves to the start) is recorded. Pressing the
// toolbar's Undo or Ctrl+Z afterwards must not bring the old text back, and nothing may be saved
// by A because of it.
import { Checks } from '../lib/checks.mjs';
import {
  centerOfSelector,
  closeEditor,
  detailsCaret,
  detailsText,
  selectNode,
} from '../lib/editors.mjs';
import { nodeById } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { landed } from '../lib/remote.mjs';
import { sleep } from '../lib/browser.mjs';

export const name = 'details-remote-rewrite';
export const runs = 5;

const EDITOR = '.node-editor [contenteditable=true]';
const UNDO = '.mdx-editor-wrapper button[aria-label^="Undo"]';

async function openDetails(b, id) {
  await selectNode(b, id);
  await b.waitFor(`document.querySelector('${EDITOR}')`, { what: 'the details editor' });
  const c = await centerOfSelector(b, EDITOR);
  await b.click(c.x, c.y);
}

export async function run(ctx) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  const from = mock.events.length;
  const original = nodeById(mock.state(token).chart, 'n1').node.text;

  await openDetails(A, 'n1');
  await A.press('Home');
  for (let i = 0; i < 4; i++) await A.press('ArrowRight');
  const caretBefore = await detailsCaret(A);

  ctx.mark('B types into n1 details');
  await openDetails(B, 'n1');
  await B.press('Control+End');
  await B.type('REMOTE');
  await closeEditor(B);
  await mock.waitFor(() => nodeById(mock.state(token).chart, 'n1').node.text.includes('REMOTE'), {
    what: "B's details saved",
  });
  await landed(ctx, A);
  await sleep(500);
  const afterLanding = await detailsText(A);
  const caretAfter = await detailsCaret(A);
  const focused = await A.eval(
    `!!document.querySelector('${EDITOR}') && document.querySelector('${EDITOR}').contains(document.activeElement)`,
  );
  const landedAt = Date.now();

  const checks = new Checks();
  checks.ok("A's editor shows B's text", afterLanding?.includes('REMOTE'), String(afterLanding));
  checks.note(
    `caret before the landing: after ${JSON.stringify(caretBefore)}; after it: ${JSON.stringify(caretAfter)}; editor focused: ${focused}`,
  );

  const undoDisabled = await A.eval(`document.querySelector('${UNDO}').disabled`);
  checks.note(`toolbar Undo disabled after the landing: ${undoDisabled}`);
  const keep = async (label) => {
    await sleep(500);
    const text = await detailsText(A);
    checks.ok(`B's text survives ${label}`, text?.includes('REMOTE'), String(text));
  };
  const undo = await centerOfSelector(A, UNDO);
  await A.click(undo.x, undo.y);
  await keep('the toolbar Undo');
  await A.click(undo.x, undo.y);
  await keep('a second toolbar Undo');
  const editor = await centerOfSelector(A, EDITOR);
  await A.click(editor.x, editor.y);
  await A.press('Control+z');
  await keep('Ctrl+Z');
  await A.press('Control+z');
  await keep('a second Ctrl+Z');
  await sleep(3000);

  const settled = await settleAndCheck({ mock, token, pages: [A, B], checks });
  const text = nodeById(settled.server.chart, 'n1').node.text;
  checks.ok(
    "the server keeps B's text",
    text.includes('REMOTE') && text !== original,
    JSON.stringify(text),
  );
  checks.eq(
    'saves by A after the landing',
    mock.since(from, (e) => e.kind === 'POST-start' && e.who === 'A' && e.ts > landedAt).length,
    0,
  );
  return { checks };
}
