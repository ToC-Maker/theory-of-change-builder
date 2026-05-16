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
});
