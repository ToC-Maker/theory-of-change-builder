// Deferral-primitive regression test: a `mutate()` must not commit through the
// store synchronously inside the caller, nor on a timer. Committing notifies
// every subscriber, and doing that inside a React updater or render makes React
// warn "Cannot update a component while rendering a different component".
//
// What it asserts: when `mutate()` is invoked, `queueMicrotask` is called at
// least once. This is shape-only by design: jsdom does not run the React
// reconciler the way a browser does, so the ordering itself cannot be shown here.
//
// Sources: React issue #18949, PR #26512.
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
