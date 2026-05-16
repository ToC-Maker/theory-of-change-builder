// Tests for the explicit-commit flush path and the consecutive-`mutate`
// collapse semantics.
//
// Acceptance:
//   1. `commit('key')` flushes a single key and dispatches `onDataChange`
//      via queueMicrotask.
//   2. `commit()` with no args flushes all buffered keys in insertion order.
//   3. 60 `mutateDebounced('key', ...)` calls followed by one `commit('key')`
//      produces exactly one `onDataChange` invocation. (Red-Team Critical
//      finding "Slider callsite migration": this is the intended L3 fix.)
//   4. Multiple synchronous mutate() calls collapse to a single notify.
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

describe('useGraphMutation.commit', () => {
  it('commit(key) flushes only that key', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
      result.current.mutateDebounced((prev) => ({ ...prev, textSize: 2 }), 'textSize');
    });

    act(() => {
      result.current.commit('curvature');
    });

    await flushMicrotasks();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    // After commit, 'textSize' is still buffered. State already reflects it
    // (live preview), but the parent has only seen the curvature commit so
    // far. Commit textSize to confirm second notify.
    act(() => {
      result.current.commit('textSize');
    });
    await flushMicrotasks();
    expect(onDataChange).toHaveBeenCalledTimes(2);
  });

  it('commit() with no args flushes all buffered keys in insertion order', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, curvature: 0.9 }), 'curvature');
      result.current.mutateDebounced((prev) => ({ ...prev, textSize: 2 }), 'textSize');
    });

    act(() => {
      result.current.commit();
    });

    await flushMicrotasks();

    // One coalesced notify carries both writes.
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const emitted = onDataChange.mock.calls[0]?.[0];
    expect(emitted?.curvature).toBe(0.9);
    expect(emitted?.textSize).toBe(2);
  });

  it('coalesces 60 mutateDebounced("width-x", ...) + commit into one onDataChange', async () => {
    // L3 acceptance test (Red-Team Critical):
    //   60 Hz slider drag = 60 mutateDebounced calls + commit on pointerup
    //   → exactly one undo entry per gesture, exactly one parent notify.
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      for (let i = 0; i < 60; i++) {
        const value = i;
        result.current.mutateDebounced(
          (prev) => ({ ...prev, curvature: value / 100 }),
          'width-multi',
        );
      }
    });
    expect(onDataChange).not.toHaveBeenCalled();

    act(() => {
      result.current.commit('width-multi');
    });

    await flushMicrotasks();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(onDataChange.mock.calls[0]?.[0].curvature).toBe(0.59); // last value
  });

  it('collapses two synchronous mutate() calls into one onDataChange (pendingNotifyRef)', async () => {
    // Architecture Important finding: `useGraphMutation` lacks a
    // transactional-batch primitive. Two synchronous mutate() calls in the
    // same task should collapse to one parent notify via a single
    // queueMicrotask slot.
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutate((prev) => ({ ...prev, curvature: 0.6 }));
      result.current.mutate((prev) => ({ ...prev, textSize: 2 }));
    });

    await flushMicrotasks();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    const emitted = onDataChange.mock.calls[0]?.[0];
    expect(emitted?.curvature).toBe(0.6);
    expect(emitted?.textSize).toBe(2);
  });
});
