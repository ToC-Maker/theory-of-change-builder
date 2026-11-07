// The chart store outlives the canvas, so unmounting must not lose an edit: a
// queued `mutate` still commits, and a preview that was waiting for its idle
// timer is committed at once instead of by a timer that is gone.
import { StrictMode, useImperativeHandle } from 'react';
import type { Ref } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, render, act, cleanup } from '@testing-library/react';
import { useGraphMutation, type UseGraphMutationResult } from '../../src/hooks/useGraphMutation';
import type { ChartStore } from '../../src/sync/ChartDocument';
import type { ToCData } from '../../src/types';
import { makeDoc } from './helpers/renderToC';

const makeData = (): ToCData => ({
  title: 'init',
  sections: [],
});

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// `renderHook` alone does not run StrictMode's mount -> cleanup -> mount
// cycle, so the StrictMode case renders a real component.
function Harness({
  store,
  resultRef,
}: {
  store: ChartStore;
  resultRef: Ref<UseGraphMutationResult>;
}) {
  const api = useGraphMutation(store);
  useImperativeHandle(resultRef, () => api, [api]);
  return null;
}

describe('useGraphMutation.unmount', () => {
  it('still commits a queued mutate after unmount', async () => {
    const { doc, onCommit } = makeDoc(makeData());
    const { result, unmount } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutate((prev) => ({ ...prev, title: 'changed' }));
    });

    // Unmount before microtask drains.
    unmount();
    await flushMicrotasks();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(doc.getCommitted().title).toBe('changed');
  });

  it('does not warn (no setState after unmount)', async () => {
    const { doc } = makeDoc(makeData());
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result, unmount } = renderHook(() => useGraphMutation(doc));

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

  it('commits a buffered mutateDebounced at unmount, and its idle timer commits nothing later', () => {
    vi.useFakeTimers();
    const { doc, onCommit } = makeDoc(makeData());
    const { result, unmount } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced((prev) => ({ ...prev, title: 'pending' }), 'title');
    });
    expect(doc.getCommitted().title).toBe('init');
    unmount();

    expect(doc.getCommitted().title).toBe('pending');
    expect(onCommit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300); // past the 200ms idle window
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('still commits after a StrictMode mount-cleanup-remount cycle', async () => {
    // The cleanup of the simulated first mount must not leave the hook unable
    // to commit.
    const { doc, onCommit } = makeDoc(makeData());
    const ref: { current: UseGraphMutationResult | null } = { current: null };
    render(
      <StrictMode>
        <Harness store={doc} resultRef={ref} />
      </StrictMode>,
    );
    if (!ref.current) throw new Error('Harness did not expose hook result');

    act(() => {
      ref.current!.mutate((prev) => ({ ...prev, title: 'changed' }));
    });

    await flushMicrotasks();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]?.[0].title).toBe('changed');
  });
});
