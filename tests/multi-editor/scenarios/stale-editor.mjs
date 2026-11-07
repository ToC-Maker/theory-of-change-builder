// A tab that has not yet seen the other tab's save edits and saves: the 409 merge must keep both.
import { closeEditor, editTitle, hide, show, snap, untilServer } from '../lib/editors.mjs';
import { titles } from '../lib/chart.mjs';
import { settleAndCheck } from '../lib/oracle.mjs';

export const name = 'stale-editor';
export const runs = 6;

export async function run(ctx) {
  const { mock, token, A, B } = ctx;
  await ctx.open({ A: 'new', B: 'new' });
  const from = mock.events.length;
  // B is hidden, so it does not poll: it is stale for as long as it stays so.
  await hide(B);
  ctx.mark('A edits n1');
  await editTitle(A, 'n1', '-A');
  await untilServer(mock, token, (c) => titles(c).n1 === 'Alpha-A', { what: 'A saved n1' });
  const before = mock.state(token).version;

  ctx.mark('stale B edits n2');
  await editTitle(B, 'n2', '-B');
  await closeEditor(B);
  await untilServer(mock, token, (c) => titles(c).n2 === 'Bravo-B', { what: 'B saved n2' });
  await show(B);

  const { checks } = ctx;
  const { server } = await settleAndCheck({ mock, token, pages: [A, B], checks });
  checks.eq('titles on the server', titles(server.chart), {
    n1: 'Alpha-A',
    n2: 'Bravo-B',
    n3: 'Charlie',
    n4: 'Delta',
    n5: 'Echo',
    n6: 'Foxtrot',
  });
  checks.ok(
    'B was told it was stale (a 409 happened)',
    mock.since(from, (e) => e.kind === 'POST-409' && e.who === 'B').length > 0,
  );
  checks.ok("server advanced past A's save", server.version > before);
  checks.note(
    `final server version ${server.version}; pages ${JSON.stringify((await snap(A)).pill)}`,
  );
}

export const cases = [{ name: 'default' }];
