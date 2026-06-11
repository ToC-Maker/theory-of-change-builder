#!/usr/bin/env node
// Live-resize band-symmetry assertion for the canvas auto-fit reserve
// (PR #34 fb3 known-issues K1 + K2).
//
//   K1: viewportOffset mirrors the chat drawer's CSS clamp
//       `clamp(25vw, 280px, 400px)` but never recomputed on window
//       resize — a 1920 → 1280 live resize left the 1920-era reserve
//       in place (leftBand 104 vs rightBand 24; 80px asymmetric).
//   K2: the top reserve claimed 64px for a TopBar that really renders
//       53px (min-h-[52px] row + 1px border-b) — a constant 11px
//       top/bottom asymmetry at every size, even on a fresh load.
//
// What it does: navigates the rodney-managed headless Chrome to the
// app, then at each size LIVE-resizes the viewport (CDP
// Emulation.setDeviceMetricsOverride — fires a real window `resize`,
// no reload), presses ctrl-0 (fit-to-screen), and measures the four
// bands between the canvas card ([data-export-root]) and the
// surrounding chrome (drawer right edge, TopBar bottom edge, window
// right/bottom edges).
//
// Driven over raw CDP (Node >= 21 built-in WebSocket, no deps) because
// `rodney js` re-applies rodney's own 1280x800 device-metrics override
// on every invocation, which would mask the live resize under test.
//
// Invariants, asserted at the load size AND after every live resize:
//   |leftBand - rightBand| <= TOL
//   |topBand - bottomBand| <= TOL
//   every band >= MIN_BAND after fit-to-screen (canvas inside viewport)
// TOL is 4px: tight enough to catch K2's 11px vertical skew (the
// round-2 fb2-drawer agent's |leftBand-rightBand| <= 12 invariant
// would let it pass), loose enough for sub-pixel layout rounding.
//
// Prereqs: dev server on :8820 (npm run dev -- --port 8820) and
// `rodney start --local`. Usage:
//   node scripts/test-viewport-bands.mjs [url]
import { readFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:8820/';
// Load size first, then live resizes. All md+ (>= 768): below md the
// drawer is a mobile overlay with different reserve semantics.
const SIZES = [
  [1920, 1080],
  [1280, 800],
  [1024, 720],
  [1600, 900],
];
const TOL = 4;
const MIN_BAND = 20;

const MEASURE = `(() => {
  const card = document.querySelector('[data-export-root]');
  const drawer = document.querySelector('.fixed.left-0.z-40');
  const topbar = document.querySelector('.fixed.top-0.left-0.right-0.z-50');
  if (!card || !drawer || !topbar)
    return JSON.stringify({ error: 'missing', card: !!card, drawer: !!drawer, topbar: !!topbar });
  const c = card.getBoundingClientRect();
  const d = drawer.getBoundingClientRect();
  const t = topbar.getBoundingClientRect();
  const iw = window.innerWidth, ih = window.innerHeight;
  const r1 = (x) => Math.round(x * 10) / 10;
  const leftBand = c.left - d.right, rightBand = iw - c.right;
  const topBand = c.top - t.bottom, bottomBand = ih - c.bottom;
  return JSON.stringify({
    iw, ih, topBarH: r1(t.height), drawerW: r1(d.width),
    leftBand: r1(leftBand), rightBand: r1(rightBand),
    topBand: r1(topBand), bottomBand: r1(bottomBand),
    hDiff: r1(leftBand - rightBand), vDiff: r1(topBand - bottomBand),
  });
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { debug_url: debugUrl } = JSON.parse(readFileSync('.rodney/state.json', 'utf8'));
const httpBase = debugUrl.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/.*$/, '');
const targets = await (await fetch(`${httpBase}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error(`no page target at ${httpBase} — is \`rodney start --local\` running?`);
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

const resize = ([w, h]) =>
  send('Emulation.setDeviceMetricsOverride', {
    width: w,
    height: h,
    deviceScaleFactor: 0,
    mobile: false,
  });
const evaluate = async (expression) =>
  (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
const measure = async () => JSON.parse(await evaluate(MEASURE));
const fitToScreen = () =>
  evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key: '0', ctrlKey: true}))`);

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

// Load at the first size, then live-resize through the rest.
await resize(SIZES[0]);
await send('Page.navigate', { url });
// Wait for the canvas card to exist and the graph to report a size.
const deadline = Date.now() + 20_000;
let m = await measure();
while (m.error && Date.now() < deadline) {
  await sleep(500);
  m = await measure();
}
if (m.error) {
  console.error(`canvas never appeared at ${url}: ${JSON.stringify(m)}`);
  process.exit(2);
}
await sleep(1000); // initial autofit settle

for (let i = 0; i < SIZES.length; i++) {
  const [w, h] = SIZES[i];
  if (i > 0) {
    await resize(SIZES[i]);
    // 100ms resize debounce + the drawer's 300ms width transition.
    await sleep(700);
    await fitToScreen();
    await sleep(250);
  }
  m = await measure();
  const label = `${w}x${h}${i > 0 ? ' (live-resized)' : ' (load)'}`;
  console.log(`  ${JSON.stringify(m)}`);
  check(`${label} horizontal |${m.leftBand} - ${m.rightBand}| <= ${TOL}`, Math.abs(m.hDiff) <= TOL);
  check(`${label} vertical   |${m.topBand} - ${m.bottomBand}| <= ${TOL}`, Math.abs(m.vDiff) <= TOL);
  const minBand = Math.min(m.leftBand, m.rightBand, m.topBand, m.bottomBand);
  check(
    `${label} canvas inside viewport (min band ${minBand} >= ${MIN_BAND})`,
    minBand >= MIN_BAND,
  );
}

ws.close();
console.log(failures ? `\n${failures} assertion(s) failed` : '\nall band assertions passed');
process.exit(failures ? 1 : 0);
