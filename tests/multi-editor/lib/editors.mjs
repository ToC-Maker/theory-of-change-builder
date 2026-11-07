// What a person does on the canvas and what the page shows, as functions over a `Browser`.
import { sleep } from './browser.mjs';
import { isDeepStrictEqual } from 'node:util';
import { titles } from './chart.mjs';

const TITLE = 'input[aria-label="Node title"]';

/** The page's state as the probe reports it: `{ pill, titles }` (pill is saved|saving|unsaved|error). */
export const snap = (b) => b.eval('window.__snap()');
export const pill = async (b) => (await snap(b)).pill;

/** Screen position of the centre of node `id`. */
export async function centerOf(b, id) {
  const [x, y] = await b
    .eval(
      `(() => {
    const el = document.querySelector('[data-tocb-node=${id}]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
  })()`,
    )
    .then((v) => v ?? [NaN, NaN]);
  return { x, y };
}

/** Screen position of the centre of the first element matching `selector`, or null. */
export async function centerOfSelector(b, selector) {
  const c = await b.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
  })()`);
  return c && { x: c[0], y: c[1] };
}

/** Resolves once the nodes have stopped moving (the layout shifts for a moment after the first paint). */
export async function layoutStable(b) {
  const every = 250;
  const rounds = 3;
  let previous = '';
  let same = 0;
  for (let i = 0; i < 40 && same < rounds; i++) {
    const now = JSON.stringify(await pageLayout(b));
    same = now === previous ? same + 1 : 0;
    previous = now;
    await sleep(every);
  }
  if (same < rounds) throw new Error('the layout kept moving');
}

/** Clicks node `id` (selecting it and opening its editor); a click that misses is repeated. */
export async function selectNode(b, id) {
  for (let attempt = 1; ; attempt++) {
    const { x, y } = await centerOf(b, id);
    await b.click(x, y);
    try {
      await b.waitFor(`document.querySelector(${JSON.stringify(TITLE)})`, {
        timeout: 4000,
        what: `editor of ${id}`,
      });
      return;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
}

/** Opens `id`'s editor, puts the caret at the end of the title and types `text`. */
export async function editTitle(b, id, text, gapMs = 0) {
  await selectNode(b, id);
  await focusTitle(b);
  await b.type(text, gapMs);
}

/** Clicks the title input and puts the caret at the end. */
export async function focusTitle(b) {
  const c = await centerOfSelector(b, TITLE);
  await b.click(c.x, c.y);
  await b.press('End');
}

export const closeEditor = (b) => b.press('Escape');

export const titleInput = (b) =>
  b.eval(`(() => {
    const i = document.querySelector(${JSON.stringify(TITLE)});
    return i && { value: i.value, start: i.selectionStart, end: i.selectionEnd, focused: document.activeElement === i };
  })()`);

/** The details editor's contenteditable text, lines joined by '|', or null when no editor is open. */
export const detailsText = (b) =>
  b.eval(`(() => {
    const ce = document.querySelector('.node-editor [contenteditable=true]');
    return ce && ce.innerText.replace(/\\n+/g, '|').replace(/\\|$/, '');
  })()`);

/**
 * Where the caret is in the details editor: the text before it (with '|' for line breaks), or null
 * when there is no selection inside the editor.
 */
export const detailsCaret = (b) =>
  b.eval(`(() => {
    const ce = document.querySelector('.node-editor [contenteditable=true]');
    const sel = getSelection();
    if (!ce || !sel.anchorNode || !ce.contains(sel.anchorNode)) return null;
    const r = document.createRange();
    r.selectNodeContents(ce);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r.toString().replace(/\\n+/g, '|');
  })()`);

/** Types `text` into the chat composer and sends it with Enter. */
export async function sendChat(b, text) {
  const composer = 'textarea[placeholder^="Ask about"]';
  await b.waitFor(
    `document.querySelector('${composer}') && !document.querySelector('${composer}').disabled`,
    {
      what: 'the chat composer',
    },
  );
  const c = await centerOfSelector(b, composer);
  await b.click(c.x, c.y);
  await b.insertText(text);
  await b.press('Enter');
}

/** The column under screen point (x, y) as "section-column" indices, or null (the dragged node's ghost is skipped). */
export const columnAt = (b, x, y) =>
  b.eval(`(() => {
    for (const el of document.elementsFromPoint(${x}, ${y})) {
      const column = el.closest('[data-column]');
      if (column) return column.dataset.column;
    }
    return null;
  })()`);

/** Whether a node editor / an edge editor is on screen. */
export const nodeEditorOpen = (b) => b.eval(`!!document.querySelector('.node-editor')`);
export const edgeEditorOpen = (b) =>
  b.eval(`!!document.querySelector('button[aria-label="Delete connection"]')`);

/** The chart the page holds: `{ committed, live, status }` as plain JSON, or null before the app is up. */
export const docState = (b) =>
  b.eval(`(() => {
    const d = window.__doc();
    return d && JSON.parse(JSON.stringify({ committed: d.getCommitted(), live: d.getLive(), status: d.getStatus() }));
  })()`);

/** Node centres by id, rounded: the page's layout. */
export const pageLayout = (b) =>
  b.eval(`(() => {
    const out = {};
    document.querySelectorAll('[data-tocb-node]').forEach((n) => {
      const r = n.getBoundingClientRect();
      out[n.dataset.tocbNode] = [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)];
    });
    return out;
  })()`);

/** What a person can read off a page (pill, node titles, layout) and the chart document behind it. */
export async function pageModel(b) {
  const s = await snap(b);
  const doc = await docState(b);
  return { pill: s.pill, titles: s.titles, layout: await pageLayout(b), ...doc };
}

// Hidden-tab emulation: the app reads `document.hidden`, so a hidden tab neither polls nor
// receives landings until it becomes visible again (when it checks at once).
export const hide = (b) =>
  b.eval(`(() => {
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    return 'hidden';
  })()`);

export const show = (b) =>
  b.eval(`(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    return String(document.hidden);
  })()`);

/** Screen position of a connection handle `button[data-tocb-connection-handle="n1|right"]`, or null. */
export const handleCenter = (b, node, side) =>
  centerOfSelector(b, `button[data-tocb-connection-handle="${node}|${side}"]`);

/** Screen position of the midpoint handle of `source->target`, or null. */
export const midpointHandle = (b, source, target) =>
  centerOfSelector(b, `[data-tocb-midpoint-handle="${source}->${target}|0"]`);

/** A point `fraction` along the first connection's drawn path (to hover it so its handles show). */
export const pathPoint = (b, index, fraction) =>
  b
    .eval(
      `(() => {
      const p = document.querySelectorAll('[data-tocb-connection-hitpath]')[${index}];
      if (!p) return null;
      const m = p.getScreenCTM();
      const a = p.getPointAtLength(p.getTotalLength() * ${fraction});
      return [Math.round(a.x * m.a + m.e), Math.round(a.y * m.d + m.f)];
    })()`,
    )
    .then((c) => c && { x: c[0], y: c[1] });

/** Presses the pointer on node `id` and moves it to (x, y) in four steps, leaving it held. */
export async function holdNodeDrag(b, id, x, y) {
  const c = await centerOf(b, id);
  await b.move(c.x, c.y);
  await b.down();
  await b.glide(x, y, { steps: 4 });
}

/** Deletes node `id` through its editor's Delete button. */
export async function deleteNode(b, id) {
  await selectNode(b, id);
  await b.eval(`document.querySelector('button[aria-label="Delete node"]').click()`);
}

/** Resolves once the server's chart satisfies `predicate`; throws after `timeout`. */
export async function untilServer(mock, token, predicate, { timeout = 20_000, what } = {}) {
  await mock.waitFor(() => predicate(mock.state(token).chart), {
    timeout,
    what: what ?? 'the server chart',
  });
}

/**
 * Whether the server's chart satisfies `predicate` within `timeout`. For an outcome the scenario is
 * judging: a chart that never gets there is a loss to report, where `untilServer` (a step the scenario
 * needs in order to go on) throws. A predicate that throws on a chart lacking the part it looks at
 * counts as not satisfied.
 */
export const serverReaches = (mock, token, predicate, { timeout = 20_000 } = {}) =>
  mock
    .waitFor(() => predicate(mock.state(token).chart), { timeout })
    .then(
      () => true,
      () => false,
    );

// How long the server's version must stay put before the pages and the server count as settled.
const QUIET_MS = 3500;

// A chart the server holds without section and column ids (saved by a tab on the previous client)
// is read by the app with ids added, and stored with them on its next save. Until then the two
// differ by those ids only.
const omit = (object, key) => Object.fromEntries(Object.entries(object).filter(([k]) => k !== key));
const withoutContainerIds = (chart) => ({
  ...chart,
  sections: chart.sections.map((section) => ({
    ...omit(section, 'id'),
    columns: section.columns.map((column) => omit(column, 'id')),
  })),
});
const sameChart = (page, server) =>
  isDeepStrictEqual(
    server.sections.every((s) => s.id === undefined) ? withoutContainerIds(page) : page,
    server,
  );

/**
 * Waits until the pages and the server agree and nothing is unsaved: each page shows the saved pill,
 * the server version has not moved for `QUIET_MS`, and every page's chart document and titles equal the
 * server chart's. Resolves `{ converged, why, server, models }`; a run that never converges has
 * lost or mis-shown something, which is the scenario's finding to report, so it is not thrown.
 */
export async function settle({ mock, token, pages, timeout = 30_000 }) {
  const t0 = Date.now();
  let lastVersion = mock.state(token).version;
  let since = Date.now();
  for (;;) {
    const server = mock.state(token);
    if (server.version !== lastVersion) {
      lastVersion = server.version;
      since = Date.now();
    }
    const models = await Promise.all(pages.map(pageModel));
    const problems = [];
    models.forEach((m, i) => {
      if (m.pill !== 'saved') problems.push(`page ${i} pill ${m.pill}`);
      if (m.status.unsaved) problems.push(`page ${i} document has unsaved changes`);
      if (m.status.serverVersion !== server.version) {
        problems.push(
          `page ${i} is at version ${m.status.serverVersion}, server at ${server.version}`,
        );
      }
      if (!sameChart(m.committed, server.chart)) {
        problems.push(`page ${i} chart differs from the server's`);
      }
      if (!isDeepStrictEqual(m.titles, titles(server.chart))) {
        problems.push(
          `page ${i} shows ${JSON.stringify(m.titles)}, server has ${JSON.stringify(titles(server.chart))}`,
        );
      }
    });
    if (!problems.length && Date.now() - since >= QUIET_MS) {
      return { converged: true, why: '', server, models };
    }
    if (Date.now() - t0 > timeout)
      return { converged: false, why: problems.join('; '), server, models };
    await sleep(250);
  }
}
