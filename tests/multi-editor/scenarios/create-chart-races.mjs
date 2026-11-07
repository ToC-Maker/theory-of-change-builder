// Two things on the start page need a chart on the server at the same moment. They must end on one
// chart: the URL, the document and everything attached to it point at the same chart.
//
// two-pdfs-one-pick: two PDFs chosen in one file dialog. two-pdfs-two-picks: the same two files
// chosen in two dialogs back to back. Both must create exactly one chart and upload to it.
// chat-and-share-at-once: a chat message is sent and the Share dialog opened in the same instant.
// Each starts its own create; the document keeps the first chart that arrives and the loser follows
// it (the other chart is left unused, which is noted, not counted as a loss).
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../lib/browser.mjs';

export const name = 'create-chart-races';
export const runs = 4;
export const cases = [
  { name: 'two-pdfs-one-pick' },
  { name: 'two-pdfs-two-picks' },
  { name: 'chat-and-share-at-once' },
];
export const needs = ['A'];

const PDF = (n) => `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
% ${n}
`;

function pdfs(out) {
  const dir = path.join(out, 'fixtures');
  fs.mkdirSync(dir, { recursive: true });
  return ['a', 'b'].map((n) => {
    const file = path.join(dir, `paper-${n}.pdf`);
    fs.writeFileSync(file, PDF(n));
    return file;
  });
}

export async function run(ctx, kase) {
  const { mock, A } = ctx;
  // A slow create keeps both requests in flight at once.
  const normalLatency = mock.config.latency.createChart;
  mock.config.latency.createChart = 1200;
  try {
    await ctx.openRoot('A');
    const from = mock.events.length;
    const { checks } = ctx;
    const isPdfCase = kase.name.startsWith('two-pdfs');

    if (kase.name === 'two-pdfs-one-pick') {
      await A.chooseFiles('input[type=file][accept*=".pdf"]', pdfs(ctx.out));
    } else if (kase.name === 'two-pdfs-two-picks') {
      const [a, b] = pdfs(ctx.out);
      // Back to back: the second dialog closes while the first file's create is still in flight.
      await A.chooseFiles('input[type=file][accept*=".pdf"]', [a]);
      await A.chooseFiles('input[type=file][accept*=".pdf"]', [b]);
    } else {
      mock.nextAi({ ms: 1500, edits: [] });
      const composer = 'textarea[placeholder^="Ask about"]';
      await A.waitFor(
        `document.querySelector('${composer}') && !document.querySelector('${composer}').disabled`,
        {
          what: 'the composer',
        },
      );
      await A.eval(`document.querySelector('${composer}').focus()`);
      await A.insertText('Please start a chart');
      await Promise.all([
        A.press('Enter'),
        A.eval(
          `[...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Share').click()`,
        ),
      ]);
    }

    if (isPdfCase) {
      await mock.waitFor(() => mock.since(from, (e) => e.kind === 'UPLOAD').length >= 2, {
        timeout: 30_000,
        what: 'both uploads',
      });
    } else {
      await mock.waitFor(() => mock.since(from, (e) => e.kind === 'AI-end').length, {
        timeout: 30_000,
        what: 'the chat reply',
      });
    }
    await sleep(4000);

    const created = mock.since(from, (e) => e.kind === 'CREATE-end');
    const doc = await A.eval(`window.__doc().getStatus()`);
    const url = await A.eval('location.pathname');
    checks.note(`${created.length} chart(s) created`);
    if (isPdfCase) {
      checks.eq('charts created', created.length, 1);
      const uploads = mock.since(from, (e) => e.kind === 'UPLOAD');
      checks.eq('uploads', uploads.length, 2);
      for (const u of uploads) {
        checks.eq(
          'an upload names the created chart',
          [u.chartId, u.editToken],
          [created[0]?.chartId, created[0]?.token],
        );
      }
    }
    checks.ok('at least one chart was created', created.length >= 1);
    checks.eq(
      'the URL is the edit URL of the chart the document saves to',
      url,
      `/edit/${doc.editToken}`,
    );
    checks.ok(
      'that chart exists on the server',
      created.some((c) => c.token === doc.editToken),
      `${doc.editToken}`,
    );
    if (!isPdfCase) {
      const links = await A.eval(
        `[...document.querySelectorAll('input[readonly]')].map((i) => i.value).filter((v) => v.includes('/edit/'))`,
      );
      checks.ok(
        'the Share dialog shows the edit link of that chart',
        links.some((l) => l.endsWith(`/edit/${doc.editToken}`)),
        JSON.stringify(links),
      );
    }
    checks.eq('the document is not stuck', [doc.terminalError, doc.unsaved], [null, false]);
  } finally {
    mock.config.latency.createChart = normalLatency;
  }
}
