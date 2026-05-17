// `useGraphMutation` — the single mutation seam for ToC graph state.
//
// Replaces the ad-hoc `setDataAndNotify` pattern previously inlined in
// `TheoryOfChangeGraph.tsx:57-67`. Centralizes three concerns: live state,
// parent notification timing, and debounced/streaming-input semantics for
// gestures like slider drags.
//
// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
//
//   mutate(updater)
//     One-shot, discrete mutation. Updates local state synchronously
//     (live preview) and queues a parent `onDataChange` notification via
//     `queueMicrotask`. Multiple consecutive synchronous `mutate()` calls in
//     the same task collapse to ONE parent notification via a shared
//     `pendingNotifyRef` slot.
//
//   mutateDebounced(updater, key)
//     Streaming-input mutation (slider drags, color pickers, title typing).
//     Updates local state synchronously (so the UI feels responsive) but
//     does NOT notify the parent. Buffers the latest updater under `key` in
//     a hook-local Map. Same-key calls REPLACE the buffered updater (latest
//     wins). Cross-key calls are buffered independently. A 200ms idle timer
//     auto-commits each key if `commit()` is not called explicitly.
//
//   commit(key?)
//     Flush buffered keys. With a key, flushes just that key; without, all
//     keys in insertion order. The flush dispatches `onDataChange` via
//     `queueMicrotask` (same scheduling as `mutate`).
//
// ---------------------------------------------------------------------------
// Why queueMicrotask, not setTimeout(0)
// ---------------------------------------------------------------------------
//
// The ORIGINAL comment at `TheoryOfChangeGraph.tsx:61` said "to avoid
// infinite loops". That framing is imprecise. The actual failure class is
// React's runtime warning "Cannot update a component while rendering a
// different component", which fires when a parent's setState-triggering
// callback is invoked synchronously inside a child's `setState` updater
// (updater impurity).
//
// `queueMicrotask` preserves the ordering invariant that previously came
// from `setTimeout(0)` — "parent setter runs after child commit" — while
// being strictly better: pre-paint timing, no 4 ms macrotask clamp at
// nesting depth > 5, no timer-batching surprises, and it matches React
// 18.3+/19's own internal microtask scheduling.
//
// Sources:
//   - https://github.com/facebook/react/issues/18949 (the warning)
//   - https://github.com/facebook/react/pull/26512 (React's own
//     migration to microtask scheduling for updater-triggered effects)
//   - https://react.dev/reference/react/useState (updater purity)
//
// Do NOT replace `queueMicrotask` with `setTimeout` or with a synchronous
// notify. The deferral-primitive regression test in
// `tests/frontend/useGraphMutation.queueMicrotask-scheduling-shape.test.ts`
// asserts that `queueMicrotask` is called when `mutate()` runs; it catches
// the swap-to-synchronous failure mode.
//
// ---------------------------------------------------------------------------
// Key conventions for mutateDebounced (foot-gun warning)
// ---------------------------------------------------------------------------
//
// Keys MUST be property-scoped, not shared across distinct properties.
// Recommended pattern: `'width-${nodeId}'`, `'color-${nodeId}'`,
// `'title-${nodeId}'`, `'curvature'`, `'textSize'`, `'section-${idx}-title'`.
//
// Sharing a key across two different properties silently merges the
// notify CADENCE: subsequent calls REPLACE the buffered updater under
// that key, so a single per-key flush (timer or `commit('key')`) fires
// ONE `onDataChange`, not two. Both writes still land in the live state
// (writeLocal applied them synchronously), but the parent only learns
// about them once. If the parent uses the notify edge to trigger a
// distinct side effect per property (e.g. logging two undo entries),
// they'll be merged into one — silently dropping the earlier write's
// SIGNAL even though its effect is in state. The
// `mutateDebounced` test "emits a SINGLE parent notify when two same-key
// writes target different properties (foot-gun)" pins this for
// regression purposes; future contributors who introduce key sharing
// across properties should fail that test.
//
// ---------------------------------------------------------------------------
// Unmount safety (L7)
// ---------------------------------------------------------------------------
//
// `isMountedRef` guards both the queued microtask callback (so a deferred
// `onDataChange` after unmount becomes a no-op) and the outer 200 ms
// debounce timer (so a stale idle-commit never fires after unmount).
// Belt-and-suspenders fix from the Red-Team failure-modes pass. Under
// React's actual cleanup-before-unmount semantics the window is narrow
// but non-zero, especially with future Suspense / concurrent-mode work.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ToCData } from '../types';

type GraphUpdater = SetStateAction<ToCData>;

// 200 ms matches the "idle commit" expectation for streaming inputs: a
// brief pause in slider movement still commits without requiring the
// caller to wire a pointerup handler. Callers that already wire pointerup
// will see this timer be a no-op (commit() clears it).
const DEBOUNCE_IDLE_MS = 200;

export interface UseGraphMutationResult {
  data: ToCData;
  // External-replacement setter (no parent notify). Used by the parent's
  // "absorb new initialData prop" effect (AI-edit / external-state-replace
  // path). Routes through the same `dataRef.current` write that the
  // mutate paths use, so a subsequent `mutate(prev => ...)` derives from
  // the post-replacement state.
  setData: Dispatch<SetStateAction<ToCData>>;
  mutate: (updater: GraphUpdater) => void;
  mutateDebounced: (updater: GraphUpdater, key: string) => void;
  commit: (key?: string) => void;
}

const applyUpdater = (prev: ToCData, updater: GraphUpdater): ToCData =>
  typeof updater === 'function' ? (updater as (p: ToCData) => ToCData)(prev) : updater;

export function useGraphMutation(
  initialData: ToCData,
  onDataChange?: (data: ToCData) => void,
): UseGraphMutationResult {
  const [data, setData] = useState<ToCData>(initialData);

  // The latest data, kept in a ref so the deferred parent notify reads
  // post-commit state (not the closed-over version from the call site).
  const dataRef = useRef<ToCData>(initialData);

  // L7 guard: gates both the queued microtask callback and the outer
  // debounce timer. Flipped false in the cleanup effect at the end.
  const isMountedRef = useRef(true);

  // Stable callback ref so listeners and updaters always see the latest
  // `onDataChange` without forcing a re-subscription.
  const onDataChangeRef = useRef<typeof onDataChange>(onDataChange);
  useEffect(() => {
    onDataChangeRef.current = onDataChange;
  }, [onDataChange]);

  // Transactional-batch primitive: at most one microtask is queued at a
  // time. Consecutive synchronous `mutate()` calls in the same task
  // collapse to ONE parent notification carrying the latest `dataRef`.
  // Closes the `deleteSelectedNodes` two-call pattern that previously
  // produced two notifications (Red-Team Important).
  const pendingNotifyRef = useRef(false);

  // Buffered debounced updaters. Insertion-ordered (Map preserves order),
  // so `commit()` with no args flushes in the order keys were first added.
  // Latest-write-wins per key.
  const bufferedRef = useRef<Map<string, GraphUpdater>>(new Map());

  // Per-key idle timers. Set on `mutateDebounced`, cleared on the
  // corresponding `commit(key)` or by a subsequent `mutateDebounced` for
  // the same key.
  const idleTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Schedules a single coalesced microtask. Safe to call multiple times
  // in the same task: only the first call actually enqueues.
  const scheduleNotify = useCallback(() => {
    if (pendingNotifyRef.current) return;
    pendingNotifyRef.current = true;
    queueMicrotask(() => {
      pendingNotifyRef.current = false;
      if (!isMountedRef.current) return; // L7 guard
      onDataChangeRef.current?.(dataRef.current);
    });
  }, []);

  // Synchronous live state update; common to `mutate` and `mutateDebounced`.
  //
  // Computes the next value from `dataRef.current` (the latest-known state)
  // BEFORE calling setData, so consecutive synchronous calls in the same
  // task observe each other's writes. React's queued updater callback also
  // runs (so React's batching semantics are preserved), but it just
  // returns the already-computed `next` to avoid double-applying the
  // updater when StrictMode replays.
  const writeLocal = useCallback((updater: GraphUpdater): ToCData => {
    const next = applyUpdater(dataRef.current, updater);
    dataRef.current = next;
    setData(() => next);
    return next;
  }, []);

  // External setter exposed to callers (e.g. the parent's "absorb new
  // initialData prop" effect in `TheoryOfChangeGraph.tsx:219-224` for the
  // AI-edit / external-state-replace path). Routes through the same
  // `dataRef.current` write that `writeLocal` performs, so a subsequent
  // `mutate(prev => ...)` derives from the post-replacement state — not
  // the stale snapshot. Without this, an external replacement followed
  // by any user mutation silently wipes the replacement (AI edit lost).
  // Does NOT call `scheduleNotify`: the parent already owns the new
  // value (it triggered the replacement), so re-emitting it would loop.
  const setDataExternal = useCallback<Dispatch<SetStateAction<ToCData>>>((value) => {
    const next = applyUpdater(dataRef.current, value);
    dataRef.current = next;
    setData(() => next);
  }, []);

  const mutate = useCallback(
    (updater: GraphUpdater) => {
      writeLocal(updater);
      scheduleNotify();
    },
    [writeLocal, scheduleNotify],
  );

  // Commit a single key: drop it from the buffer, clear its idle timer,
  // and queue the coalesced parent notify. State has already been updated
  // by the preceding `mutateDebounced` calls (live preview), so this just
  // notifies the parent.
  const commitOne = useCallback(
    (key: string) => {
      const timer = idleTimersRef.current.get(key);
      if (timer !== undefined) {
        clearTimeout(timer);
        idleTimersRef.current.delete(key);
      }
      bufferedRef.current.delete(key);
      scheduleNotify();
    },
    [scheduleNotify],
  );

  const commit = useCallback(
    (key?: string) => {
      if (key !== undefined) {
        commitOne(key);
        return;
      }
      // Flush all in insertion order. We snapshot the keys to avoid
      // mutation-during-iteration foot-guns (commitOne mutates the map).
      const keys = Array.from(bufferedRef.current.keys());
      for (const k of keys) commitOne(k);
    },
    [commitOne],
  );

  const mutateDebounced = useCallback(
    (updater: GraphUpdater, key: string) => {
      // Live preview: state updates synchronously.
      writeLocal(updater);
      // Buffer for the eventual commit. Replaces any earlier updater
      // under the same key (latest-wins — see foot-gun note above).
      bufferedRef.current.set(key, updater);
      // Reset the per-key idle timer.
      const existing = idleTimersRef.current.get(key);
      if (existing !== undefined) clearTimeout(existing);
      const timer = setTimeout(() => {
        if (!isMountedRef.current) return; // L7 guard for the outer timer
        idleTimersRef.current.delete(key);
        bufferedRef.current.delete(key);
        scheduleNotify();
      }, DEBOUNCE_IDLE_MS);
      idleTimersRef.current.set(key, timer);
    },
    [writeLocal, scheduleNotify],
  );

  // Cleanup: flip isMountedRef and clear pending timers. Pending
  // microtask still fires (microtasks aren't cancellable), but is gated
  // by `isMountedRef.current`.
  //
  // The effect body re-arms `isMountedRef.current = true` on every
  // (re-)mount. Under React 19 `<StrictMode>` (active in dev via
  // `src/main.tsx:25`), every effect runs mount -> cleanup -> mount;
  // without the re-arm, the ref stays `false` after the first cycle and
  // every subsequent parent notify is silently dropped. The
  // `useGraphMutation.unmount.test.tsx` "still notifies after a
  // StrictMode mount-cleanup-remount cycle" case pins this.
  useEffect(() => {
    isMountedRef.current = true;
    // Capture refs into locals so the cleanup closure operates on the
    // same Map instances seen at mount time (react-hooks/exhaustive-deps).
    const idleTimers = idleTimersRef.current;
    const buffered = bufferedRef.current;
    return () => {
      isMountedRef.current = false;
      for (const t of idleTimers.values()) clearTimeout(t);
      idleTimers.clear();
      buffered.clear();
    };
  }, []);

  return {
    data,
    setData: setDataExternal,
    mutate,
    mutateDebounced,
    commit,
  };
}
