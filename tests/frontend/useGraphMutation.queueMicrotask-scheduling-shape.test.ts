// Deferral-primitive regression test: a `mutate()` must not commit through the
// store synchronously inside the caller, nor on a timer, because the writes of
// one event handler have to coalesce into one commit (one undo step).
//
// What it asserts: when `mutate()` is invoked, `queueMicrotask` is called at
// least once. This is shape-only by design; the coalescing itself is pinned by
// `useGraphMutation.mutate.test.ts`.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import type { ToCData } from '../../src/types';
import { makeDoc } from './helpers/renderToC';

const makeData = (): ToCData => ({
  title: 'init',
  sections: [],
});

describe('useGraphMutation queueMicrotask scheduling shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules the commit via queueMicrotask (not synchronous, not setTimeout)', () => {
    const { doc } = makeDoc(makeData());
    const queueSpy = vi.spyOn(globalThis, 'queueMicrotask');

    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutate((prev) => ({ ...prev, title: 'changed' }));
    });

    // The hook must schedule via queueMicrotask. A synchronous commit or a
    // setTimeout-deferred one would fail this assertion.
    expect(queueSpy).toHaveBeenCalled();
  });
});
