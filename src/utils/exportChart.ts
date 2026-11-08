// exportChart — JSON / PNG / PDF export utilities for the canvas.
//
// PR 6 wires the FileMenu's Export submenu to three functions:
//   - `exportToJson(data, filename)`     — synchronous, ~10 LoC.
//   - `exportToPng(canvasRoot, filename)`— dynamic-imports html-to-image.
//   - `exportToPdf(canvasRoot, filename)`— dynamic-imports html-to-image
//                                          + jspdf, single-page PDF.
//
// ---------------------------------------------------------------------------
// Why dynamic imports
// ---------------------------------------------------------------------------
//
// Vite emits each `import()` call as its own chunk. Keeping
// `html-to-image` (~25 KB gzipped) and `jspdf` (~400 KB gzipped) out of
// the main bundle is a hard acceptance gate from the figma-redesign
// plan: "dist/assets/*.js chunk containing jspdf <= 450 KB" plus
// "total bundle delta vs PR 5 baseline <= +50 KB for the non-jspdf
// bundle". Static imports at the top of this file would pull both
// libraries into the entry chunk and break both budgets.
//
// ---------------------------------------------------------------------------
// Capture traps: transform, font and SVG paint
// ---------------------------------------------------------------------------
//
// html-to-image reads layout boxes off the live DOM node. If the
// canvas root has a CSS `transform` (zoom/pan in our case), the
// captured image will be clipped or misregistered against the
// expected output rect. The fix: snapshot the inline transform,
// override with `transform: none`, run the capture, then restore the
// original. The `finally` block guarantees restoration even when the
// library throws.
//
// Fonts: by default html-to-image walks `document.styleSheets` to
// embed @font-face rules into the captured SVG. This sometimes fails
// when the host font (Merriweather, Ubuntu, etc.) is loaded from a
// cross-origin CDN and the stylesheet is "tainted" — html-to-image
// silently falls back to a default sans-serif which makes the export
// look wrong. We pre-compute the embed CSS via `getFontEmbedCSS` and
// pass it explicitly so the capture has the same font signal it would
// have had on a same-origin page. If `getFontEmbedCSS` throws, we
// `console.warn` and pass `undefined` (omit the option) so html-to-
// image's internal walk gets a second chance. Passing `""` here would
// be wrong: the library's check is `options.fontEmbedCSS != null`,
// which accepts the empty string verbatim and skips the fallback walk
// entirely.
//
// SVG paint: html-to-image copies computed styles onto its clone of each
// HTML element but deep-clones an `<svg>` as-is, so paint that a
// stylesheet class supplies (the connection paths' `fill-none`) is lost
// and the curves export as solid black shapes. `withSvgPaintPinned` pins
// the computed paint onto the SVG elements for the duration of the
// capture and removes it afterwards.
//
// SVG exclusions: the same clone never calls the capture `filter` for
// what is inside an `<svg>`, so `data-export-exclude` there is ignored by
// the filter. `withSvgExclusionsHidden` hides those elements for the
// duration of the capture instead.
//
// Selection: the canvas highlights what is selected or hovered (a ring, the
// rest faded). `withSelectionCleared` clears that for the capture, so an
// export always shows the chart as published, and puts the selection back.
import type { ToCData } from '../types';
import { suspendForExport } from './exportSuspend';

/**
 * Trigger a download in the browser by creating an anonymous anchor,
 * setting `download` + `href`, dispatching a click, then revoking the
 * object URL in a microtask so the click handler has time to start the
 * download. The anchor is appended to `document.body` for Firefox
 * compatibility (Firefox ignores click events on un-attached anchors
 * even though Chrome/Safari don't).
 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // Firefox: an anchor must be in the DOM tree for `.click()` to fire
  // a download. We append, click, then remove on the same task.
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Revoke in a microtask so the download has a tick to grab the URL.
  // (Some browsers grab synchronously; others queue it. Microtask is
  // safer than immediate revoke without being noticeably slower.)
  void Promise.resolve().then(() => URL.revokeObjectURL(url));
}

function ensureExtension(filename: string, ext: string): string {
  const lower = filename.toLowerCase();
  const dotted = ext.startsWith('.') ? ext : `.${ext}`;
  return lower.endsWith(dotted.toLowerCase()) ? filename : `${filename}${dotted}`;
}

/**
 * Serialize a ToCData blob to a JSON file and trigger a download.
 * Synchronous (no dynamic imports), so this can also be called from
 * keyboard shortcuts without worrying about chunk-load latency.
 */
export function exportToJson(data: ToCData, filename: string): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  triggerDownload(blob, ensureExtension(filename, '.json'));
}

/**
 * Snapshot inline transforms on `root` and any ancestor in the chain
 * up to `document.body`, override each to `none`, run `fn`, then
 * restore. The restore runs in a `finally` so a throwing capture
 * doesn't leave the DOM in a mutated state.
 *
 * Why ancestors too: in App.tsx, the canvas root sits inside a
 * `<div style={{ transform: 'scale(z)' }}>` zoom/pan wrapper. The
 * red-team note in plans/figma-redesign.md:165-168 is about html-to-
 * image misreading `getBoundingClientRect`, which IS affected by
 * ancestor transforms. Neutralizing just the root's own transform
 * (which is usually empty) wouldn't actually fix the visual zoom
 * during capture — we need to flatten the transform chain.
 *
 * Returns whatever `fn` returns (Promise included). Callers `await`
 * the result.
 */
async function withTransformNeutralized<T>(root: HTMLElement, fn: () => Promise<T>): Promise<T> {
  // Walk root + ancestors; remember every element whose inline
  // transform style is non-empty. We don't touch elements whose
  // transform is set only via a CSS rule (vs inline) — those would
  // be a footgun to reset because we'd have to compute a "none"
  // override and remember the cascading value to restore. Inline
  // transforms cover the App.tsx zoom/pan case; other layout-level
  // transforms (e.g. tailwind `transition-transform`) on the chart
  // canvas itself should be avoided by the canvas's own CSS.
  const snapshots: { el: HTMLElement; prev: string }[] = [];
  let cursor: HTMLElement | null = root;
  while (cursor && cursor !== document.body) {
    if (cursor.style.transform && cursor.style.transform !== 'none') {
      snapshots.push({ el: cursor, prev: cursor.style.transform });
      cursor.style.transform = 'none';
    }
    cursor = cursor.parentElement;
  }

  try {
    return await fn();
  } finally {
    // Each snapshot targets a distinct ancestor element (no revisits
    // in the parent-chain walk), so restoration order is irrelevant —
    // writes are independent. Iterating in any order works.
    for (let i = snapshots.length - 1; i >= 0; i--) {
      snapshots[i].el.style.transform = snapshots[i].prev;
    }
  }
}

/**
 * SVG paint properties that `withSvgPaintPinned` copies from computed
 * style onto inline style for the duration of a capture.
 */
const SVG_PAINT_PROPERTIES = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-opacity',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
];

/**
 * html-to-image copies computed styles onto its clone of every HTML
 * element, but deep-clones an `<svg>` as-is and never visits the
 * elements inside it. SVG paint that a stylesheet class supplies is
 * therefore missing from the capture: the connection paths carry
 * `fill-none` as a Tailwind class, so in the exported image they fall
 * back to the SVG default `fill: black` and every curve (and the
 * transparent click-target path beside it) is painted as a solid black
 * shape.
 *
 * Pin each paint property that isn't already inline onto the SVG
 * descendants of `root`, run `fn`, then remove exactly what was added
 * (in a `finally`, like `withTransformNeutralized`). Values are the
 * computed ones, so the live canvas doesn't change.
 */
async function withSvgPaintPinned<T>(root: HTMLElement, fn: () => Promise<T>): Promise<T> {
  const pinned: { el: SVGElement; prop: string }[] = [];
  root.querySelectorAll<SVGElement>('svg *').forEach((el) => {
    const computed = getComputedStyle(el);
    for (const prop of SVG_PAINT_PROPERTIES) {
      if (el.style.getPropertyValue(prop) !== '') continue;
      const value = computed.getPropertyValue(prop);
      if (value === '') continue;
      el.style.setProperty(prop, value);
      pinned.push({ el, prop });
    }
  });

  try {
    return await fn();
  } finally {
    for (const { el, prop } of pinned) el.style.removeProperty(prop);
  }
}

/**
 * html-to-image calls `filter` for the HTML nodes it clones but never
 * for what sits inside an `<svg>`, which it deep-clones as-is. A
 * `data-export-exclude` element drawn in SVG (the connection handles)
 * would therefore stay in the image.
 *
 * Hide each one for the duration of `fn`: the clone copies the inline
 * `display: none`. Restores the previous inline value in a `finally`,
 * like the other capture wrappers.
 */
async function withSvgExclusionsHidden<T>(root: HTMLElement, fn: () => Promise<T>): Promise<T> {
  const hidden: { el: SVGElement; prev: string }[] = [];
  root.querySelectorAll<SVGElement>('svg [data-export-exclude]').forEach((el) => {
    hidden.push({ el, prev: el.style.display });
    el.style.display = 'none';
  });

  try {
    return await fn();
  } finally {
    for (const { el, prev } of hidden) el.style.display = prev;
  }
}

/**
 * Clear the canvas's selection and hover state for the duration of `fn`,
 * then put the selection back (in a `finally`, like the other capture
 * wrappers).
 *
 * `suspendForExport` commits the cleared state before it returns, so the
 * DOM is clean when the capture starts. Nodes and connections fade over a
 * CSS transition though, and the capture reads the style mid-fade, so
 * transitions inside `root` are switched off first: the cleared state is
 * then the computed state from the first read.
 */
async function withSelectionCleared<T>(root: HTMLElement, fn: () => Promise<T>): Promise<T> {
  const noTransitions = document.createElement('style');
  noTransitions.textContent =
    '[data-exporting], [data-exporting] * { transition: none !important; }';
  document.head.appendChild(noTransitions);
  root.setAttribute('data-exporting', '');

  let restoreSelection = () => {};
  try {
    restoreSelection = suspendForExport();
    return await fn();
  } finally {
    restoreSelection();
    root.removeAttribute('data-exporting');
    noTransitions.remove();
  }
}

/**
 * Shared capture-options shape for `toPng` / `toCanvas`. The `Options`
 * type from html-to-image is wider; we narrow to the fields we set.
 */
interface CaptureOptions {
  fontEmbedCSS?: string;
  pixelRatio: number;
  skipAutoScale: boolean;
  backgroundColor: string;
  cacheBust: boolean;
  filter: (node: Node) => boolean;
}

/**
 * html-to-image calls this for every node it clones, text nodes
 * included. Elements that only help while editing (controls, handles,
 * prompts) carry `data-export-exclude` and stay out of the image, so an
 * export shows the chart as published.
 */
function includeInExport(node: Node): boolean {
  return !(node instanceof Element && node.hasAttribute('data-export-exclude'));
}

/**
 * Resolve `fontEmbedCSS` via html-to-image's `getFontEmbedCSS`, then
 * invoke `capture` with the merged options inside
 * `withTransformNeutralized`, `withSelectionCleared`,
 * `withSvgPaintPinned` and `withSvgExclusionsHidden`. Used by both
 * `exportToPng` (renderer: `toPng`) and `exportToPdf` (renderer:
 * `toCanvas`).
 *
 * On `getFontEmbedCSS` failure (cross-origin tainted stylesheet, CSP
 * blocked the fetch, etc.) we `console.warn` and pass `undefined` so
 * html-to-image's internal fallback walk gets a second chance. Passing
 * `""` would be wrong — the library's check is `options.fontEmbedCSS
 * != null`, which accepts an empty string verbatim and skips the
 * fallback.
 */
async function captureWithFonts<T>(
  canvasRoot: HTMLElement,
  getFontEmbedCSS: (node: HTMLElement) => Promise<string>,
  capture: (opts: CaptureOptions) => Promise<T>,
): Promise<T> {
  let fontEmbedCSS: string | undefined;
  try {
    fontEmbedCSS = await getFontEmbedCSS(canvasRoot);
  } catch (err) {
    // Leave `fontEmbedCSS` as `undefined` so the option is omitted
    // below and html-to-image's internal walk gets a second chance.
    console.warn(
      '[exportChart] getFontEmbedCSS failed; falling back to html-to-image internal walk',
      err,
    );
  }

  return withTransformNeutralized(canvasRoot, () =>
    withSelectionCleared(canvasRoot, () =>
      withSvgPaintPinned(canvasRoot, () =>
        withSvgExclusionsHidden(canvasRoot, () =>
          capture({
            // Omit `fontEmbedCSS` when undefined so html-to-image performs
            // its internal walk. When defined, pass through verbatim.
            ...(fontEmbedCSS !== undefined ? { fontEmbedCSS } : {}),
            // 2x for hidpi. `skipAutoScale: true` tells the library not to
            // back off the resolution for "very large" trees — we already
            // know our canvas size and want fidelity.
            pixelRatio: 2,
            skipAutoScale: true,
            // White background so transparent PNGs don't look broken when
            // dropped into a presentation. The canvas already has a white
            // card, but other zoom states might bleed transparent edges.
            backgroundColor: '#ffffff',
            cacheBust: true,
            filter: includeInExport,
          }),
        ),
      ),
    ),
  );
}

/**
 * Render the canvas root to a PNG and trigger a download.
 *
 * Implementation notes:
 *  - Dynamic-imports `html-to-image` (Vite chunks it separately).
 *  - Delegates font handling and transform neutralization to
 *    `captureWithFonts`.
 */
export async function exportToPng(canvasRoot: HTMLElement, filename: string): Promise<void> {
  const { toPng, getFontEmbedCSS } = await import('html-to-image');

  const dataUrl = await captureWithFonts(canvasRoot, getFontEmbedCSS, (opts) =>
    toPng(canvasRoot, opts),
  );

  // Convert the data URL back to a Blob so we can use the same
  // download path as JSON. Avoids the `<a download>` length limits
  // some browsers impose on raw data URLs.
  const blob = await (await fetch(dataUrl)).blob();
  triggerDownload(blob, ensureExtension(filename, '.png'));
}

/**
 * Render the canvas root to a single-page PDF and trigger a download.
 *
 * Single-page strategy: jspdf's `format` accepts `[width, height]` in
 * the unit specified by `unit: 'px'`. We set the page to the captured
 * canvas's exact pixel dimensions and place the image at (0, 0). The
 * PDF page becomes a 1:1 viewport over the canvas — no scaling, no
 * page break math.
 *
 * Orientation is inferred from aspect: w >= h => 'landscape', else
 * 'portrait'. jspdf is fine with either as long as the format matches.
 */
export async function exportToPdf(canvasRoot: HTMLElement, filename: string): Promise<void> {
  const [htmlToImage, jspdfMod] = await Promise.all([import('html-to-image'), import('jspdf')]);
  const { toCanvas, getFontEmbedCSS } = htmlToImage;
  const JsPdfCtor = jspdfMod.jsPDF;

  const canvas = await captureWithFonts(canvasRoot, getFontEmbedCSS, (opts) =>
    toCanvas(canvasRoot, opts),
  );

  const dataUrl = canvas.toDataURL('image/png');
  const width = canvas.width;
  const height = canvas.height;

  const pdf = new JsPdfCtor({
    unit: 'px',
    // jspdf type expects `[number, number]` for custom format.
    format: [width, height],
    orientation: width >= height ? 'landscape' : 'portrait',
    // hotfixes turn off automatic 72dpi scaling so pixel units map 1:1.
    hotfixes: ['px_scaling'],
    compress: true,
  });

  pdf.addImage(dataUrl, 'PNG', 0, 0, width, height);
  pdf.save(ensureExtension(filename, '.pdf'));
}
