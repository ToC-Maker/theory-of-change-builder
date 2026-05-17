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
import { StrictMode, useImperativeHandle } from 'react';
import type { Ref } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, render, act, cleanup } from '@testing-library/react';
import { useGraphMutation, type UseGraphMutationResult } from '../../src/hooks/useGraphMutation';
import type { ToCData } from '../../src/types';

const makeData = (): ToCData => ({
  title: 'init',
  sections: [],
});

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  cleanup();
});

// Helper that bridges renderHook's "extract result" pattern with the
// full <render>+StrictMode lifecycle. StrictMode only double-invokes
// effects when the hook is wrapped in a real rendered component, so
// `renderHook` alone does not exercise the mount -> cleanup -> mount
// cycle that the StrictMode regression test needs.
function Harness({
  data,
  onDataChange,
  resultRef,
}: {
  data: ToCData;
  onDataChange?: (d: ToCData) => void;
  resultRef: Ref<UseGraphMutationResult>;
}) {
  const api = useGraphMutation(data, onDataChange);
  useImperativeHandle(resultRef, () => api, [api]);
  return null;
}

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

  it('does not invoke onDataChange for a buffered mutateDebounced after unmount', () => {
    // L7 acceptance for the outer 200ms debounce timer: unmounting before
    // the idle timer fires must not produce a parent notify, even after
    // the timer would have elapsed in real time.
    vi.useFakeTimers();
    try {
      const onDataChange = vi.fn<(d: ToCData) => void>();
      const { result, unmount } = renderHook(() => useGraphMutation(makeData(), onDataChange));

      act(() => {
        result.current.mutateDebounced((prev) => ({ ...prev, title: 'pending' }), 'title');
      });
      unmount();
      vi.advanceTimersByTime(300); // past the 200ms idle window
      expect(onDataChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still notifies the parent after a StrictMode mount-cleanup-remount cycle', async () => {
    // Regression for the dev-only bug where `isMountedRef.current` was
    // flipped to `false` in the cleanup effect but never set back to
    // `true` on the StrictMode remount, leaving the hook permanently
    // unable to invoke `onDataChange`.
    //
    // React 19's `<StrictMode>` triggers the simulated mount -> cleanup
    // -> mount cycle at component-render time (NOT in `renderHook`),
    // so the regression must be exercised via a full `<render>` of a
    // harness component wrapped in `<StrictMode>`.
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const ref: { current: UseGraphMutationResult | null } = { current: null };
    render(
      <StrictMode>
        <Harness data={makeData()} onDataChange={onDataChange} resultRef={ref} />
      </StrictMode>,
    );
    if (!ref.current) throw new Error('Harness did not expose hook result');

    act(() => {
      ref.current!.mutate((prev) => ({ ...prev, title: 'changed' }));
    });

    await flushMicrotasks();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(onDataChange.mock.calls[0]?.[0].title).toBe('changed');
  });
});
