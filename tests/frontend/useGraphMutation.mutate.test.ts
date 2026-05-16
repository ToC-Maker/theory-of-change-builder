// Tests for the synchronous-mutate path of `useGraphMutation`.
//
// Acceptance for `mutate(updater)`:
//   1. `setData` is called synchronously (live state updates in the same task).
//   2. `onDataChange` fires exactly once per mutate, deferred to a microtask
//      so it runs after React's commit phase (not synchronously inside the
//      updater — see file-header comment on the hook for the failure class).
//   3. Two synchronous `mutate` calls collapse to exactly one `onDataChange`
//      via the shared `pendingNotifyRef` queueMicrotask slot.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import type { ToCData } from '../../src/types';

const makeData = (title = 'init'): ToCData => ({
  title,
  sections: [],
});

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('useGraphMutation.mutate', () => {
  it('updates local state synchronously and notifies parent on the next microtask', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutate((prev) => ({ ...prev, title: 'changed' }));
    });

    // Synchronous reflect: state is already updated.
    expect(result.current.data.title).toBe('changed');
    // Parent has not been notified yet (still in current task).
    expect(onDataChange).not.toHaveBeenCalled();

    await flushMicrotasks();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(onDataChange.mock.calls[0]?.[0].title).toBe('changed');
  });

  it('collapses two synchronous mutate calls into one parent notification', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutate((prev) => ({ ...prev, title: 'first' }));
      result.current.mutate((prev) => ({ ...prev, title: 'second' }));
    });

    expect(result.current.data.title).toBe('second');
    await flushMicrotasks();

    // Both writes land, but the parent only learns the final value once.
    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(onDataChange.mock.calls[0]?.[0].title).toBe('second');
  });

  it('accepts a non-function updater', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const next: ToCData = { title: 'replaced', sections: [] };
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutate(next);
    });

    expect(result.current.data).toEqual(next);
    await flushMicrotasks();
    expect(onDataChange).toHaveBeenCalledWith(next);
  });
});
