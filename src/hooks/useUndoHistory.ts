import { useCallback, useEffect, useRef, useState } from 'react';
import type { ToCData } from '../types';

// Changes closer together than this share one undo step.
const GROUPING_WINDOW_MS = 300;

/**
 * Undo and redo stacks of whole-chart snapshots.
 *
 * `saveToHistory(before)` is called with the chart as it was before each
 * change. Rapid changes (a slider drag, typing, a double click) are
 * folded into one step by holding the snapshot back until the window
 * has been quiet, so it must be the one taken before the first change.
 */
export function useUndoHistory() {
  const [undoHistory, setUndoHistory] = useState<ToCData[]>([]);
  const [redoHistory, setRedoHistory] = useState<ToCData[]>([]);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The snapshot waiting out the window. Undo and redo flush it into
  // the history instead of dropping it, so an undo right after an edit
  // still undoes that edit.
  const pendingRef = useRef<ToCData | null>(null);

  const saveToHistory = useCallback((before: ToCData) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    // A later change in the window keeps the snapshot of the first.
    const snapshot = (pendingRef.current ??= JSON.parse(JSON.stringify(before)) as ToCData);

    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      pendingRef.current = null;
      setUndoHistory((prev) => [...prev, snapshot]);
    }, GROUPING_WINDOW_MS);
  }, []);

  // Returns the history undo/redo should operate on, with a pending
  // snapshot appended.
  const flushPendingHistory = useCallback((history: ToCData[]): ToCData[] => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (pendingRef.current) {
      const flushed = [...history, pendingRef.current];
      pendingRef.current = null;
      return flushed;
    }
    return history;
  }, []);

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  return {
    undoHistory,
    setUndoHistory,
    redoHistory,
    setRedoHistory,
    saveToHistory,
    flushPendingHistory,
  };
}
