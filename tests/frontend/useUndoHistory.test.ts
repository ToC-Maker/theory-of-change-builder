import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUndoHistory } from '../../src/hooks/useUndoHistory';
import type { ToCData } from '../../src/types';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const chart = (title: string): ToCData => ({ title, sections: [] });

describe('useUndoHistory', () => {
  it('records the chart as it was before a change once the window is quiet', () => {
    const { result } = renderHook(() => useUndoHistory());

    act(() => result.current.saveToHistory(chart('before')));
    expect(result.current.undoHistory).toEqual([]);

    act(() => vi.advanceTimersByTime(300));
    expect(result.current.undoHistory).toEqual([chart('before')]);
  });

  it('folds rapid changes into one step that restores the chart before the first', () => {
    const { result } = renderHook(() => useUndoHistory());

    act(() => result.current.saveToHistory(chart('start')));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.saveToHistory(chart('mid-1')));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.saveToHistory(chart('mid-2')));
    act(() => vi.advanceTimersByTime(300));

    expect(result.current.undoHistory).toEqual([chart('start')]);
  });

  it('keeps changes separated by more than the window as separate steps', () => {
    const { result } = renderHook(() => useUndoHistory());

    act(() => result.current.saveToHistory(chart('first')));
    act(() => vi.advanceTimersByTime(400));
    act(() => result.current.saveToHistory(chart('second')));
    act(() => vi.advanceTimersByTime(400));

    expect(result.current.undoHistory).toEqual([chart('first'), chart('second')]);
  });

  it('stores a copy, so later edits to the saved object do not change the step', () => {
    const { result } = renderHook(() => useUndoHistory());
    const live = chart('before');

    act(() => result.current.saveToHistory(live));
    live.title = 'edited in place';
    act(() => vi.advanceTimersByTime(300));

    expect(result.current.undoHistory).toEqual([chart('before')]);
  });

  it('flushes a snapshot still inside the window instead of dropping it', () => {
    const { result } = renderHook(() => useUndoHistory());
    const history = [chart('older')];

    act(() => result.current.saveToHistory(chart('start')));
    act(() => vi.advanceTimersByTime(100));
    act(() => result.current.saveToHistory(chart('mid')));

    let flushed: ToCData[] = [];
    act(() => {
      flushed = result.current.flushPendingHistory(history);
    });
    expect(flushed).toEqual([chart('older'), chart('start')]);

    // The flushed snapshot is not recorded a second time.
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.undoHistory).toEqual([]);
    expect(result.current.flushPendingHistory(history)).toBe(history);
  });

  it('records nothing after unmount', () => {
    const { result, unmount } = renderHook(() => useUndoHistory());

    act(() => result.current.saveToHistory(chart('before')));
    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});
