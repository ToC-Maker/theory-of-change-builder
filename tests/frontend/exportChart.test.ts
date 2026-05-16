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

  it('appends .json if the filename does not already end in .json', async () => {
    const { exportToJson } = await import('../../src/utils/exportChart');
    exportToJson(minimalData, 'My Chart');
    expect(lastClickedAnchor!.download).toBe('My Chart.json');
  });

  it('does not double-suffix .json', async () => {
    const { exportToJson } = await import('../../src/utils/exportChart');
    exportToJson(minimalData, 'already.json');
    expect(lastClickedAnchor!.download).toBe('already.json');
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
});

describe('exportToPdf — fits canvas into a single page', () => {
  it('calls jspdf with a single page sized to the canvas, then triggers a save', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    // Mock toCanvas to return a fake canvas whose dimensions drive the
    // jspdf layout math.
    const fakeCanvas = {
      width: 1200,
      height: 800,
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

    // Single-page PDF, landscape-or-portrait inferred from aspect.
    expect(constructorArgs).toMatchObject({
      unit: 'px',
      format: [1200, 800],
      orientation: 'landscape',
    });
    // The PNG was placed at (0,0) at full size — single page, centered
    // because the page IS the canvas.
    expect(addImageArgs).not.toBeNull();
    expect(addImageArgs![0]).toBe('data:image/png;base64,FAKE');
    expect(savedFilename).toBe('pdf-test.pdf');
  });
});
