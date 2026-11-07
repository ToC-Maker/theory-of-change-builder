// Tests for the streaming-input path: `mutateDebounced(updater, key)`.
//
// Acceptance:
//   1. Live preview: the store's live chart reflects each `mutateDebounced`
//      call synchronously (so a slider feels responsive).
//   2. NOTHING is committed between mutateDebounced calls and a `commit`.
//   3. Repeated writes under one key make one commit ("1 undo entry per drag
//      gesture"): the key marks the preview as waiting, the store holds it.
//   4. Two properties written under one key still commit once (the
//      property-foot-gun documented in the hook's header comment).
//   5. Cross-key calls are marked independently; both commit on `commit()`.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import type { ToCData } from '../../src/types';
import { makeDoc } from './helpers/renderToC';

const makeData = (): ToCData => ({
  title: 'init',
  curvature: 0.5,
  textSize: 1,
  sections: [],
});

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('useGraphMutation.mutateDebounced', () => {
  it('previews each call synchronously without committing', async () => {
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.6 }), 'curvature');
    });
    expect(result.current.data.curvature).toBe(0.6);

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.7 }), 'curvature');
    });
    expect(result.current.data.curvature).toBe(0.7);

    // Even after microtasks drain, nothing is committed yet.
    await flushMicrotasks();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('replaces same-key updater so later calls supersede earlier ones', async () => {
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

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

    // The commit carries the final value (0.9); both previews were applied in turn.
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0].curvature).toBe(0.9);
  });

  it('commits ONCE when two same-key writes target different properties (foot-gun)', async () => {
    // Documents the foot-gun: sharing a key across two distinct properties
    // means the second mutateDebounced REPLACES the first in the buffer,
    // so the per-key idle timer / commit("key") flushes once instead of
    // twice. Both writes DO land in the live state (writeLocal applied
    // both synchronously), but there is ONE commit.
    //
    // Why this is a foot-gun: a contributor who shares a key across two
    // properties expects two separate commits (one per property);
    // they get one. If a subscriber uses the commit edge to trigger a
    // distinct side effect per property (e.g. logging two undo entries),
    // they'll be merged into one — silently dropping the earlier write's
    // SIGNAL even though its effect is in state.
    //
    // Future contributors who introduce key sharing across distinct
    // properties should fail this test.
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      // Intentional misuse: same key, two different properties.
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'shared-key');
      result.current.mutateDebounced((prev) => ({ ...prev, textSize: 2 }), 'shared-key');
    });

    act(() => {
      result.current.commit('shared-key');
    });

    await flushMicrotasks();

    // ONE commit, not two — the second mutateDebounced replaced the
    // first under the shared key, so the buffer only flushed once.
    expect(onCommit).toHaveBeenCalledTimes(1);
    const emitted = onCommit.mock.calls[0]?.[0];
    // The commit carries the full live state, so both properties are
    // committed. The drop is in the commit CADENCE, not the
    // value emitted.
    expect(emitted?.textSize).toBe(2);
    expect(emitted?.curvature).toBe(0.9);
  });

  it('buffers independent keys and flushes them all on commit()', async () => {
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
      result.current.mutateDebounced((prev) => ({ ...prev, textSize: 2 }), 'textSize');
    });

    expect(result.current.data.curvature).toBe(0.9);
    expect(result.current.data.textSize).toBe(2);
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      result.current.commit();
    });

    await flushMicrotasks();

    // One final commit with everything applied.
    expect(onCommit).toHaveBeenCalledTimes(1);
    const emitted = onCommit.mock.calls[0]?.[0];
    expect(emitted?.curvature).toBe(0.9);
    expect(emitted?.textSize).toBe(2);
  });

  it('idle-commits the buffered key after 200ms with no further calls', async () => {
    // Load-bearing for layout-setting sliders (curvature, textSize,
    // paddings) in PR 0: they call mutateDebounced but do NOT wire
    // pointerup -> commit. The hook's 200ms idle timer is the only
    // mechanism that commits the buffered preview. If it
    // breaks, slider changes never persist.
    vi.useFakeTimers();
    try {
      const { doc, onCommit } = makeDoc(makeData());
      const { result } = renderHook(() => useGraphMutation(doc));

      act(() => {
        result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
      });
      expect(onCommit).not.toHaveBeenCalled();

      // Advance just past the 200ms idle window.
      await act(async () => {
        vi.advanceTimersByTime(200);
        // Drain the queued microtask that scheduleCommit posts.
        await Promise.resolve();
      });

      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit.mock.calls[0]?.[0].curvature).toBe(0.9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('explicit commit clears the idle timer (no double-fire)', async () => {
    // Subtle bug class: if commit('key') schedules the commit but forgets
    // to clear the buffered key's idle timer, the timer fires 200ms
    // later and produces a second commit with the same value.
    vi.useFakeTimers();
    try {
      const { doc, onCommit } = makeDoc(makeData());
      const { result } = renderHook(() => useGraphMutation(doc));

      act(() => {
        result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
      });
      await act(async () => {
        result.current.commit('curvature');
        await Promise.resolve();
      });
      expect(onCommit).toHaveBeenCalledTimes(1);

      // Past where the idle timer WOULD have fired.
      await act(async () => {
        vi.advanceTimersByTime(500);
        await Promise.resolve();
      });
      expect(onCommit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useGraphMutation.discardBuffered', () => {
  it('forgets the key and clears the idle timer so no auto-commit fires', async () => {
    // The `mutateDebounced` 200ms idle timer auto-commits any buffered
    // key if neither `commit(key)` nor a follow-up `mutateDebounced`
    // arrives. `discardBuffered(key)` is the "true cancel" surface: it
    // clears the buffer entry and the idle timer so the live preview
    // stays in the store but nothing is committed.
    vi.useFakeTimers();
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
    });
    // Live preview applied synchronously.
    expect(result.current.data.curvature).toBe(0.9);

    act(() => {
      result.current.discardBuffered('curvature');
    });

    // Advance past the 200ms idle timer.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await vi.runAllTimersAsync();

    // Neither the discard nor the idle timer committed anything.
    expect(onCommit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('no-ops cleanly for an unknown key', () => {
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.discardBuffered('never-buffered');
    });

    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('useGraphMutation.mutateDebounced with idleCommit: false', () => {
  it('never commits on its own, only on an explicit commit', async () => {
    vi.useFakeTimers();
    try {
      const { doc, onCommit } = makeDoc(makeData());
      const { result } = renderHook(() => useGraphMutation(doc));

      act(() => {
        result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature', {
          idleCommit: false,
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(onCommit).not.toHaveBeenCalled();
      expect(result.current.data.curvature).toBe(0.9);

      act(() => {
        result.current.commit('curvature');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(onCommit.mock.calls[0][0].curvature).toBe(0.9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the idle timer an earlier call of the same key had armed', async () => {
    vi.useFakeTimers();
    try {
      const { doc, onCommit } = makeDoc(makeData());
      const { result } = renderHook(() => useGraphMutation(doc));

      act(() => {
        result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.6 }), 'curvature');
        result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature', {
          idleCommit: false,
        });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(onCommit).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useGraphMutation.notifyCount', () => {
  it('counts each commit, not each mutation', async () => {
    const { doc } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));
    expect(result.current.notifyCount()).toBe(0);

    // Two synchronous mutations collapse to one commit.
    act(() => {
      result.current.mutate((prev) => ({ ...prev, curvature: 0.6 }));
      result.current.mutate((prev) => ({ ...prev, curvature: 0.7 }));
    });
    await flushMicrotasks();
    expect(result.current.notifyCount()).toBe(1);

    // A buffered write is not a commit until it is committed.
    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, textSize: 2 }), 'textSize');
    });
    expect(result.current.notifyCount()).toBe(1);
    act(() => {
      result.current.commit('textSize');
    });
    await flushMicrotasks();
    expect(result.current.notifyCount()).toBe(2);
  });
});
