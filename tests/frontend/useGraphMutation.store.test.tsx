// `useGraphMutation` over the chart store: previews go to the store and commits
// are the store's commits.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import type { ToCData } from '../../src/types';
import { connectedChart, edit, findNode, nodeIn } from '../shared/chart-fixtures';
import { makeDoc } from './helpers/renderToC';

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const retitle = (id: string, title: string) => (chart: ToCData) =>
  edit(chart, (draft) => {
    nodeIn(draft, id).title = title;
  });

const titleOf = (chart: ToCData, id: string) => findNode(chart, id)?.title;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useGraphMutation over a store', () => {
  it('mutate_previews_then_commits_once_per_task', async () => {
    const { doc, onCommit } = makeDoc(connectedChart());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutate(retitle('a', 'One'));
      result.current.mutate(retitle('b', 'Two'));
    });

    expect(titleOf(result.current.data, 'b')).toBe('Two');
    expect(onCommit).not.toHaveBeenCalled();

    await flushMicrotasks();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(titleOf(onCommit.mock.calls[0][0], 'a')).toBe('One');
    expect(titleOf(onCommit.mock.calls[0][0], 'b')).toBe('Two');
  });

  it('mutateDebounced_commits_after_200ms_idle', async () => {
    vi.useFakeTimers();
    const { doc, onCommit } = makeDoc(connectedChart());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced(retitle('a', 'Typed'), 'title-a');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(onCommit).not.toHaveBeenCalled();
    expect(titleOf(doc.getLive(), 'a')).toBe('Typed');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(titleOf(doc.getCommitted(), 'a')).toBe('Typed');
  });

  it('idleCommit_false_commits_only_on_commit_key', async () => {
    vi.useFakeTimers();
    const { doc, onCommit } = makeDoc(connectedChart());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced(retitle('a', 'Held'), 'drag-a', { idleCommit: false });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      result.current.commit('drag-a');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(titleOf(doc.getCommitted(), 'a')).toBe('Held');
  });

  it('unmount_commits_buffered_keys_synchronously', () => {
    const { doc } = makeDoc(connectedChart());
    const { result, unmount } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced(retitle('a', 'Typed'), 'title-a');
    });
    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');

    unmount();

    expect(titleOf(doc.getCommitted(), 'a')).toBe('Typed');
    expect(doc.getCommitCount()).toBe(1);
  });

  it('notifyCount_tracks_store_commit_count', () => {
    const { doc } = makeDoc(connectedChart());
    const { result } = renderHook(() => useGraphMutation(doc));
    expect(result.current.notifyCount()).toBe(0);

    act(() => {
      doc.edit(retitle('a', 'From elsewhere'));
    });

    expect(result.current.notifyCount()).toBe(1);
  });
});
