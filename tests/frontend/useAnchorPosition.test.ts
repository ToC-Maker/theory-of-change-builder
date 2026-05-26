// Tests for `useAnchorPosition` — repositions an overlay continuously
// alongside its anchor element. The hook is the unification point for
// the three subscription paths the plan §3.2 enumerates: camera changes
// (pan/zoom), ResizeObserver (anchor resize), throttled MutationObserver
// (DOM-tree changes that re-flow the anchor).
//
// Acceptance gates:
//   - Camera prop changes → reposition (recomputed from element rect).
//   - ResizeObserver callback → reposition.
//   - No anchor → returns null (caller can skip rendering).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
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

  // PR 7 feedback-editor: bottom-placement centers the overlay on the
  // anchor (not aligned left-edge), so a node that re-centers when its
  // column grows during a width-slider drag doesn't drag the editor
  // horizontally with it. This pair of tests covers the new contract.
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
      const anchor = makeAnchorRef({ left: 100, top: 200, width: 80, height: 40 });
      const overlay = makeOverlayRef({ width: 288, height: 100 });
      // Force a generous viewport so the clamp doesn't engage.
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

      // anchor center = 100 + 80/2 = 140. Overlay center should equal
      // 140 → overlay.left = 140 - 288/2 = -4. Y = 200 + 40 + 12 = 252.
      // (Negative x is fine — the clamp's lower bound is 8, but the
      // test viewport is wide enough that the floor doesn't apply
      // unless we engineer it. We keep x small so the math is
      // unambiguous.)
      expect(result.current?.x).toBe(8); // clamped to floor (anchor center 140 - 144 < 8)
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
});
