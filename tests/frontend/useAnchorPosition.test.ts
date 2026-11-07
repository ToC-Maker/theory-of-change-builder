// Tests for `useAnchorPosition` — repositions an overlay continuously
// alongside its anchor element. The hook is the unification point for
// the four subscription paths: camera changes (pan/zoom),
// ResizeObserver (anchor and overlay resize), throttled MutationObserver
// (DOM-tree changes that re-flow the anchor) and window resize.
//
// Acceptance gates:
//   - Camera prop changes → reposition (recomputed from element rect).
//   - ResizeObserver callback → reposition.
//   - Window resize → reposition now and on every frame for a moment.
//   - No anchor → returns null (caller can skip rendering).
//   - Once the overlay is measured, it stays inside the visible area.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useAnchorPosition } from '../../src/components/node-editor/useAnchorPosition';

// Minimal ResizeObserver shim so the hook's `observe`/`disconnect` calls
// don't throw under jsdom. We capture the callback so tests can trigger it.
let capturedResizeCallbacks: ResizeObserverCallback[] = [];

class ResizeObserverMock {
  callback: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.callback = cb;
    capturedResizeCallbacks.push(cb);
  }
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn(() => {
    capturedResizeCallbacks = capturedResizeCallbacks.filter((c) => c !== this.callback);
  });
}

// MutationObserver: similar shim. We don't trigger from this in tests
// (the camera prop subscription is the load-bearing path), but the hook
// would throw without it under jsdom.
class MutationObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
}

beforeEach(() => {
  // @ts-expect-error - test shim
  globalThis.ResizeObserver = ResizeObserverMock;
  // @ts-expect-error - test shim
  globalThis.MutationObserver = MutationObserverMock;
  capturedResizeCallbacks = [];
});

afterEach(() => {
  // Unmount every rendered hook: a hook left mounted keeps its resize
  // listener and follow loop, which can schedule a React update after the
  // file's environment is torn down ("window is not defined").
  cleanup();
  capturedResizeCallbacks = [];
});

function setRect(
  el: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
) {
  // `configurable: true` so the test can swap the mock between rerenders.
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
}

function makeAnchorRef(rect: { left: number; top: number; width: number; height: number }) {
  const el = document.createElement('div');
  setRect(el, rect);
  return { current: el } as React.RefObject<HTMLElement>;
}

describe('useAnchorPosition', () => {
  it('returns the rect-derived overlay position', () => {
    const anchor = makeAnchorRef({ left: 100, top: 200, width: 50, height: 40 });
    const { result } = renderHook(() =>
      useAnchorPosition({
        anchorRef: anchor,
        camera: { x: 0, y: 0, z: 1 },
        placement: 'right',
        offset: 8,
      }),
    );

    expect(result.current).not.toBeNull();
    // Right placement: x = anchor.right + offset; y = anchor.top.
    expect(result.current?.x).toBe(100 + 50 + 8);
    expect(result.current?.y).toBe(200);
  });

  it('repositions when camera prop changes', () => {
    const anchor = makeAnchorRef({ left: 100, top: 200, width: 50, height: 40 });
    // Mutable camera that we replace between renders.
    let camera = { x: 0, y: 0, z: 1 };

    const { result, rerender } = renderHook(() =>
      useAnchorPosition({
        anchorRef: anchor,
        camera,
        placement: 'right',
        offset: 8,
      }),
    );
    const before = result.current;
    expect(before).not.toBeNull();

    // Simulate camera pan: the anchor's getBoundingClientRect would
    // shift because the canvas moved. We swap the mock to reflect a
    // panned anchor and rerender with the new camera prop.
    setRect(anchor.current!, { left: 150, top: 200, width: 50, height: 40 });
    camera = { x: 50, y: 0, z: 1 };
    rerender();

    const after = result.current;
    expect(after).not.toBeNull();
    expect(after?.x).not.toBe(before?.x);
    // Right placement: 150 + 50 + 8 = 208.
    expect(after?.x).toBe(208);
  });

  it('repositions when ResizeObserver fires', () => {
    const anchor = makeAnchorRef({ left: 100, top: 200, width: 50, height: 40 });
    const { result } = renderHook(() =>
      useAnchorPosition({
        anchorRef: anchor,
        camera: { x: 0, y: 0, z: 1 },
        placement: 'right',
        offset: 8,
      }),
    );
    const before = result.current;

    // Simulate anchor resizing (width 50 → 100).
    setRect(anchor.current!, { left: 100, top: 200, width: 100, height: 40 });
    act(() => {
      capturedResizeCallbacks.forEach((cb) =>
        // ResizeObserverEntry shape doesn't matter for our hook — it
        // recomputes from getBoundingClientRect.
        cb([], {} as ResizeObserver),
      );
    });

    expect(result.current?.x).toBe(208); // 100 + 100 + 8
    expect(result.current?.x).not.toBe(before?.x);
  });

  it('returns null when anchor ref has no element', () => {
    const anchor = { current: null } as React.RefObject<HTMLElement>;
    const { result } = renderHook(() =>
      useAnchorPosition({
        anchorRef: anchor,
        camera: { x: 0, y: 0, z: 1 },
        placement: 'right',
        offset: 8,
      }),
    );
    expect(result.current).toBeNull();
  });

  it('re-attaches ResizeObserver to the NEW anchor when anchorRef.current is mutated', () => {
    // Regression: the parent (NodeEditorMount) mutates `.current` on
    // every render to point at the active anchor; before the fix, the
    // ResizeObserver effect deps were `[anchorRef, ...]` (stable
    // RefObject identity) so it captured the FIRST element at mount
    // and silently kept observing it after selection changes — meaning
    // a node-b resize never repositioned the editor when the user had
    // switched from a to b.
    const elementA = document.createElement('div');
    setRect(elementA, { left: 0, top: 0, width: 50, height: 40 });
    const elementB = document.createElement('div');
    setRect(elementB, { left: 200, top: 100, width: 50, height: 40 });
    const anchor = { current: elementA } as React.RefObject<HTMLElement>;

    const { result, rerender } = renderHook(() =>
      useAnchorPosition({
        anchorRef: anchor,
        camera: { x: 0, y: 0, z: 1 },
        placement: 'right',
        offset: 8,
      }),
    );

    // Initial position derives from element A (50 + 8 = 58).
    expect(result.current?.x).toBe(58);

    // The parent re-points the anchor at element B (selection switch).
    anchor.current = elementB;
    rerender();

    // The reposition effect on the new anchorEl reads element B's rect.
    expect(result.current?.x).toBe(258); // 200 + 50 + 8

    // Verify the ResizeObserver re-attached to B: only the LIVE
    // observer's callback should reposition. We resize B and check
    // that's reflected.
    setRect(elementB, { left: 200, top: 100, width: 100, height: 40 });
    act(() => {
      // Fire the latest-attached callback (the test shim pushes them
      // into `capturedResizeCallbacks` in order; the disconnect on
      // re-subscribe filters out the old one).
      capturedResizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
    });
    expect(result.current?.x).toBe(308); // 200 + 100 + 8
  });

  // Bottom placement centers the overlay on the anchor (not aligned
  // left-edge), so a node that re-centers when its column grows during a
  // width-slider drag doesn't drag the editor horizontally with it.
  describe('placement: bottom with overlayRef + flip', () => {
    function makeOverlayRef(rect: { left?: number; top?: number; width: number; height: number }) {
      const el = document.createElement('div');
      setRect(el, {
        left: rect.left ?? 0,
        top: rect.top ?? 0,
        width: rect.width,
        height: rect.height,
      });
      return { current: el } as React.RefObject<HTMLElement>;
    }

    it('centers the overlay on the anchor when overlay width is known', () => {
      const anchor = makeAnchorRef({ left: 500, top: 200, width: 80, height: 40 });
      const overlay = makeOverlayRef({ width: 288, height: 100 });
      // A generous viewport so neither edge clamp engages.
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2000 });
      const { result } = renderHook(() =>
        useAnchorPosition({
          anchorRef: anchor,
          overlayRef: overlay,
          camera: { x: 0, y: 0, z: 1 },
          placement: 'bottom',
          offset: 12,
          flip: true,
        }),
      );

      // anchor center = 500 + 80/2 = 540, so overlay.left = 540 - 288/2 = 396.
      // Y = 200 + 40 + 12 = 252.
      expect(result.current?.x).toBe(396);
      expect(result.current?.y).toBe(252);
    });

    it('flips to top when the overlay would not fit below the anchor', () => {
      // Anchor near the bottom of the viewport with not enough space
      // below for a tall overlay → flip.
      const anchor = makeAnchorRef({ left: 200, top: 600, width: 80, height: 40 });
      const overlay = makeOverlayRef({ width: 288, height: 400 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2000 });
      const { result } = renderHook(() =>
        useAnchorPosition({
          anchorRef: anchor,
          overlayRef: overlay,
          camera: { x: 0, y: 0, z: 1 },
          placement: 'bottom',
          offset: 12,
          flip: true,
        }),
      );

      // Bottom: would need anchor.bottom (640) + 12 + 400 = 1052 vs vh 800 → no fit.
      // Top: anchor.top (600) - 12 - 400 = 188 → fits. Flip lands here.
      expect(result.current?.y).toBe(188);
    });

    it('keeps the overlay X stable when the anchor re-centers (width-drag scenario)', () => {
      // Simulates the user dragging the width slider:
      //   - Pre-drag: node is 128 wide, centered → anchor.center = 240
      //   - Mid-drag: node grew to 200 wide, still centered → anchor.center = 240
      // The column re-centered around the node in flex-justify-center,
      // so anchor.left shifted (176→140) but anchor.center stayed put.
      // The overlay's X should NOT change.
      const anchor = makeAnchorRef({ left: 176, top: 400, width: 128, height: 40 });
      const overlay = makeOverlayRef({ width: 288, height: 100 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2000 });
      const { result } = renderHook(() =>
        useAnchorPosition({
          anchorRef: anchor,
          overlayRef: overlay,
          camera: { x: 0, y: 0, z: 1 },
          placement: 'bottom',
          offset: 12,
          flip: true,
        }),
      );
      const xBefore = result.current?.x;

      // Resize anchor: same center (240), wider width (left 140, width 200).
      setRect(anchor.current!, { left: 140, top: 400, width: 200, height: 40 });
      act(() => {
        capturedResizeCallbacks.forEach((cb) => cb([], {} as ResizeObserver));
      });
      const xAfter = result.current?.x;

      expect(xBefore).toBeDefined();
      expect(xAfter).toBe(xBefore);
    });
  });

  // The overlay must stay inside the visible area: below the fixed top
  // bar, above the window's bottom edge, and between its side edges.
  // A tall overlay takes the larger side of the anchor and gets a
  // `maxHeight` so it can scroll internally instead of overflowing.
  describe('viewport containment', () => {
    const TOP_INSET = 41;
    // computePosition's edge margin: 8px on every side.
    const MARGIN = 8;

    function setViewport(width: number, height: number) {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
    }

    function makeOverlay(
      width: number,
      height: number,
      content?: { scrollHeight: number; clientHeight: number },
    ) {
      const el = document.createElement('div');
      setRect(el, { left: 0, top: 0, width, height });
      if (content) {
        Object.defineProperty(el, 'scrollHeight', {
          configurable: true,
          value: content.scrollHeight,
        });
        Object.defineProperty(el, 'clientHeight', {
          configurable: true,
          value: content.clientHeight,
        });
      }
      return { current: el } as React.RefObject<HTMLElement>;
    }

    function place(
      anchorRect: { left: number; top: number; width: number; height: number },
      overlay: React.RefObject<HTMLElement>,
      opts: { placement?: 'bottom' | 'right'; flip?: boolean; topInset?: number } = {},
    ) {
      const anchor = makeAnchorRef(anchorRect);
      return renderHook(() =>
        useAnchorPosition({
          anchorRef: anchor,
          overlayRef: overlay,
          camera: { x: 0, y: 0, z: 1 },
          placement: opts.placement ?? 'bottom',
          offset: 12,
          flip: opts.flip ?? true,
          topInset: opts.topInset ?? TOP_INSET,
        }),
      );
    }

    // Viewport 1000x700: the usable band is y 49..692 (643px).
    beforeEach(() => setViewport(1000, 700));

    it('does not flip above when the room above is eaten by the top bar', () => {
      // anchor.top - offset = 488 would hold a 460px overlay, but the
      // top bar leaves only 488 - 49 = 439px.
      const { result } = place(
        { left: 400, top: 500, width: 80, height: 40 },
        makeOverlay(288, 460),
      );
      expect(result.current?.y).toBe(49);
      expect(result.current?.maxHeight).toBe(439);
    });

    it('keeps the overlay under the top bar after flipping above', () => {
      const { result } = place(
        { left: 400, top: 560, width: 80, height: 40 },
        makeOverlay(288, 300),
      );
      // Below: 692 - 612 = 80 (no fit). Above: 560 - 12 - 300 = 248.
      expect(result.current?.y).toBe(248);
      expect(result.current!.y).toBeGreaterThanOrEqual(TOP_INSET + MARGIN);
    });

    it('caps the height at the larger side when neither side fits', () => {
      // Below: 692 - (370 + 12) = 310. Above: 330 - 12 - 49 = 269.
      const { result } = place(
        { left: 400, top: 330, width: 80, height: 40 },
        makeOverlay(288, 450),
      );
      expect(result.current?.maxHeight).toBe(310);
      expect(result.current?.y).toBe(382);
      expect(result.current!.y + 310).toBeLessThanOrEqual(700 - MARGIN);
    });

    it('caps a taller-than-the-window overlay inside the usable band', () => {
      const { result } = place(
        { left: 400, top: 330, width: 80, height: 40 },
        makeOverlay(288, 3000),
      );
      const { y, maxHeight } = result.current!;
      expect(maxHeight).not.toBeNull();
      expect(y).toBeGreaterThanOrEqual(TOP_INSET + MARGIN);
      expect(y + maxHeight!).toBeLessThanOrEqual(700 - MARGIN);
    });

    it('overlaps the anchor rather than shrink below a usable height', () => {
      // 400px-tall window: 140px below and 139px above the anchor.
      setViewport(1000, 400);
      const { result } = place(
        { left: 400, top: 200, width: 80, height: 40 },
        makeOverlay(288, 450),
      );
      const { y, maxHeight } = result.current!;
      expect(maxHeight).toBe(240);
      expect(y).toBeGreaterThanOrEqual(TOP_INSET + MARGIN);
      expect(y + 240).toBeLessThanOrEqual(400 - MARGIN);
    });

    it('pins the overlay to the top edge when its anchor is panned above the screen', () => {
      const { result } = place(
        { left: 400, top: -300, width: 80, height: 40 },
        makeOverlay(288, 400),
      );
      expect(result.current?.y).toBe(TOP_INSET + MARGIN);
    });

    it('pins the overlay to the bottom edge when its anchor is panned below the screen', () => {
      const { result } = place(
        { left: 400, top: 900, width: 80, height: 40 },
        makeOverlay(288, 400),
      );
      expect(result.current?.y).toBe(700 - MARGIN - 400);
    });

    it('measures the natural height through the cap (scrollHeight, not the capped box)', () => {
      // The box is capped at 250 but its content is 400 + 2 (border).
      // Below the anchor only 100 is free (692 - 592); above it 479 is
      // (540 - 12 - 49), so the overlay must move above rather than stay
      // capped below.
      const { result } = place(
        { left: 400, top: 540, width: 80, height: 40 },
        makeOverlay(288, 250, { scrollHeight: 400, clientHeight: 248 }),
      );
      expect(result.current?.y).toBe(540 - 12 - 402);
    });

    it('watches the overlay content as well as its box', () => {
      // Once capped, the box stops growing while the content still does.
      const overlay = makeOverlay(288, 300);
      const header = document.createElement('div');
      const details = document.createElement('div');
      overlay.current!.append(header, details);
      const observed: Element[] = [];
      class RecordingObserver extends ResizeObserverMock {
        override observe = vi.fn((el: Element) => {
          observed.push(el);
        });
      }
      // @ts-expect-error - test shim
      globalThis.ResizeObserver = RecordingObserver;

      place({ left: 400, top: 330, width: 80, height: 40 }, overlay);

      expect(observed).toContain(overlay.current);
      expect(observed).toContain(header);
      expect(observed).toContain(details);
    });

    it('reports no height cap while the overlay is unmeasured', () => {
      const anchor = makeAnchorRef({ left: 400, top: 300, width: 80, height: 40 });
      const { result } = renderHook(() =>
        useAnchorPosition({
          anchorRef: anchor,
          camera: { x: 0, y: 0, z: 1 },
          placement: 'bottom',
          offset: 12,
          flip: true,
          topInset: TOP_INSET,
        }),
      );
      expect(result.current?.maxHeight).toBeNull();
    });

    it('flips a right placement to the left edge and slides it up near the corner', () => {
      // A point anchor (connection midpoint) near the bottom-right.
      const { result } = place(
        { left: 900, top: 600, width: 1, height: 1 },
        makeOverlay(320, 330),
        { placement: 'right', flip: true },
      );
      const { x, y } = result.current!;
      expect(x).toBe(900 - 12 - 320);
      expect(y).toBe(700 - MARGIN - 330);
    });

    it('keeps a right placement on the right when it fits', () => {
      const { result } = place(
        { left: 300, top: 200, width: 1, height: 1 },
        makeOverlay(320, 330),
        { placement: 'right', flip: true },
      );
      expect(result.current?.x).toBe(301 + 12);
      expect(result.current?.y).toBe(200);
    });

    it('lets a right placement take the whole usable band', () => {
      const { result } = place(
        { left: 300, top: 200, width: 1, height: 1 },
        makeOverlay(320, 330),
        { placement: 'right', flip: true },
      );
      expect(result.current?.maxHeight).toBe(700 - MARGIN - (TOP_INSET + MARGIN));
    });

    it('keeps the overlay inside the right edge when its anchor is near it', () => {
      // Centered on the anchor it would start at 980 - 144 = 836 and end
      // past the window; the last place it fits starts at 1000 - 8 - 288.
      const { result } = place(
        { left: 940, top: 300, width: 80, height: 40 },
        makeOverlay(288, 100),
      );
      expect(result.current?.x).toBe(1000 - MARGIN - 288);
    });

    it('keeps following the anchor frame by frame after a window resize, then stops', () => {
      vi.useFakeTimers({
        toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
      });
      try {
        const anchor = makeAnchorRef({ left: 400, top: 300, width: 80, height: 40 });
        const overlay = makeOverlay(288, 100);
        const { result } = renderHook(() =>
          useAnchorPosition({
            anchorRef: anchor,
            overlayRef: overlay,
            camera: { x: 0, y: 0, z: 1 },
            placement: 'bottom',
            offset: 12,
            flip: true,
            topInset: TOP_INSET,
          }),
        );
        expect(result.current?.x).toBe(400 + 40 - 144);

        act(() => {
          window.dispatchEvent(new Event('resize'));
        });
        // The canvas re-centres itself after the first frame, which no
        // signal the hook listens to reports: only a later frame of the
        // loop sees the anchor move.
        act(() => {
          vi.advanceTimersByTime(20);
        });
        setRect(anchor.current!, { left: 600, top: 300, width: 80, height: 40 });
        act(() => {
          vi.advanceTimersByTime(50);
        });
        expect(result.current?.x).toBe(600 + 40 - 144);

        // Past the follow window the loop has ended.
        act(() => {
          vi.advanceTimersByTime(1000);
        });
        setRect(anchor.current!, { left: 700, top: 300, width: 80, height: 40 });
        act(() => {
          vi.advanceTimersByTime(100);
        });
        expect(result.current?.x).toBe(600 + 40 - 144);
      } finally {
        vi.useRealTimers();
      }
    });

    it('repositions when the window is resized', () => {
      const { result } = place(
        { left: 400, top: 330, width: 80, height: 40 },
        makeOverlay(288, 450),
      );
      expect(result.current?.maxHeight).toBe(310);

      setViewport(1000, 500);
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      // Below: 492 - 382 = 110. Above: 269. The larger side wins.
      expect(result.current?.maxHeight).toBe(269);
    });
  });
});
