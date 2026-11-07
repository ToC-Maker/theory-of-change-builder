// A keyboard arrow on an editor slider (node width, edge confidence)
// buffers through `mutateDebounced` and reaches the parent only when its
// 200 ms idle timer fires. Undo is allowed while such a control has focus, so an undo can
// arrive inside that window. The undo hands the graph an older chart; the
// buffered edit must not later report that chart back as a new edit, or
// the parent clears its redo stack and records an empty undo step.
//
// The parent below follows App's `handleDataChange`, `handleUndo` and
// `handleRedo` over the real `useUndoHistory`, and feeds `data` back to
// the graph's hook the way the graph's "absorb initialData" effect does.

import { useCallback, useEffect, useRef, useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import { useUndoHistory } from '../../src/hooks/useUndoHistory';
import type { ToCData } from '../../src/types';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const makeData = (): ToCData => ({ title: 'start', curvature: 0.5, sections: [] });
const clone = (d: ToCData): ToCData => JSON.parse(JSON.stringify(d));

function useParentAndGraph(initial: ToCData) {
  const history = useUndoHistory();
  const { undoHistory, redoHistory, setUndoHistory, setRedoHistory } = history;
  const [data, setParentData] = useState(initial);
  const dataRef = useRef(data);

  const handleDataChange = useCallback(
    (next: ToCData) => {
      history.saveToHistory(dataRef.current);
      setRedoHistory([]);
      dataRef.current = next;
      setParentData(next);
    },
    [history, setRedoHistory],
  );

  const handleUndo = () => {
    const stack = history.flushPendingHistory(undoHistory);
    if (stack.length === 0) return;
    const previous = stack[stack.length - 1];
    const current = clone(dataRef.current);
    setRedoHistory((prev) => [...prev, current]);
    setUndoHistory(stack.slice(0, -1));
    dataRef.current = previous;
    setParentData(previous);
  };

  const handleRedo = () => {
    const next = redoHistory[redoHistory.length - 1];
    if (!next) return;
    const current = clone(dataRef.current);
    setUndoHistory((prev) => [...prev, current]);
    setRedoHistory(redoHistory.slice(0, -1));
    dataRef.current = next;
    setParentData(next);
  };

  const graph = useGraphMutation(data, handleDataChange);
  const { setData } = graph;
  useEffect(() => {
    setData(data);
  }, [data, setData]);

  return { graph, parentData: data, undoHistory, redoHistory, handleUndo, handleRedo };
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

describe('undo shortly after an editor control change', () => {
  it('keeps the undone step on the redo stack and adds no empty undo step', async () => {
    const { result } = renderHook(() => useParentAndGraph(makeData()));

    // A committed edit: the step the user will undo.
    act(() => {
      result.current.graph.mutate((prev) => ({ ...prev, title: 'edited' }));
    });
    await advance(0);
    expect(result.current.parentData.title).toBe('edited');

    // A slider arrow: buffered, not yet reported.
    act(() => {
      result.current.graph.mutateDebounced((prev) => ({ ...prev, curvature: 0.6 }), 'curvature');
    });
    await advance(50);
    act(() => {
      result.current.handleUndo();
    });
    expect(result.current.parentData.title).toBe('start');

    await advance(1000);

    expect(result.current.redoHistory).toHaveLength(1);
    expect(result.current.undoHistory).toHaveLength(0);
    expect(result.current.graph.data.title).toBe('start');

    act(() => {
      result.current.handleRedo();
    });
    expect(result.current.parentData.title).toBe('edited');
    expect(result.current.graph.data.title).toBe('edited');
  });

  it('still saves a slider change made after the undo', async () => {
    const { result } = renderHook(() => useParentAndGraph(makeData()));

    act(() => {
      result.current.graph.mutate((prev) => ({ ...prev, title: 'edited' }));
    });
    await advance(0);
    act(() => {
      result.current.graph.mutateDebounced((prev) => ({ ...prev, curvature: 0.6 }), 'curvature');
    });
    act(() => {
      result.current.handleUndo();
    });
    act(() => {
      result.current.graph.mutateDebounced((prev) => ({ ...prev, curvature: 0.8 }), 'curvature');
    });
    await advance(1000);

    expect(result.current.parentData.title).toBe('start');
    expect(result.current.parentData.curvature).toBe(0.8);
  });
});
