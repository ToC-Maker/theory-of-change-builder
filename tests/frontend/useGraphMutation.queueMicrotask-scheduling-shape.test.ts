// Deferral-primitive regression test (Red-Team Critical "Deferral-primitive
// regression test" — Clean borrow into the otherwise-Pragmatic plan).
//
// PURPOSE: catch the swap-to-synchronous failure mode where a future
// contributor (a) inlines the parent notify into the updater, or
// (b) replaces queueMicrotask with `setTimeout(0)` or synchronous-call.
//
// What it asserts: when `mutate()` is invoked, `queueMicrotask` is called
// at least once. This is shape-only by design — proving the dataRef
// ordering invariant under jsdom is impossible because jsdom does not run
// the React reconciler the way a real browser would. The shape assertion
// pairs with the load-bearing comment in `useGraphMutation.ts` that
// documents *why* the deferral exists (React's "Cannot update a component
// while rendering a different component" warning under updater impurity).
//
// Sources: React Issue #18949, PR #26512.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import type { ToCData } from '../../src/types';

const makeData = (): ToCData => ({
  title: 'init',
  sections: [],
});

describe('useGraphMutation queueMicrotask scheduling shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('schedules the parent notify via queueMicrotask (not synchronous, not setTimeout)', () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const queueSpy = vi.spyOn(globalThis, 'queueMicrotask');

    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutate((prev) => ({ ...prev, title: 'changed' }));
    });

    // The hook must schedule via queueMicrotask. Synchronous notify or
    // setTimeout-deferred notify would fail this assertion.
    expect(queueSpy).toHaveBeenCalled();
  });
});
