// Tests for `src/utils/exportChart.ts` — JSON / PNG / PDF exporters.
//
// JSON export is fully unit-testable: serialize a ToCData blob to a
// data URL, trigger an anchor click, revoke the URL. We mock
// `URL.createObjectURL` / `revokeObjectURL` because jsdom 22+ implements
// `createObjectURL` (returns "blob:..." URLs) but not `revokeObjectURL`
// reliably, and asserting the URL string is also easier when we own it.
//
// PNG/PDF are harder to unit-test in jsdom (the library walks layout
// boxes and writes a real <canvas>). We unit-test the transform-snapshot
// behavior — snapshot the canvas root's `transform`, override to `none`,
// invoke the library, restore the transform — by mocking the
// `html-to-image` module. That pins the red-team-critical fix from
// plans/figma-redesign.md:165-168: "before toPng/toCanvas, snapshot the
// canvas root's `transform`, override with `transform: none`, capture,
// restore". A live capture is left for manual smoke-test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToCData } from '../../src/types';

// We dynamic-import the module fresh in each test so the module-level
// `clickedHrefs` capture in the JSON test starts from a clean slate.
// `vi.resetModules()` between tests rebuilds the import graph.

const minimalData: ToCData = {
  title: 'Test Chart',
  sections: [
    {
      title: 'Inputs',
      columns: [{ nodes: [{ id: 'n1', title: 'A', text: 'a', connectionIds: [] }] }],
    },
  ],
};

// Capture for the JSON path: anchor click is monkey-patched so we can
// read the `href` and `download` values without depending on jsdom's
// download semantics (which don't trigger a real download anyway).
let lastClickedAnchor: { href: string; download: string } | null = null;
let createdObjectURLs: string[] = [];
let revokedObjectURLs: string[] = [];

beforeEach(() => {
  lastClickedAnchor = null;
  createdObjectURLs = [];
  revokedObjectURLs = [];

  // Mock URL.createObjectURL / revokeObjectURL deterministically. jsdom
  // returns the random "blob:nodedata:..." URL which is fine but harder
  // to assert against.
  let counter = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob) => {
    const url = `blob:test-${++counter}-${blob.size}`;
    createdObjectURLs.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revokedObjectURLs.push(url);
  });

  // Intercept anchor clicks. HTMLAnchorElement.prototype.click triggers
  // a navigation in real browsers; jsdom no-ops it but doesn't surface
  // the click event. We monkey-patch to capture the metadata.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    lastClickedAnchor = { href: this.href, download: this.download };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.innerHTML = '';
});

describe('exportToJson', () => {
  it('serializes data and triggers an anchor click with the right filename', async () => {
    const { exportToJson } = await import('../../src/utils/exportChart');
    exportToJson(minimalData, 'test-chart');

    expect(lastClickedAnchor).not.toBeNull();
    expect(lastClickedAnchor!.download).toBe('test-chart.json');
    expect(lastClickedAnchor!.href).toMatch(/^blob:test-/);
    expect(createdObjectURLs).toHaveLength(1);
  });

  it.each([
    { input: 'My Chart', expected: 'My Chart.json' },
    { input: 'already.json', expected: 'already.json' },
  ])('ensureExtension($input) -> $expected', async ({ input, expected }) => {
    const { exportToJson } = await import('../../src/utils/exportChart');
    exportToJson(minimalData, input);
    expect(lastClickedAnchor!.download).toBe(expected);
  });

  it('produces a Blob whose content round-trips back to the original data', async () => {
    // We capture the blob handed to createObjectURL and re-read it via
    // .text() to verify the serialization is lossless. This is the
    // import/export round-trip invariant the FileMenu manual test
    // asserts.
    let captured: Blob | null = null;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      captured = blob;
      return 'blob:captured';
    }) as typeof URL.createObjectURL;

    const { exportToJson } = await import('../../src/utils/exportChart');
    exportToJson(minimalData, 'roundtrip');

    expect(captured).not.toBeNull();
    const text = await (captured as unknown as Blob).text();
    expect(JSON.parse(text)).toEqual(minimalData);
  });

  it('revokes the object URL after the click is dispatched', async () => {
    const { exportToJson } = await import('../../src/utils/exportChart');
    exportToJson(minimalData, 'revoke-test');

    // The revoke is queued in a microtask so async iteration is enough
    // to see it.
    await Promise.resolve();
    expect(revokedObjectURLs).toEqual(createdObjectURLs);
  });
});

describe('exportToPng — transform-snapshot logic (red-team Critical)', () => {
  it('snapshots the canvas root transform, calls toPng with transform=none, then restores', async () => {
    // Build a canvas root with a real CSS transform. The red-team note
    // calls out that html-to-image will misrender if the element has
    // a `transform: scale(...) translate(...)` in effect; the fix is
    // to set `transform: none` for the duration of the capture and
    // restore the original after.
    const root = document.createElement('div');
    root.setAttribute('data-testid', 'export-root');
    root.style.transform = 'scale(0.5) translate(10px, 20px)';
    document.body.appendChild(root);

    // Capture the inline transform value at the moment toPng is called.
    // The implementation MUST set it to '' or 'none' before invoking
    // toPng and restore the original afterwards.
    let observedTransform: string | null = null;

    // Mock html-to-image so toPng synchronously reads the transform we
    // care about, then resolves with a dummy data URL.
    vi.doMock('html-to-image', () => ({
      toPng: vi.fn(async (node: HTMLElement) => {
        observedTransform = node.style.transform;
        return 'data:image/png;base64,AAAA';
      }),
      toCanvas: vi.fn(),
      getFontEmbedCSS: vi.fn(async () => '/* embedded fonts */'),
    }));

    const { exportToPng } = await import('../../src/utils/exportChart');
    await exportToPng(root, 'transform-test');

    // During the capture the transform was neutralized.
    expect(observedTransform).toBe('none');
    // After the capture the original transform is back in place. (The
    // CSSOM normalizes the value; we just check the meaningful bits.)
    expect(root.style.transform).toMatch(/scale\(0\.5\)/);
    expect(root.style.transform).toMatch(/translate\(10px,\s*20px\)/);
  });

  it('passes pre-computed fontEmbedCSS to toPng (font-fallback fix)', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    let receivedOptions: { fontEmbedCSS?: string } | null = null;
    vi.doMock('html-to-image', () => ({
      toPng: vi.fn(async (node: HTMLElement, opts: { fontEmbedCSS?: string }) => {
        void node;
        receivedOptions = opts;
        return 'data:image/png;base64,AAAA';
      }),
      toCanvas: vi.fn(),
      getFontEmbedCSS: vi.fn(async () => '/* embedded fonts: Merriweather */'),
    }));

    const { exportToPng } = await import('../../src/utils/exportChart');
    await exportToPng(root, 'font-test');

    expect(receivedOptions).not.toBeNull();
    expect(receivedOptions!.fontEmbedCSS).toContain('Merriweather');
  });

  it('restores the original transform even when toPng throws', async () => {
    // Robustness: a failing toPng must not leave the canvas in a
    // half-mutated state. The restore must be in a finally block.
    const root = document.createElement('div');
    root.style.transform = 'scale(2)';
    document.body.appendChild(root);

    vi.doMock('html-to-image', () => ({
      toPng: vi.fn(async () => {
        throw new Error('boom');
      }),
      toCanvas: vi.fn(),
      getFontEmbedCSS: vi.fn(async () => ''),
    }));

    const { exportToPng } = await import('../../src/utils/exportChart');
    await expect(exportToPng(root, 'throw-test')).rejects.toThrow('boom');
    expect(root.style.transform).toMatch(/scale\(2\)/);
  });

  it('omits fontEmbedCSS (and warns) when getFontEmbedCSS throws', async () => {
    // Regression guard: a previous version coerced the failure to
    // `''`, which html-to-image accepts verbatim (`options.fontEmbedCSS
    // != null` is true for empty string) and uses to SKIP its own
    // fallback walk. The fix is to pass `undefined` (omit the option)
    // so the library re-walks the stylesheets internally — and to
    // `console.warn` so the failure leaves a trace in DevTools.
    const root = document.createElement('div');
    document.body.appendChild(root);

    let receivedOptions: { fontEmbedCSS?: string } | null = null;
    vi.doMock('html-to-image', () => ({
      toPng: vi.fn(async (_node: HTMLElement, opts: { fontEmbedCSS?: string }) => {
        receivedOptions = opts;
        return 'data:image/png;base64,AAAA';
      }),
      toCanvas: vi.fn(),
      getFontEmbedCSS: vi.fn(async () => {
        throw new Error('CORS-tainted stylesheet');
      }),
    }));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { exportToPng } = await import('../../src/utils/exportChart');
    await exportToPng(root, 'font-fail-test');

    // Export still completes.
    expect(receivedOptions).not.toBeNull();
    // The option is OMITTED (not present, or `undefined`) — NOT set
    // to `""`. The library's internal walk gets a chance to fire.
    expect(receivedOptions!.fontEmbedCSS).toBeUndefined();
    // Diagnostic warning was logged so a maintainer can find this.
    expect(warn).toHaveBeenCalled();
    const firstCall = warn.mock.calls[0];
    expect(String(firstCall[0])).toMatch(/getFontEmbedCSS failed/);
  });

  it('walks ancestors and neutralizes their transforms too', async () => {
    // Production case: in App.tsx the canvas root sits inside a
    // `<div style={{ transform: scale(z) }}>` zoom/pan wrapper. The
    // inline transform lives on the PARENT, not the root itself. The
    // ancestor walk must capture + restore the parent's transform.
    // Without this test, a regression to root-only would silently
    // reintroduce the zoomed-export bug (only caught by manual
    // smoke-test).
    const grandparent = document.createElement('div');
    grandparent.style.transform = 'translate(5px, 7px)';
    const parent = document.createElement('div');
    parent.style.transform = 'scale(0.5)';
    const root = document.createElement('div');
    grandparent.appendChild(parent);
    parent.appendChild(root);
    document.body.appendChild(grandparent);

    let observedParentTransform: string | null = null;
    let observedGrandparentTransform: string | null = null;
    vi.doMock('html-to-image', () => ({
      toPng: vi.fn(async () => {
        observedParentTransform = parent.style.transform;
        observedGrandparentTransform = grandparent.style.transform;
        return 'data:image/png;base64,AAAA';
      }),
      toCanvas: vi.fn(),
      getFontEmbedCSS: vi.fn(async () => ''),
    }));

    const { exportToPng } = await import('../../src/utils/exportChart');
    await exportToPng(root, 'ancestor-test');

    // Both ancestor transforms were neutralized for the capture.
    expect(observedParentTransform).toBe('none');
    expect(observedGrandparentTransform).toBe('none');
    // Both were restored after.
    expect(parent.style.transform).toMatch(/scale\(0\.5\)/);
    expect(grandparent.style.transform).toMatch(/translate\(5px,\s*7px\)/);
  });
});

describe('exportToPdf — fits canvas into a single page', () => {
  // Parameterized orientation cases. The implementation uses
  // `width >= height ? 'landscape' : 'portrait'`, so equal-dim ties
  // resolve to landscape. A regression that flips the comparator (e.g.
  // `<` -> `<=`, or swap the branches) is otherwise invisible.
  it.each([
    { w: 1200, h: 800, expected: 'landscape' as const },
    { w: 800, h: 1200, expected: 'portrait' as const },
    { w: 1000, h: 1000, expected: 'landscape' as const }, // tie -> landscape per `>=`
  ])('creates a $expected PDF when the canvas is ${w}x${h}', async ({ w, h, expected }) => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const fakeCanvas = {
      width: w,
      height: h,
      toDataURL: vi.fn(() => 'data:image/png;base64,FAKE'),
    } as unknown as HTMLCanvasElement;

    vi.doMock('html-to-image', () => ({
      toPng: vi.fn(),
      toCanvas: vi.fn(async () => fakeCanvas),
      getFontEmbedCSS: vi.fn(async () => ''),
    }));

    let constructorArgs: unknown = null;
    let addImageArgs: unknown[] | null = null;
    let savedFilename: string | null = null;

    class FakePdf {
      constructor(opts: unknown) {
        constructorArgs = opts;
      }
      addImage(...args: unknown[]) {
        addImageArgs = args;
      }
      save(filename: string) {
        savedFilename = filename;
      }
    }

    vi.doMock('jspdf', () => ({ jsPDF: FakePdf, default: FakePdf }));

    const { exportToPdf } = await import('../../src/utils/exportChart');
    await exportToPdf(root, 'pdf-test');

    // Single-page PDF, format = canvas pixel size, orientation
    // inferred from aspect.
    expect(constructorArgs).toMatchObject({
      unit: 'px',
      format: [w, h],
      orientation: expected,
    });
    // The PNG was placed at (0,0) at full size — single page,
    // because the page IS the canvas.
    expect(addImageArgs).not.toBeNull();
    expect(addImageArgs![0]).toBe('data:image/png;base64,FAKE');
    expect(savedFilename).toBe('pdf-test.pdf');
  });
});
