// A has an editor open on something B deletes. The editor closes and nothing is recreated, unless
// A had typed content into it, in which case the node stays with A's typing.
//
// edge-editor: A's edge editor is open on n1->n3 and B deletes that connection.
// node-editor-idle: A's node editor is open on n1, nothing typed, and B deletes n1.
// node-editor-typed-before-landing: B deletes n1 while A's tab is not polling; A then types into
//   n1's title, so A's save is answered 409 and merged against the delete.
// node-editor-typed-across-landing: A types into n1's title while the answer carrying B's delete of
//   n1 arrives.
import {
  edgeEditorOpen,
  focusTitle,
  hide,
  nodeEditorOpen,
  selectNode,
  show,
  titleInput,
} from '../lib/editors.mjs';
import { connection, connections, nodeById, titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';
import { deleteConnection, landed, openEdgeEditor, remove } from '../lib/remote.mjs';
import { sleep } from '../lib/browser.mjs';

export const name = 'open-editor-vs-remote-delete';
export const runs = 5;
export const cases = [
  { name: 'edge-editor' },
  { name: 'node-editor-idle' },
  { name: 'node-editor-typed-before-landing' },
  { name: 'node-editor-typed-across-landing' },
];

export async function run(ctx, kase) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  const { checks } = ctx;
  const from = mock.events.length;

  if (kase.name === 'edge-editor') {
    await openEdgeEditor(A);
    await deleteConnection(ctx, B);
    await landed(ctx, A);
    // `until`, not `waitFor`: an editor that stays open is the failure to report.
    await A.until(`!document.querySelector('button[aria-label="Delete connection"]')`, {
      timeout: 5000,
    });
    checks.eq("A's edge editor is closed", await edgeEditorOpen(A), false);
    await sleep(4000);
    const settled = await settleAndCheck({ mock, token, pages: [A, B], checks });
    checks.ok('the connection stays deleted', !connection(settled.server.chart, 'n1', 'n3'));
    checks.eq(
      'both end nodes remain',
      [titles(settled.server.chart).n1, titles(settled.server.chart).n3],
      ['Alpha', 'Charlie'],
    );
    checks.eq(
      'saves by A',
      mock.since(from, (e) => e.kind === 'POST-start' && e.who === 'A').length,
      0,
    );
  } else if (kase.name === 'node-editor-idle') {
    await selectNode(A, 'n1');
    await remove(ctx, B, 'n1');
    await landed(ctx, A);
    await A.until(`!document.querySelector('.node-editor')`, { timeout: 5000 });
    checks.eq("A's node editor is closed", await nodeEditorOpen(A), false);
    await sleep(4000);
    const settled = await settleAndCheck({ mock, token, pages: [A, B], checks });
    checks.ok('n1 stays deleted', !nodeById(settled.server.chart, 'n1'));
    checks.eq('connections', connections(settled.server.chart), ['n2->n4', 'n3->n5']);
    checks.eq(
      'saves by A',
      mock.since(from, (e) => e.kind === 'POST-start' && e.who === 'A').length,
      0,
    );
  } else {
    await selectNode(A, 'n1');
    await focusTitle(A);
    let typed;
    if (kase.name === 'node-editor-typed-before-landing') {
      await hide(A);
      await remove(ctx, B, 'n1');
      const sent = mock.events.length;
      await A.type('XY');
      typed = 'AlphaXY';
      // A's save must leave before the tab polls again, or the poll's landing would pre-empt the 409.
      await mock.waitFor(
        () => mock.since(sent, (e) => e.kind === 'POST-start' && e.who === 'A').length,
        { what: "A's save" },
      );
      await show(A);
      await mock.waitFor(
        () => mock.since(sent, (e) => e.kind === 'POST-409' && e.who === 'A').length,
        { what: "A's save to be answered 409" },
      );
    } else {
      // The answer that carries B's delete is held back, and A types while it is out.
      await hide(A);
      await remove(ctx, B, 'n1');
      mock.next('A', 'pollChart', { delay: 2500 });
      const held = mock.events.length;
      await show(A);
      await mock.waitFor(
        () => mock.since(held, (e) => e.kind === 'POLL-start' && e.who === 'A').length,
        { what: 'the held-back poll' },
      );
      await A.type('XY');
      typed = 'AlphaXY';
    }
    await landed(ctx, A);
    const settled = await settleAndCheck({ mock, token, pages: [A, B], checks });
    const n1 = nodeById(settled.server.chart, 'n1');
    checks.ok('n1 stays, because A typed into it', !!n1);
    checks.eq("n1's title is what A typed", n1?.node.title, typed);
    checks.eq("A's editor is still open on it", (await titleInput(A))?.value, typed);
    // B deleted n1 with its outgoing connection; A never touched that connection, so it stays deleted.
    checks.eq('connections', connections(settled.server.chart), ['n2->n4', 'n3->n5']);
    checks.eq(
      'other titles',
      { ...titles(settled.server.chart), n1: undefined },
      {
        n1: undefined,
        n2: 'Bravo',
        n3: 'Charlie',
        n4: 'Delta',
        n5: 'Echo',
        n6: 'Foxtrot',
      },
    );
  }
}
