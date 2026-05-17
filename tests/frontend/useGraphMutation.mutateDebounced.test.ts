// Tests for the streaming-input path: `mutateDebounced(updater, key)`.
//
// Acceptance:
//   1. Live preview: local state reflects each `mutateDebounced` call
//      synchronously (so a slider feels responsive).
//   2. NO `onDataChange` fires between mutateDebounced calls and a `commit`.
//   3. Same-key calls REPLACE the buffered updater (latest wins). This is
//      load-bearing for "1 undo entry per drag gesture" — see Red-Team
//      Critical finding "Slider callsite migration is not behavior-equivalent".
//   4. Same-key-different-content correctly drops the earlier write (the
//      property-foot-gun documented in the file-header comment).
//   5. Cross-key calls are buffered independently; both flush on `commit()`.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import type { ToCData } from '../../src/types';

const makeData = (): ToCData => ({
  title: 'init',
  curvature: 0.5,
  textSize: 1,
  sections: [],
});

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('useGraphMutation.mutateDebounced', () => {
  it('previews each call synchronously without notifying the parent', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.6 }), 'curvature');
    });
    expect(result.current.data.curvature).toBe(0.6);

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.7 }), 'curvature');
    });
    expect(result.current.data.curvature).toBe(0.7);

    // Even after microtasks drain, the parent has not been notified yet.
    await flushMicrotasks();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('replaces same-key updater so later calls supersede earlier ones', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    const updater1 = vi.fn((prev: ToCData) => ({ ...prev, curvature: 0.6 }));
    const updater2 = vi.fn((prev: ToCData) => ({ ...prev, curvature: 0.9 }));

    act(() => {
      result.current.mutateDebounced(updater1, 'curvature');
      result.current.mutateDebounced(updater2, 'curvature');
    });

    act(() => {
      result.current.commit('curvature');
    });

    await flushMicrotasks();

    // The parent sees the final value (0.9); only updater2's effect is
    // emitted to the parent (updater1 is replaced *for parent purposes*).
    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(onDataChange.mock.calls[0]?.[0].curvature).toBe(0.9);
  });

  it('emits a SINGLE parent notify when two same-key writes target different properties (foot-gun)', async () => {
    // Documents the foot-gun: sharing a key across two distinct properties
    // means the second mutateDebounced REPLACES the first in the buffer,
    // so the per-key idle timer / commit("key") flushes once instead of
    // twice. Both writes DO land in the live state (writeLocal applied
    // both synchronously), but the parent only sees ONE onDataChange.
    //
    // Why this is a foot-gun: a contributor who shares a key across two
    // properties expects two separate notifications (one per property);
    // they get one. If the parent uses the notify edge to trigger a
    // distinct side effect per property (e.g. logging two undo entries),
    // they'll be merged into one — silently dropping the earlier write's
    // SIGNAL even though its effect is in state.
    //
    // Future contributors who introduce key sharing across distinct
    // properties should fail this test.
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      // Intentional misuse: same key, two different properties.
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'shared-key');
      result.current.mutateDebounced((prev) => ({ ...prev, textSize: 2 }), 'shared-key');
    });

    act(() => {
      result.current.commit('shared-key');
    });

    await flushMicrotasks();

    // ONE notify, not two — the second mutateDebounced replaced the
    // first under the shared key, so the buffer only flushed once.
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const emitted = onDataChange.mock.calls[0]?.[0];
    // The notify carries the full live state, so both properties are
    // visible to the parent. The drop is in the notify CADENCE, not the
    // value emitted.
    expect(emitted?.textSize).toBe(2);
    expect(emitted?.curvature).toBe(0.9);
  });

  it('buffers independent keys and flushes them all on commit()', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
      result.current.mutateDebounced((prev) => ({ ...prev, textSize: 2 }), 'textSize');
    });

    expect(result.current.data.curvature).toBe(0.9);
    expect(result.current.data.textSize).toBe(2);
    expect(onDataChange).not.toHaveBeenCalled();

    act(() => {
      result.current.commit();
    });

    await flushMicrotasks();

    // One final notify with everything applied.
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const emitted = onDataChange.mock.calls[0]?.[0];
    expect(emitted?.curvature).toBe(0.9);
    expect(emitted?.textSize).toBe(2);
  });

  it('idle-commits the buffered key after 200ms with no further calls', async () => {
    // Load-bearing for layout-setting sliders (curvature, textSize,
    // paddings) in PR 0: they call mutateDebounced but do NOT wire
    // pointerup -> commit. The hook's 200ms idle timer is the only
    // mechanism that ships the buffered updater to the parent. If it
    // breaks, slider changes never persist.
    vi.useFakeTimers();
    try {
      const onDataChange = vi.fn<(d: ToCData) => void>();
      const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

      act(() => {
        result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
      });
      expect(onDataChange).not.toHaveBeenCalled();

      // Advance just past the 200ms idle window.
      await act(async () => {
        vi.advanceTimersByTime(200);
        // Drain the queued microtask that scheduleNotify posts.
        await Promise.resolve();
      });

      expect(onDataChange).toHaveBeenCalledTimes(1);
      expect(onDataChange.mock.calls[0]?.[0].curvature).toBe(0.9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('explicit commit clears the idle timer (no double-fire)', async () => {
    // Subtle bug class: if commit('key') schedules the notify but forgets
    // to clear the buffered key's idle timer, the timer fires 200ms
    // later and produces a second notify with the same value.
    vi.useFakeTimers();
    try {
      const onDataChange = vi.fn<(d: ToCData) => void>();
      const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

      act(() => {
        result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
      });
      await act(async () => {
        result.current.commit('curvature');
        await Promise.resolve();
      });
      expect(onDataChange).toHaveBeenCalledTimes(1);

      // Past where the idle timer WOULD have fired.
      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
      });
      expect(onDataChange).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
