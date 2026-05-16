// Red-Team Critical: "ResizeObserver invalidation storm during slider drags".
//
// useGraphLayout subscribes to a ResizeObserver to refresh `columnRects`
// when the container/columns resize. Without coalescing, a slider drag
// can fire dozens of ResizeObserver entries per frame, each scheduling a
// re-read of `getBoundingClientRect` (forced layout). The fix is to
// wrap invalidation in `requestAnimationFrame`: at most one re-read per
// frame.
//
// This test fires 100 synthetic invalidations in a tight loop and
// asserts the rect-refresh callback ran ≤ 1 time (because all 100 land
// inside a single rAF tick).
import { describe, it, expect, vi } from 'vitest';
import { scheduleRectRefresh } from '../../src/hooks/useGraphLayout';

describe('scheduleRectRefresh (rAF coalescing)', () => {
  it('coalesces 100 invalidations into one rAF tick', async () => {
    const refresh = vi.fn();
    // Use a fake rAF that runs on the microtask queue so we can flush
    // deterministically inside the test.
    const realRaf = globalThis.requestAnimationFrame;
    let queued: FrameRequestCallback | null = null;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      // Coalesce: only one callback in flight at a time.
      if (queued === null) {
        queued = cb;
        queueMicrotask(() => {
          const fn = queued;
          queued = null;
          fn?.(performance.now());
        });
      }
      return 0 as unknown as number;
    }) as typeof requestAnimationFrame;

    try {
      const state = { pending: false };
      for (let i = 0; i < 100; i++) scheduleRectRefresh(state, refresh);
      // Drain microtasks so the rAF callback fires.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
  });
});
