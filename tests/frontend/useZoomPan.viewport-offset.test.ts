// Regression test for PR #34 fb3 known-issue K1 (second half).
//
// useZoomPan must recompute fitToScreenZoom when the `viewportOffset`
// PROP changes — without waiting for a window `resize` event. Pre-fix,
// the fit-zoom effect's deps were [containerSize.width,
// containerSize.height, calculateFitToScreenZoom] where the callback is
// dep-stable and reads the offset only through a ref, so a new offset
// never re-ran the effect. Consequences:
//
//   - App's resize-subscribed offset (useViewportOffset) raced the
//     hook's own debounced resize listener: two independent 100ms
//     timers from the same resize event, and if the hook's fired
//     before React committed App's re-render, it read the STALE ref
//     and nothing ever re-ran with the fresh value.
//   - Toggling the chat drawer (which changes the offset with NO
//     resize event) recentered the canvas but never re-fit its scale.
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { useZoomPan } from '../../src/hooks/useZoomPan';

afterEach(() => {
  cleanup();
});

interface Offset {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// jsdom window is 1024x768. containerSize 968x600 → content (with the
// 32px embed padding) is 1000x632, so scaleY ≈ 1.038 never binds and
// fitZoom is the horizontal scale: (1024 - left - right) / 1000.
function renderZoomPan(viewportOffset: Offset) {
  return renderHook(
    ({ offset }: { offset: Offset }) => {
      const containerRef = useRef<HTMLDivElement | null>(null);
      return useZoomPan({
        containerSize: { width: 968, height: 600 },
        containerRef,
        viewportOffset: offset,
      });
    },
    { initialProps: { offset: viewportOffset } },
  );
}

describe('useZoomPan × viewportOffset changes (PR #34 fb3 K1)', () => {
  it('recomputes fitToScreenZoom when the reserve shrinks, without a resize event', () => {
    // Stale-1920 reserve: left 424 → availW 576 → fit 0.576.
    const { result, rerender } = renderZoomPan({ left: 424, top: 88, right: 24, bottom: 24 });
    expect(result.current.fitToScreenZoom).toBeCloseTo(0.576, 3);

    // Fresh reserve for a narrower drawer: left 344 → availW 656 → 0.656.
    act(() => {
      rerender({ offset: { left: 344, top: 88, right: 24, bottom: 24 } });
    });
    expect(result.current.fitToScreenZoom).toBeCloseTo(0.656, 3);
  });

  it('floors the camera up to the new fit zoom when the reserve shrinks', () => {
    const { result, rerender } = renderZoomPan({ left: 424, top: 88, right: 24, bottom: 24 });
    expect(result.current.camera.z).toBeCloseTo(0.576, 3);

    act(() => {
      rerender({ offset: { left: 344, top: 88, right: 24, bottom: 24 } });
    });
    // Camera was AT the old fit (not zoomed in), so it follows the new
    // fit instead of being left below it.
    expect(result.current.camera.z).toBeCloseTo(0.656, 3);
  });
});
