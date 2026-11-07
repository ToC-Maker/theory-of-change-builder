// Tests for the explicit-commit path and the consecutive-`mutate` collapse.
//
// Acceptance:
//   1. `commit('key')` commits through the store on a microtask. The store has
//      one preview layer, so it commits every key's preview, not only that key's.
//   2. `commit()` with no args commits all buffered keys at once.
//   3. 60 `mutateDebounced('key', ...)` calls followed by one `commit('key')`
//      produce exactly one commit.
//   4. Multiple synchronous mutate() calls collapse to a single commit.
//   5. commit() of a key with nothing buffered commits nothing: closing an
//      editor that changed nothing must not look like an edit (a save
//      and an undo step).
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

describe('useGraphMutation.commit', () => {
  it('commit(key) commits the whole preview layer, not only that key', async () => {
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
      result.current.mutateDebounced((prev) => ({ ...prev, textSize: 2 }), 'textSize');
    });

    act(() => {
      result.current.commit('curvature');
    });

    await flushMicrotasks();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0].curvature).toBe(0.9);
    expect(onCommit.mock.calls[0]?.[0].textSize).toBe(2);
    // 'textSize' is still marked, but its preview is already committed.
    act(() => {
      result.current.commit('textSize');
    });
    await flushMicrotasks();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commit() with no args flushes all buffered keys in insertion order', async () => {
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
      result.current.mutateDebounced((prev) => ({ ...prev, textSize: 2 }), 'textSize');
    });

    act(() => {
      result.current.commit();
    });

    await flushMicrotasks();

    // One coalesced commit carries both writes.
    expect(onCommit).toHaveBeenCalledTimes(1);
    const emitted = onCommit.mock.calls[0]?.[0];
    expect(emitted?.curvature).toBe(0.9);
    expect(emitted?.textSize).toBe(2);
  });

  it('coalesces 60 mutateDebounced("width-x", ...) + commit into one onCommit', async () => {
    // 60 Hz slider drag = 60 mutateDebounced calls + commit on pointerup
    //   → exactly one undo entry per gesture, exactly one commit.
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      for (let i = 0; i < 60; i++) {
        const value = i;
        result.current.mutateDebounced(
          (prev) => ({ ...prev, curvature: value / 100 }),
          'width-multi',
        );
      }
    });
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      result.current.commit('width-multi');
    });

    await flushMicrotasks();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0].curvature).toBe(0.59); // last value
  });

  it('collapses two synchronous mutate() calls into one commit', async () => {
    // Two synchronous mutate() calls in the same task share one commit via
    // a single queueMicrotask slot.
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutate((prev) => ({ ...prev, curvature: 0.6 }));
      result.current.mutate((prev) => ({ ...prev, textSize: 2 }));
    });

    await flushMicrotasks();

    expect(onCommit).toHaveBeenCalledTimes(1);
    const emitted = onCommit.mock.calls[0]?.[0];
    expect(emitted?.curvature).toBe(0.6);
    expect(emitted?.textSize).toBe(2);
  });
});

describe('useGraphMutation.commit with nothing buffered', () => {
  it('commit(key) for a key that was never written commits nothing', async () => {
    // Opening a node editor and closing it with Escape (or blurring a
    // field that was never typed in) commits the title/details keys.
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.commit('title-n1');
      result.current.commit('details-n1');
    });
    await flushMicrotasks();

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commit() with no arguments and nothing buffered commits nothing', async () => {
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.commit();
    });
    await flushMicrotasks();

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commit(key) for an unrelated key leaves the other previews alone and commits once, when that one flushes', async () => {
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
      result.current.commit('title-n1');
    });
    await flushMicrotasks();
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      result.current.commit('curvature');
    });
    await flushMicrotasks();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0].curvature).toBe(0.9);
  });

  it('commit(key) after the idle timer already flushed that key does not commit a second time', async () => {
    // Typing, pausing 200ms (the idle timer commits), then closing the
    // editor: the close-time commit has nothing new to report. A second
    // commit would add an extra undo step and an extra save.
    vi.useFakeTimers();
    try {
      const { doc, onCommit } = makeDoc(makeData());
      const { result } = renderHook(() => useGraphMutation(doc));

      act(() => {
        result.current.mutateDebounced((prev) => ({ ...prev, title: 'typed' }), 'title-n1');
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
        await Promise.resolve();
      });
      expect(onCommit).toHaveBeenCalledTimes(1);

      await act(async () => {
        result.current.commit('title-n1');
        await Promise.resolve();
      });
      expect(onCommit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('typing after an idle flush buffers the key again, so the close-time commit still commits', async () => {
    vi.useFakeTimers();
    try {
      const { doc, onCommit } = makeDoc(makeData());
      const { result } = renderHook(() => useGraphMutation(doc));

      act(() => {
        result.current.mutateDebounced((prev) => ({ ...prev, title: 'ty' }), 'title-n1');
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
        await Promise.resolve();
      });
      expect(onCommit).toHaveBeenCalledTimes(1);

      await act(async () => {
        result.current.mutateDebounced((prev) => ({ ...prev, title: 'typed' }), 'title-n1');
        result.current.commit('title-n1');
        await Promise.resolve();
      });
      expect(onCommit).toHaveBeenCalledTimes(2);
      expect(onCommit.mock.calls[1]?.[0].title).toBe('typed');
    } finally {
      vi.useRealTimers();
    }
  });
});
