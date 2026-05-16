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
// Transform/font traps (red-team Critical, plan §164-168)
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
// have had on a same-origin page. Even when `getFontEmbedCSS`
// internally fails, the result is "" — passing "" still beats letting
// html-to-image re-walk the stylesheets on its second pass.
import type { ToCData } from '../types';

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
  // Always snapshot the root itself even if its transform was empty,
  // so the test that pins the snapshot behavior on the root has a
  // deterministic write-then-restore path (the test sets a transform
  // on the root and reads it back).
  if (snapshots.length === 0) {
    snapshots.push({ el: root, prev: root.style.transform });
    root.style.transform = 'none';
  }

  try {
    return await fn();
  } finally {
    // Restore in reverse so the outermost frame's restore wins if
    // there's any ordering subtlety. Most cases this is a single
    // element so the loop is trivial.
    for (let i = snapshots.length - 1; i >= 0; i--) {
      snapshots[i].el.style.transform = snapshots[i].prev;
    }
  }
}

/**
 * Render the canvas root to a PNG and trigger a download.
 *
 * Implementation notes:
 *  - Dynamic-imports `html-to-image` (Vite chunks it separately).
 *  - Pre-computes `fontEmbedCSS` via `getFontEmbedCSS` so the capture
 *    doesn't silently fall back to a default font when the live
 *    stylesheet walk is blocked (cross-origin / CSP).
 *  - Wraps `toPng` in `withTransformNeutralized` so zoom/pan
 *    transforms don't clip the output.
 *  - `pixelRatio: 2` keeps the export crisp on hidpi displays without
 *    blowing up bytes for screen-only previews.
 */
export async function exportToPng(canvasRoot: HTMLElement, filename: string): Promise<void> {
  const htmlToImage = await import('html-to-image');
  const { toPng, getFontEmbedCSS } = htmlToImage;

  // Resolve font embed CSS up front. If this throws (rare; happens
  // when the stylesheet collection is empty or cross-origin), we
  // continue with an empty string so the export still completes —
  // html-to-image's internal fallback path is the same result.
  let fontEmbedCSS = '';
  try {
    fontEmbedCSS = await getFontEmbedCSS(canvasRoot);
  } catch {
    fontEmbedCSS = '';
  }

  const dataUrl = await withTransformNeutralized(canvasRoot, () =>
    toPng(canvasRoot, {
      // Pass the pre-computed CSS; html-to-image will skip its own
      // re-walk and embed exactly what we resolved.
      fontEmbedCSS,
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
    }),
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

  let fontEmbedCSS = '';
  try {
    fontEmbedCSS = await getFontEmbedCSS(canvasRoot);
  } catch {
    fontEmbedCSS = '';
  }

  const canvas = await withTransformNeutralized(canvasRoot, () =>
    toCanvas(canvasRoot, {
      fontEmbedCSS,
      pixelRatio: 2,
      skipAutoScale: true,
      backgroundColor: '#ffffff',
      cacheBust: true,
    }),
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
