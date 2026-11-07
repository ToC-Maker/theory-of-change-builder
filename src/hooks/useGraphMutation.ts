// `useGraphMutation` — the canvas's mutation seam over the chart store.
//
// The canvas keeps no copy of the chart. It renders the store's live chart
// (committed plus the previews of typing and drags), writes every change as a
// preview, and asks the store to commit when a gesture is done. A remote chart
// landing in the store rebases the preview synchronously, so nothing typed or
// dragged can fall between two copies.
//
// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
//
//   mutate(updater)
//     One-shot, discrete mutation. Previews synchronously and queues a store
//     commit on a microtask; consecutive `mutate()` calls in the same task share
//     that one commit, so they make one undo step.
//
//   mutateDebounced(updater, key, options?)
//     Streaming-input mutation (slider drags, title typing). Previews
//     synchronously and marks `key` as holding an uncommitted preview. A 200 ms
//     idle timer per key commits it if `commit()` is not called first; a caller
//     whose gesture always ends in `commit(key)` or `discardBuffered(key)`
//     passes `{ idleCommit: false }`, so pausing mid-gesture commits nothing.
//
//   commit(key?)
//     Commits the preview of `key`, or of every key. A key with nothing marked
//     (never written, or already committed by its idle timer) is skipped:
//     closing an editor that changed nothing must not look like an edit.
//
//   discardBuffered(key)
//     Forgets `key` and its idle timer without committing. The preview stays in
//     the store, so a caller cancelling a gesture writes the old value back
//     first, then discards: the cancel leaves nothing to save.
//
//   notifyCount()
//     The store's commit count. A gesture holding a preview compares it at its
//     start and its end to learn whether another commit carried the preview.
//
// The store has one preview layer, so a commit promotes every key's preview,
// not only the committed key's.
//
// ---------------------------------------------------------------------------
// Why commits go through queueMicrotask
// ---------------------------------------------------------------------------
//
// A commit notifies every subscriber (App re-renders). Deferring it to a
// microtask lets the writes of one event handler coalesce into a single commit,
// and keeps the notification out of any React updater or render that calls
// `mutate` (React warns "Cannot update a component while rendering a different
// component"). The scheduling shape is pinned by
// `useGraphMutation.queueMicrotask-scheduling-shape.test.ts`.
//
// Unmounting commits the marked keys at once: the store outlives the canvas, so
// the typed text must not wait for an idle timer that no longer exists.
//
// ---------------------------------------------------------------------------
// Key conventions for mutateDebounced
// ---------------------------------------------------------------------------
//
// Keys MUST be property-scoped (`'width-${nodeId}'`, `'title-${nodeId}'`,
// `'curvature'`, `'section-title-${sectionId}'`). Two properties sharing a key
// share one idle timer and one `commit(key)`, so a commit of that key reports
// them as one gesture.
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type { SetStateAction } from 'react';
import type { ChartStore } from '../sync/ChartDocument';
import type { ToCData } from '../types';

type GraphUpdater = SetStateAction<ToCData>;

// A brief pause in slider movement still commits without requiring the caller
// to wire a pointerup handler.
const DEBOUNCE_IDLE_MS = 200;

export interface UseGraphMutationResult {
  data: ToCData;
  mutate: (updater: GraphUpdater) => void;
  mutateDebounced: (updater: GraphUpdater, key: string, options?: { idleCommit?: boolean }) => void;
  commit: (key?: string) => void;
  /** How many times the store has committed so far. */
  notifyCount: () => number;
  discardBuffered: (key: string) => void;
}

export function useGraphMutation(store: ChartStore): UseGraphMutationResult {
  const data = useSyncExternalStore(store.subscribe, store.getLive);

  // Keys whose preview is in the store but not committed.
  const bufferedRef = useRef<Set<string>>(new Set());
  const idleTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // At most one commit microtask is queued at a time.
  const commitPendingRef = useRef(false);

  const scheduleCommit = useCallback(() => {
    if (commitPendingRef.current) return;
    commitPendingRef.current = true;
    queueMicrotask(() => {
      commitPendingRef.current = false;
      store.commit();
    });
  }, [store]);

  const clearIdleTimer = useCallback((key: string) => {
    const timer = idleTimersRef.current.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    idleTimersRef.current.delete(key);
  }, []);

  const mutate = useCallback(
    (updater: GraphUpdater) => {
      store.preview(updater);
      scheduleCommit();
    },
    [store, scheduleCommit],
  );

  const commitOne = useCallback(
    (key: string) => {
      if (!bufferedRef.current.has(key)) return;
      clearIdleTimer(key);
      bufferedRef.current.delete(key);
      scheduleCommit();
    },
    [clearIdleTimer, scheduleCommit],
  );

  const commit = useCallback(
    (key?: string) => {
      if (key !== undefined) {
        commitOne(key);
        return;
      }
      for (const k of Array.from(bufferedRef.current)) commitOne(k);
    },
    [commitOne],
  );

  const mutateDebounced = useCallback(
    (updater: GraphUpdater, key: string, options?: { idleCommit?: boolean }) => {
      store.preview(updater);
      bufferedRef.current.add(key);
      clearIdleTimer(key);
      if (options?.idleCommit === false) return;
      idleTimersRef.current.set(
        key,
        setTimeout(() => {
          idleTimersRef.current.delete(key);
          bufferedRef.current.delete(key);
          scheduleCommit();
        }, DEBOUNCE_IDLE_MS),
      );
    },
    [store, clearIdleTimer, scheduleCommit],
  );

  const discardBuffered = useCallback(
    (key: string) => {
      clearIdleTimer(key);
      bufferedRef.current.delete(key);
    },
    [clearIdleTimer],
  );

  const commitBufferedNow = useCallback(() => {
    for (const timer of idleTimersRef.current.values()) clearTimeout(timer);
    idleTimersRef.current.clear();
    if (bufferedRef.current.size === 0) return;
    bufferedRef.current.clear();
    store.commit();
  }, [store]);
  useEffect(() => commitBufferedNow, [commitBufferedNow]);

  return {
    data,
    mutate,
    mutateDebounced,
    commit,
    discardBuffered,
    notifyCount: store.getCommitCount,
  };
}
