// Tests for the synchronous-mutate path of `useGraphMutation`.
//
// Acceptance for `mutate(updater)`:
//   1. The preview reaches the store synchronously (live state updates in the
//      same task).
//   2. The store commits exactly once per mutate, on a microtask, so the
//      commit runs after the event handler's own work and not inside the updater.
//   (Two synchronous `mutate` calls collapsing to one commit is pinned in
//   `useGraphMutation.commit.test.ts`.)
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import type { ToCData } from '../../src/types';
import { makeDoc } from './helpers/renderToC';

const makeData = (title = 'init'): ToCData => ({
  title,
  sections: [],
});

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('useGraphMutation.mutate', () => {
  it('previews synchronously and commits on the next microtask', async () => {
    const { doc, onCommit } = makeDoc(makeData());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutate((prev) => ({ ...prev, title: 'changed' }));
    });

    // Synchronous reflect: state is already updated.
    expect(result.current.data.title).toBe('changed');
    // Nothing is committed yet (still in the current task).
    expect(onCommit).not.toHaveBeenCalled();

    await flushMicrotasks();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0].title).toBe('changed');
  });

  it('accepts a non-function updater', async () => {
    const { doc, onCommit } = makeDoc(makeData());
    const next: ToCData = { title: 'replaced', sections: [] };
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutate(next);
    });

    expect(result.current.data).toEqual(next);
    await flushMicrotasks();
    expect(onCommit).toHaveBeenCalledWith(next);
  });
});
