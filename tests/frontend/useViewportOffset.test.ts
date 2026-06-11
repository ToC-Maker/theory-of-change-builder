// Tests for useViewportOffset (PR #34 fb3 known-issues K1 + K2).
//
// K1: the canvas auto-fit reserve mirrors the chat drawer's CSS clamp
// `clamp(25vw, 280px, 400px)`, which READS window.innerWidth — so the
// reserve must subscribe to window resize (debounced, so drag-resizing
// doesn't thrash the autofit) instead of being recomputed only when the
// drawer collapse state toggles. Pre-fix, App.tsx computed the offset in
// a useMemo keyed on [isLeftPanelCollapsed] alone: a 1920 → 1280 live
// resize left an 80px stale reserve (rodney-measured: leftBand 104 vs
// rightBand 24) until a collapse-toggle or reload.
//
// K2: the top reserve claimed 64px for a TopBar whose real rendered
// height is 53px (`min-h-[52px]` row, TopBar.tsx + 1px border-b) —
// an 11px top/bottom band asymmetry at every viewport size.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import {
  useViewportOffset,
  computeViewportOffset,
  VIEWPORT_PAD_PX,
} from '../../src/hooks/useViewportOffset';

const setWindowWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

const fireResize = () => {
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setWindowWidth(1024); // jsdom default
});

describe('computeViewportOffset', () => {
  it('mirrors the expanded drawer clamp at md+ (25vw clamped to [280, 400]) plus the 24px pad', () => {
    expect(computeViewportOffset(false, 1920).left).toBe(400 + VIEWPORT_PAD_PX); // max-w binds
    expect(computeViewportOffset(false, 1280).left).toBe(320 + VIEWPORT_PAD_PX); // 25vw
    expect(computeViewportOffset(false, 1024).left).toBe(280 + VIEWPORT_PAD_PX); // min-w binds
  });

  it('reserves the 48px collapsed rail regardless of width', () => {
    expect(computeViewportOffset(true, 1920).left).toBe(48 + VIEWPORT_PAD_PX);
    expect(computeViewportOffset(true, 640).left).toBe(48 + VIEWPORT_PAD_PX);
  });

  it('keeps the legacy quarter-width reserve below md (mobile overlay drawer)', () => {
    expect(computeViewportOffset(false, 640).left).toBe(Math.floor(640 * 0.25) + VIEWPORT_PAD_PX);
  });

  it('pads right and bottom with the shared 24px breathing room', () => {
    const offset = computeViewportOffset(false, 1920);
    expect(offset.right).toBe(VIEWPORT_PAD_PX);
    expect(offset.bottom).toBe(VIEWPORT_PAD_PX);
  });
});

describe('useViewportOffset', () => {
  it('recomputes the reserve after a live window resize (K1)', () => {
    vi.useFakeTimers();
    setWindowWidth(1920);
    const { result } = renderHook(() => useViewportOffset(false));
    expect(result.current.left).toBe(400 + VIEWPORT_PAD_PX);

    setWindowWidth(1280);
    fireResize();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current.left).toBe(320 + VIEWPORT_PAD_PX);
  });

  it('debounces a resize burst into one trailing recompute', () => {
    vi.useFakeTimers();
    setWindowWidth(1920);
    const { result } = renderHook(() => useViewportOffset(false));

    setWindowWidth(1600);
    fireResize();
    act(() => {
      vi.advanceTimersByTime(50);
    });
    setWindowWidth(1280);
    fireResize();
    // 99ms after the LAST event: still the mount-time value (drag-resize
    // must not thrash the canvas autofit).
    act(() => {
      vi.advanceTimersByTime(99);
    });
    expect(result.current.left).toBe(400 + VIEWPORT_PAD_PX);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.left).toBe(320 + VIEWPORT_PAD_PX);
  });

  it('responds to a drawer toggle immediately (no debounce)', () => {
    setWindowWidth(1920);
    const { result, rerender } = renderHook(({ collapsed }) => useViewportOffset(collapsed), {
      initialProps: { collapsed: false },
    });
    expect(result.current.left).toBe(400 + VIEWPORT_PAD_PX);
    rerender({ collapsed: true });
    expect(result.current.left).toBe(48 + VIEWPORT_PAD_PX);
  });

  it('keeps a stable object identity across unrelated re-renders', () => {
    // useZoomPan's fit-zoom effect keys on the offset's identity; a
    // fresh object per render would re-run it on every App render.
    setWindowWidth(1920);
    const { result, rerender } = renderHook(({ collapsed }) => useViewportOffset(collapsed), {
      initialProps: { collapsed: false },
    });
    const first = result.current;
    rerender({ collapsed: false });
    expect(result.current).toBe(first);
  });

  it('stops listening after unmount', () => {
    vi.useFakeTimers();
    setWindowWidth(1920);
    const { result, unmount } = renderHook(() => useViewportOffset(false));
    const last = result.current;
    unmount();
    setWindowWidth(1280);
    fireResize();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    // No crash, no update — listener and pending timer cleaned up.
    expect(last.left).toBe(400 + VIEWPORT_PAD_PX);
  });
});
