// What the other person does while the person under test is mid-gesture. Each helper acts on page `b`
// and returns once the server holds the result, so a scenario knows the change is "out there".
import {
  centerOf,
  closeEditor,
  deleteNode,
  docState,
  editTitle,
  holdNodeDrag,
  pathPoint,
  untilServer,
} from './editors.mjs';
import { sleep } from './browser.mjs';
import { connection, nodeById, places, titles } from './chart.mjs';

/** Types `suffix` at the end of `id`'s title and closes the editor. */
export async function retitle(ctx, b, id, suffix) {
  const before = titles(ctx.mock.state(ctx.token).chart)[id];
  await editTitle(b, id, suffix);
  await closeEditor(b);
  await untilServer(ctx.mock, ctx.token, (c) => titles(c)[id] === before + suffix, {
    what: `${id} retitled to ${before + suffix}`,
  });
}

/** Drags node `id` and drops it between the centres of `above` and `below` (two nodes of one column). */
export async function moveBetween(ctx, b, id, above, below) {
  const target = await dropPoint(b, above, below);
  await holdNodeDrag(b, id, target.x, target.y);
  await b.up();
  await untilServer(ctx.mock, ctx.token, (c) => places(c)[id] === placeOf(c, above), {
    what: `${id} moved next to ${above}`,
  });
}

/** Screen position half way between two nodes' centres. */
export async function dropPoint(b, above, below) {
  const a = await centerOf(b, above);
  const c = await centerOf(b, below);
  return { x: a.x, y: Math.round((a.y + c.y) / 2) };
}

const placeOf = (chart, id) => {
  const entry = nodeById(chart, id);
  return `s${entry.s}c${entry.c}`;
};

export async function remove(ctx, b, id) {
  await deleteNode(b, id);
  await untilServer(ctx.mock, ctx.token, (c) => !nodeById(c, id), { what: `${id} deleted` });
}

/** Whether a save by `who` after event index `from` carried a chart for which `predicate(summary)` holds. */
export function savedBy(ctx, who, from, predicate) {
  return (
    ctx.mock.since(from, (e) => e.kind === 'POST-start' && e.who === who && predicate(e.sent))
      .length > 0
  );
}

/** Resolves once page `b`'s document holds the server's current version (a landing or a save has reached it). */
export async function landed(ctx, b, { timeout = 20_000 } = {}) {
  const want = ctx.mock.state(ctx.token).version;
  const t0 = Date.now();
  while ((await docState(b)).status.serverVersion !== want) {
    if (Date.now() - t0 > timeout) throw new Error(`the page never took server version ${want}`);
    await sleep(100);
  }
}

/** Clicks the connection `n1->n3` on page `b` (it is the first path drawn) to open the edge editor. */
export async function openEdgeEditor(b) {
  const p = await pathPoint(b, 0, 0.3);
  await b.move(p.x, p.y);
  await sleep(300);
  await b.down();
  await b.up();
  await b.waitFor(`document.querySelector('button[aria-label="Delete connection"]')`, {
    what: 'the edge editor',
  });
}

/** Deletes the connection `n1->n3` through the edge editor, and waits for the server to lose it. */
export async function deleteConnection(ctx, b) {
  await openEdgeEditor(b);
  await b.eval(`document.querySelector('button[aria-label="Delete connection"]').click()`);
  await ctx.mock.waitFor(() => !connection(ctx.mock.state(ctx.token).chart, 'n1', 'n3'), {
    what: 'the connection deleted on the server',
  });
}
