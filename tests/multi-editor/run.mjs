// Runs the two-browser scenarios against a versioned mock Worker.
//
//   fnm exec --using=24.15.0 -- node tests/multi-editor/run.mjs --root <checkout> --out <dir> [options]
//
//   --root        the checkout whose client is under test (Vite is started with it as cwd)
//   --old-root    a checkout of the previous client, for scenarios that need a tab running it
//   --out         where event logs, screenshots and results.json go (outside the repo)
//   --only        comma-separated scenario names (default: all)
//   --runs        runs per case, overriding each scenario's own count
//   --web-port / --mock-port / --old-port   free ports (never 5173 or 8787: those serve the real app)
//   --session     browser session prefix; give each process running side by side its own
//                 (default: the caller's agent-browser session + -acc)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Browser, sleep } from './lib/browser.mjs';
import { Checks } from './lib/checks.mjs';
import { layoutStable } from './lib/editors.mjs';
import { startMock } from './lib/mock.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    root: { type: 'string' },
    'old-root': { type: 'string' },
    out: { type: 'string' },
    only: { type: 'string' },
    runs: { type: 'string' },
    'web-port': { type: 'string', default: '5311' },
    'mock-port': { type: 'string', default: '8911' },
    'old-port': { type: 'string', default: '5312' },
    session: { type: 'string' },
  },
});
if (!args.root || !args.out) {
  console.error(
    'usage: node run.mjs --root <checkout> --out <dir> [--only a,b] [--runs N] [--old-root <checkout>]',
  );
  process.exit(2);
}
for (const port of [args['web-port'], args['mock-port'], args['old-port']]) {
  if (port === '5173' || port === '8787') throw new Error(`port ${port} serves the real app`);
}
const root = path.resolve(args.root);
const out = path.resolve(args.out);
const sessionPrefix = args.session ?? `${process.env.AGENT_BROWSER_SESSION ?? 'tocb'}-acc`;
const runsOverride = args.runs === undefined ? undefined : Number(args.runs);
if (runsOverride !== undefined && !(Number.isInteger(runsOverride) && runsOverride > 0)) {
  throw new Error(`--runs must be a positive integer, got ${args.runs}`);
}
fs.mkdirSync(path.join(out, 'shots'), { recursive: true });

const spawned = [];
function serveClient(checkout, port, workName) {
  const work = path.join(out, workName);
  fs.mkdirSync(work, { recursive: true });
  const logFile = fs.openSync(path.join(out, `${workName}.log`), 'w');
  const child = spawn(
    process.execPath,
    [path.join(here, 'serve-client.mjs'), checkout, port, args['mock-port'], work],
    { cwd: checkout, stdio: ['ignore', logFile, logFile] },
  );
  spawned.push(child);
  return child;
}

async function waitForHttp(port) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return;
    } catch {
      // The server is still starting.
    }
    await sleep(500);
  }
  throw new Error(`nothing answered on port ${port}`);
}

const scenarioFiles = fs
  .readdirSync(path.join(here, 'scenarios'))
  .filter((f) => f.endsWith('.mjs'))
  .sort();
const wanted = args.only?.split(',');
const scenarios = [];
for (const file of scenarioFiles) {
  const scenario = await import(path.join(here, 'scenarios', file));
  if (wanted && !wanted.includes(scenario.name)) continue;
  if (scenario.needs?.includes('old') && !args['old-root']) {
    // Asked for by name, a scenario that cannot run is an error; in "all of them" it is left out.
    if (wanted) throw new Error(`${scenario.name} needs --old-root`);
    console.log(`skipping ${scenario.name}: it needs --old-root`);
    continue;
  }
  scenarios.push(scenario);
}
if (wanted) {
  const unknown = wanted.filter((n) => !scenarios.some((s) => s.name === n));
  if (unknown.length) throw new Error(`unknown scenarios: ${unknown.join(', ')}`);
}
const needsOld = scenarios.some((s) => s.needs?.includes('old'));

const mock = startMock({
  port: Number(args['mock-port']),
  logFile: path.join(out, 'events.ndjson'),
});
await mock.ready;
serveClient(root, args['web-port'], 'vite-new');
if (needsOld) serveClient(path.resolve(args['old-root']), args['old-port'], 'vite-old');
await waitForHttp(args['web-port']);
if (needsOld) await waitForHttp(args['old-port']);

const browsers = {};
const shots = path.join(out, 'shots');
const urlFor = (kind, token, who) =>
  `http://127.0.0.1:${kind === 'old' ? args['old-port'] : args['web-port']}/edit/${token}?who=${who}`;

/** What a scenario gets: the mock, its browsers, and helpers that name things per run. */
function context(scenario, kase, index) {
  const token = `${scenario.name}-${kase.name}-${index}`;
  const ctx = {
    mock,
    token,
    index,
    kase,
    out,
    // What the run got wrong, kept here rather than returned so that a scenario that throws
    // part-way still reports the losses it had already found.
    checks: new Checks(),
    // Odd runs start from a chart whose sections and columns already have stored ids, even runs from
    // one that has none (every chart saved before versions).
    ids: index % 2 === 1,
    mark: (label) => mock.mark(`${token} ${label}`),
    A: browsers.A,
    B: browsers.B,
    old: browsers.old,
    shot: (b, name) => b.screenshot(`${token}-${name}`),
    /** Opens page `name` on the app's start page (no chart yet: the first action creates one). */
    async openRoot(name) {
      const b = browsers[name];
      await b.goto(`http://127.0.0.1:${args['web-port']}/?who=${name}`);
      await b.waitFor(`document.querySelectorAll('input[type=file]').length > 0`, {
        what: 'the start page',
      });
      await sleep(2000);
    },
    /** Opens editor pages on this run's chart: `open({ A: 'new', B: 'new' })`, or `{ old: 'old' }` for the previous client. */
    async open(who) {
      mock.newChart(token, { ids: ctx.ids });
      await Promise.all(
        Object.entries(who).map(async ([name, kind]) => {
          const b = browsers[name];
          await b.goto(urlFor(kind, token, name));
          await b.waitFor("document.querySelector('[data-tocb-node=n1]')", {
            timeout: 90_000,
            what: `chart on page ${name}`,
          });
          await layoutStable(b);
        }),
      );
    },
  };
  return ctx;
}

const results = [];
const RUN_TIMEOUT_MS = 5 * 60_000;
// After a run that threw, the browsers are reopened: that rejects the call a timed-out scenario is
// still waiting on, which stops it, and gives the next run clean pages.
let freshBrowsers = false;
try {
  const kinds = new Set(scenarios.flatMap((s) => s.needs ?? ['A', 'B']));
  for (const name of ['A', 'B', 'old']) {
    if (!kinds.has(name)) continue;
    const url = urlFor(name === 'old' ? 'old' : 'new', 'warmup', name);
    mock.newChart('warmup', { ids: false });
    browsers[name] = await Browser.open({ session: `${sessionPrefix}-${name}`, url, shots });
    await browsers[name].waitFor("document.querySelector('[data-tocb-node=n1]')", {
      timeout: 120_000,
      what: `warm-up load of ${name}`,
    });
  }

  for (const scenario of scenarios) {
    for (const kase of scenario.cases ?? [{ name: 'default' }]) {
      const row = {
        scenario: scenario.name,
        case: kase.name,
        runs: 0,
        lost: 0,
        caretJumps: 0,
        errors: 0,
        details: [],
      };
      const count = runsOverride ?? scenario.runs ?? 3;
      for (let i = 0; i < count; i++) {
        await Promise.all(
          Object.values(browsers).map((b) => (freshBrowsers ? b.reopen() : b.ensureAlive())),
        );
        freshBrowsers = false;
        const ctx = context(scenario, kase, i);
        ctx.mark('begin');
        const started = Date.now();
        let verdict = {};
        try {
          verdict =
            (await Promise.race([
              scenario.run(ctx, kase),
              sleep(RUN_TIMEOUT_MS).then(() => {
                throw new Error(`run exceeded ${RUN_TIMEOUT_MS} ms`);
              }),
            ])) ?? {};
        } catch (error) {
          verdict = { error: String(error?.stack ?? error) };
        }
        ctx.mark('end');
        row.runs++;
        const { checks } = ctx;
        const lost = checks.lost;
        const { caretJumps } = checks;
        if (verdict.error) {
          row.errors++;
          freshBrowsers = true;
        }
        row.lost += lost.length;
        row.caretJumps += caretJumps;
        const detail = {
          run: i,
          token: ctx.token,
          ids: ctx.ids,
          seconds: Math.round((Date.now() - started) / 1000),
          lost,
          caretJumps,
          error: verdict.error,
          notes: checks.notes,
        };
        row.details.push(detail);
        console.log(
          `${scenario.name}/${kase.name} #${i}: ${verdict.error ? 'ERROR' : lost.length ? 'LOST ' + lost.length : 'ok'}` +
            ` carets=${caretJumps} (${detail.seconds}s)` +
            (lost.length ? '\n  ' + lost.join('\n  ') : '') +
            (verdict.error ? '\n  ' + verdict.error.split('\n').slice(0, 4).join('\n  ') : ''),
        );
        if (lost.length || verdict.error) {
          for (const name of ['A', 'B']) {
            // A page that failed may not answer; the events log is the evidence then.
            if (browsers[name]) await ctx.shot(browsers[name], `${name}-failure`).catch(() => {});
          }
        }
        fs.writeFileSync(
          path.join(out, 'results.json'),
          JSON.stringify([...results, row], null, 1),
        );
      }
      results.push(row);
    }
  }
} finally {
  for (const b of Object.values(browsers)) await b.close();
  for (const child of spawned) child.kill();
  await mock.stop();
}

console.log(
  '\n| scenario | case | runs | lost edits | caret jumps | errors |\n|---|---|---|---|---|---|',
);
for (const r of results) {
  console.log(
    `| ${r.scenario} | ${r.case} | ${r.runs} | ${r.lost} | ${r.caretJumps} | ${r.errors} |`,
  );
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 1));
process.exit(results.some((r) => r.lost || r.errors) ? 1 : 0);
