// L7 acceptance: a pending mutate() must NOT fire `onDataChange` if the
// component unmounts before its queued microtask runs.
//
// `isMountedRef` guards both:
//   - the queued microtask callback (mutate / commit notify)
//   - the outer 200ms debounce timer (mutateDebounced idle commit, if
//     implemented)
//
// React Strict Mode and React's actual cleanup-before-unmount semantics
// reduce the practical window for this race, but the guard is the
// belt-and-suspenders fix from the Red-Team failure-modes pass.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import type { ToCData } from '../../src/types';

const makeData = (): ToCData => ({
  title: 'init',
  sections: [],
});

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe('useGraphMutation.unmount', () => {
  it('does not invoke onDataChange for a queued mutate after unmount', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result, unmount } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutate((prev) => ({ ...prev, title: 'changed' }));
    });

    // Unmount before microtask drains.
    unmount();

    await flushMicrotasks();

    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('does not warn (no setState after unmount)', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutate((prev) => ({ ...prev, title: 'changed' }));
    });
    unmount();
    await flushMicrotasks();

    // Should not see "Can't perform a React state update on an unmounted
    // component" or similar.
    const calls = consoleError.mock.calls.map((c) => String(c[0]));
    const warning = calls.find(
      (m) => m.includes('unmounted') || m.includes("Can't perform a React state update"),
    );
    expect(warning).toBeUndefined();
    consoleError.mockRestore();
  });
});
