#!/usr/bin/env node
// Live-layout assertions for the TopBar geometry pass (PR #34 fb4 (70)).
//
//   (70.1) File flush left — the menubar cluster starts at x=0 like a
//          native menubar, and the round-2 full-height hover fill
//          (fb 43) therefore touches the screen corner. The old
//          container `px-2 sm:px-4` inset the File trigger 16px.
//   (70.2) Shorter bar — 40px row + 1px border-b = 41px rendered
//          (was 52+1). Mirrored by TOP_BAR_HEIGHT_PX = 41
//          (src/hooks/useViewportOffset.ts) and by the chat drawer's
//          `top` (TopBar row height) in ChatInterface.tsx. Controls
//          shrank to 32px (undo/redo p-1.5, Share py-1.5, profile
//          badge w-8 h-8) so they keep >= 3px breathing room.
//   (70.3) Share <-> profile gap — right cluster gap-1 sm:gap-3
//          (12px at sm+), matching the left cluster rhythm.
//
// jsdom class-contract counterparts live in TopBar.responsive.test.tsx
// ("TopBar geometry contract") and AuthButton.test.tsx
// (SHARE_ROW_CONTRACT); this script checks the real rendered rects.
//
// Driven over raw CDP (like test-viewport-bands.mjs) because `rodney js`
// re-applies its own 1280x800 device-metrics override per invocation,
// which would mask the second test width.
//
// Prereqs: dev server (default :8827) and `rodney start --local`. Usage:
//   node scripts/test-topbar-geometry.mjs [url]
import { readFileSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:8827/';
const SIZES = [
  [1280, 800],
  [1920, 1080],
];

// Geometry constants under test (keep in sync with the contracts above).
const ROW_PX = 40; // TopBar.tsx min-h-[40px]
const BAR_PX = ROW_PX + 1; // + container border-b == TOP_BAR_HEIGHT_PX
const SHARE_PROFILE_GAP_PX = 12; // right cluster sm:gap-3
const MIN_BREATHING_PX = 3; // per side, around every fixed-height control

const MEASURE = `(() => {
  const bar = document.querySelector('.fixed.top-0.left-0.right-0.z-50');
  const drawer = document.querySelector('.fixed.left-0.z-40');
  if (!bar || !drawer) return JSON.stringify({ error: 'missing', bar: !!bar, drawer: !!drawer });
  const btns = [...bar.querySelectorAll('button')];
  const byText = (t) => btns.find((b) => b.textContent.trim().startsWith(t));
  const file = byText('File');
  const share = byText('Share');
  const undo = btns.find((b) => b.getAttribute('aria-label') === 'Undo');
  const profile = bar.querySelector('.rounded-full.flex.items-center.justify-center');
  const r1 = (x) => Math.round(x * 10) / 10;
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: r1(b.left), top: r1(b.top), right: r1(b.right), bottom: r1(b.bottom),
             width: r1(b.width), height: r1(b.height) };
  };
  return JSON.stringify({
    iw: window.innerWidth,
    bar: r(bar), file: r(file), undo: r(undo), share: r(share),
    profile: r(profile), drawer: r(drawer),
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

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};
const eq = (label, got, want) => check(`${label} == ${want}`, got === want, `(got ${got})`);

await resize(SIZES[0]);
await send('Page.navigate', { url });
const deadline = Date.now() + 20_000;
let m = await measure();
while (m.error && Date.now() < deadline) {
  await sleep(500);
  m = await measure();
}
if (m.error) {
  console.error(`TopBar/drawer never appeared at ${url}: ${JSON.stringify(m)}`);
  process.exit(2);
}
// First-visit privacy modal steals the screenshotable area; dismiss it.
await evaluate(
  `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'I Understand')?.click()`,
);
await sleep(500);

for (const [w, h] of SIZES) {
  await resize([w, h]);
  await sleep(400);
  m = await measure();
  console.log(`-- ${w}x${h} --`);
  console.log(`  ${JSON.stringify(m)}`);

  // (70.1) menubar flush against the left screen edge, full-height fill.
  eq(`${w}: File trigger flush left`, m.file.left, 0);
  eq(`${w}: File trigger tops the screen`, m.file.top, 0);
  eq(`${w}: File trigger fills the row (fb 43)`, m.file.height, ROW_PX);

  // (70.2) bar height and the drawer's top mirror.
  eq(`${w}: bar renders ${BAR_PX}px (row + border)`, m.bar.height, BAR_PX);
  eq(`${w}: chat drawer starts at the row bottom`, m.drawer.top, ROW_PX);

  // Controls keep sane breathing room in the shorter row.
  for (const [name, c] of [
    ['undo', m.undo],
    ['share', m.share],
    ['profile', m.profile],
  ]) {
    const breathing = Math.min(c.top - m.bar.top, m.bar.top + ROW_PX - c.bottom);
    check(
      `${w}: ${name} fits with >= ${MIN_BREATHING_PX}px breathing`,
      c.height <= ROW_PX - 2 * MIN_BREATHING_PX && breathing >= MIN_BREATHING_PX,
      `(h ${c.height}, breathing ${Math.round(breathing * 10) / 10})`,
    );
  }

  // (70.3) Share <-> profile gap.
  eq(
    `${w}: share->profile gap`,
    Math.round((m.profile.left - m.share.right) * 10) / 10,
    SHARE_PROFILE_GAP_PX,
  );
}

ws.close();
console.log(
  failures ? `\n${failures} assertion(s) failed` : '\nall topbar geometry assertions passed',
);
process.exit(failures ? 1 : 0);
