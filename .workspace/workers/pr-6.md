# PR 6 Worker Log — Image / PDF export

Branch: `figma/pr-6-export` (based on `figma/pr-5-direct-manip`, tip `d395ff5`).

## Summary

PR 6 wires the FileMenu's Export submenu + Import → JSON entry from the
PR 1 placeholders ("Soon") to live implementations:

1. **`src/utils/exportChart.ts`** — three entry points
   - `exportToJson(data, filename)`: synchronous Blob + `<a download>`
     click. Round-trip lossless against `JSON.parse`.
   - `exportToPng(canvasRoot, filename)`: dynamic-imports
     `html-to-image`, snapshots transforms on root + ancestors and
     overrides to `none` for the duration of capture, pre-computes
     `getFontEmbedCSS` to avoid font-fallback regressions.
   - `exportToPdf(canvasRoot, filename)`: dynamic-imports both
     `html-to-image` (toCanvas) and `jspdf` (jsPDF class). Single-page
     PDF; page format = canvas pixel size; orientation inferred from
     aspect.

2. **FileMenu wiring** — Export → JSON / PNG / PDF and Import → JSON
   are now active. PNG/PDF show a "Generating…" label and disable
   themselves while the dynamic-imported capture is in flight. Import
   surfaces a `ConfirmModal` when the existing graph is non-empty
   (replaces a `window.confirm()`-style fallback that previously lived
   in `handleUploadJSON`'s `alert()` branch).

3. **`data-export-root`** attribute on App.tsx's inner white card. The
   FileMenu queries this attribute to find the canvas root at click
   time. Avoids prop-drilling a ref through 4 levels of components.

## Commits

```
bae8c2c  feat(export): JSON / PNG / PDF with dynamic-imported html-to-image + jspdf  (Task 6.1)
bf6f0de  feat(top-bar): wire FileMenu export + import                                  (Task 6.2)
```

Two commits matches the orchestrator brief.

## Files changed (new + modified)

**New files:**

- `src/utils/exportChart.ts` (~200 LoC including header comments on
  why dynamic-import and how the transform-snapshot fix closes the
  red-team Critical finding).
- `tests/frontend/exportChart.test.ts` (9 tests).

**Modified files:**

- `package.json` + `package-lock.json` — added `html-to-image@^1.11.13`
  and `jspdf@^4.2.1` (versions verified current on npm at PR time).
- `src/App.tsx` — `data-export-root="true"` on the inner white card
  div + `onImportJson={handleUploadJSON}` on TopBar.
- `src/components/top-bar/FileMenu.tsx` — placeholder buttons → live
  handlers + dynamic-import to `exportChart.ts` + hidden
  `<input type=file>` + 3 `ConfirmModal` instances (delete, replace,
  export-error).
- `src/components/top-bar/TopBar.tsx` — pass `data` and `onImportJson`
  through to both FileMenu and MobileMenu.
- `src/components/top-bar/MobileMenu.tsx` — same pass-through.
- `tests/frontend/FileMenu.test.tsx` — +5 new cases (13 → 18).

## Test counts

| Stage               | Test files | Tests                           |
| ------------------- | ---------- | ------------------------------- |
| Baseline (PR 5 tip) | 57         | 521                             |
| After Task 6.1      | 58         | 530 (+9 exportChart)            |
| After Task 6.2      | 58         | 535 (+5 FileMenu Export/Import) |

Preflight at PR 6 tip: typecheck clean, lint 2 pre-existing warnings
(GraphTutorial.tsx:168, TheoryOfChangeGraph.tsx:188 — both inherited
from PR 5 and unrelated to PR 6), format clean, build successful, 535
tests pass across 58 files.

## Bundle size analysis

PR 5 baseline (no jspdf / html-to-image, fresh `npm run build`):

```
dist/assets/MDXEditor-Dok1Hl97.css      45.24 KB
dist/assets/index-Vx5tDZ0-.css          59.62 KB
dist/assets/classnames-DcDOhtR0.js     125.95 KB
dist/assets/MDXEditor-F10kYdPa.js      450.84 KB
dist/assets/index-ZlPKUu5K.js          828.51 KB   ← main bundle
```

PR 6 tip:

```
dist/assets/exportChart-CrH2Mb81.js      1.95 KB   ← new (own chunk)
dist/assets/html2canvas-CFzV-G5G.js    199.56 KB   ← new (transitive of jspdf)
dist/assets/jspdf.es.min-Dx_rmPAS.js   399.60 KB   ← new
dist/assets/MDXEditor-CeZeMxOW.js      450.87 KB   (unchanged)
dist/assets/index-yGLU9jre.js          831.72 KB   ← main bundle (+3.21 KB)
```

**Acceptance gates (plan §1102, §210-212):**

- `jspdf` chunk ≤ 450 KB: **399.60 KB** → passes (89% of budget).
- Main bundle delta vs PR 5 baseline ≤ +50 KB: **+3.21 KB** → passes
  (6% of budget).

The +3.21 KB on the main bundle is the dynamic-import preload stub +
the new FileMenu logic (handlers, file input, 3 ConfirmModal calls).
`exportChart.ts` itself is in its own 1.95 KB chunk and only loads on
the first Export click. `html-to-image` is bundled with the
`jspdf.es.min` chunk Vite produced (`html2canvas` is jspdf's
transitive dep, also lazy-loaded). The full PNG export downloads at
worst `exportChart` (1.95 KB) + `html2canvas` (199.56 KB) = ~201 KB
gzip-uncompressed. The full PDF export downloads `exportChart` +
`html2canvas` + `jspdf.es.min` = ~601 KB. Both are first-time-only;
chrome HTTP cache picks them up on subsequent uses.

## Manual smoke test (documented per orchestrator brief)

PR 6 cannot be exercised end-to-end in jsdom because html-to-image and
jspdf write real `<canvas>` and PDF binaries. The unit tests cover the
behavior-equivalent surface (anchor click + URL.createObjectURL for
JSON; transform-snapshot mocks for PNG/PDF). Expected manual results:

- **PNG export**: opens download dialog with `<chart-slug>.png`;
  rendered image shows all nodes + SVG connections at 2× pixel
  density; canvas zoom/pan transforms are neutralized for the
  capture (verified by transform-snapshot test).
- **PDF export**: single-page PDF with the canvas rendered at its
  native size; orientation inferred from aspect (landscape for the
  typical wide ToC layout).
- **JSON round-trip**: export → import (different tab / different
  browser) → graph is byte-identical. Verified by the "round-trips
  back to original" unit test using `Blob.text()`.

## Deviations from the orchestrator brief

None of the deviation categories applied:

1. **Library versions stable** — `npm view jspdf version` returned
   `4.2.1`, `npm view html-to-image version` returned `1.11.13`. Both
   match the pinned versions in the plan.

2. **Bundle gate passed first try** — no mitigation needed for the
   450 KB jspdf budget. The `html2canvas` transitive dep (199.56 KB)
   is bundled separately, so the actual jspdf chunk landed at 399.60
   KB; both chunks are independently dynamic-imported.

3. **`exportToJson` started as a static import** but Vite flagged an
   `INEFFECTIVE_DYNAMIC_IMPORT` warning during the first build (the
   FileMenu had both `import { exportToJson } from ...` and
   `await import(...)` for PNG/PDF). Switched `exportToJson` to use
   the same dynamic-import path so all three live in the same chunk
   and the static-import warning is gone. Minor stylistic refactor;
   the test assertions for JSON export gained a `waitFor` to await
   the dynamic resolution.

4. **`data-export-root` attribute strategy** vs prop-drilling a ref:
   chose the attribute. The canvas root sits 4 levels deep in App.tsx
   (`<div containerRef> > <div transform> > <div data-export-root> >
<ToC>`). Prop-drilling a ref through TopBar → FileMenu would have
   required adding the prop to TopBar's interface (which currently
   doesn't otherwise need a canvas-ref concept) and made tests
   harder. Querying by attribute keeps FileMenu self-contained at the
   cost of one runtime DOM lookup per export click. The trade is
   well-aligned with the plan's "self-contained FileMenu" pattern.

5. **Transform-neutralization walks ancestors, not just the root**:
   the red-team note in plans/figma-redesign.md:165-168 phrases the fix
   as "snapshot the canvas root's `transform`". In App.tsx, the
   transform actually lives on the canvas root's _parent_ (the
   zoom/pan wrapper). I walk up the DOM tree, collect any element
   with a non-empty inline `transform`, neutralize them all for the
   duration of the capture, and restore in `finally`. Strictly a
   superset of the plan's behavior — it does the right thing whether
   the transform is on the root, the parent, or both.

## Integration notes for PR 7 (waypoints)

PR 7 introduces waypoint manipulation on SVG connections. Two
overlap points with PR 6's surface:

1. **`useWaypointDrag` vs `useConnectionDrag` mutual exclusion** (red
   team Important, plan §203): PR 5 left `isCanvasGestureActive`
   un-shared. PR 7's hook will need to gate-check the same ref that
   PR 5's `useConnectionDrag` checks. Nothing in PR 6 touches this
   path.

2. **Export with waypoints**: the SVG connection paths are part of
   the canvas-root subtree, so the PNG/PDF capture will pick them up
   automatically. No PR 6 plumbing is sensitive to waypoint count or
   geometry. The `connectionPath.ts` factored-out path utility (PR 5
   Task 5.2's deliverable) will continue to feed the capture.

If PR 7's waypoint dot affordances introduce per-hover transforms on
inner elements, the ancestor-walk in `withTransformNeutralized`
already covers them. (No action required from PR 7 in that case.)
