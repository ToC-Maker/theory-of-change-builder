// `useWaypointDrag` — pointer-events drag for connection waypoints.
//
// Sibling of `useConnectionDrag` (PR 5) and `usePointerDrag` (PR 4).
// Built on the same primitives: pointer capture, `isCanvasGestureActive`
// mutual exclusion, doc-level pointermove/up/cancel/keydown/second-pointer
// subscription, hook-unmount safety.
//
// ---------------------------------------------------------------------------
// Two gesture kinds
// ---------------------------------------------------------------------------
//
//   bindWaypoint(sourceId, targetId, waypointIndex)
//     Drag an existing waypoint. On pointerdown, captures the pointer
//     and records "moving waypoint K of connection (S→T)" intent. On
//     pointermove, writes the new position via `mutateDebounced` so the
//     UI sees a live preview but the parent isn't notified per move.
//     On pointerup:
//       - If the final position is within `MERGE_RADIUS_PX` of a
//         NEIGHBOR waypoint (waypoint[K-1] or waypoint[K+1]), the
//         dragged waypoint is REMOVED (collapses into the neighbor —
//         the cleanest UX: the neighbor stays put, the dragged one
//         disappears).
//       - Otherwise the move commits at the final coords.
//     A single `commit()` call fires on pointerup → one parent notify
//     → one undo entry.
//
//   bindMidpoint(sourceId, targetId, segmentIndex)
//     Drag a midpoint handle to CREATE a new waypoint. `segmentIndex`
//     is the segment between waypoints[segmentIndex-1] (or source if
//     -1==-1 sentinel) and waypoints[segmentIndex] (or target if
//     beyond array length). The hook inserts waypoints[segmentIndex] =
//     {x,y} at pointerdown, then treats the rest of the gesture as a
//     waypoint move on that index. On pointerup the same commit
//     semantics apply.
//
// ---------------------------------------------------------------------------
// Mutation model
// ---------------------------------------------------------------------------
//
// During the drag we use `mutateDebounced(updater, key)` so the UI
// updates synchronously without notifying the parent (no per-move
// onDataChange = no per-move undo entry). On pointerup we `commit(key)`
// once, producing exactly one parent notify and one undo entry.
//
// On Escape / pointercancel / second-pointer we do NOT commit. The
// `mutateDebounced` 200ms idle timer would auto-commit anyway, but
// callers using the cancel surface can choose to revert the buffer
// themselves if they want a "true cancel" UX. The current implementation
// matches the existing slider behavior: cancel just stops the drag; live
// preview state persists until the next coherent action.
//
// ---------------------------------------------------------------------------
// Coordinate translation
// ---------------------------------------------------------------------------
//
// Pointer events arrive as `clientX/clientY` (viewport coords).
// Waypoint positions are stored in container-local coords (same space
// as `node.yPosition`). The caller passes a `clientToContainer`
// translator so the hook doesn't have to know about camera/zoom math.
// Identity translator is fine for hosts without zoom.
//
// ---------------------------------------------------------------------------
// Mutual exclusion
// ---------------------------------------------------------------------------
//
// Red-team Important (plan/figma-redesign.md:203): waypoint drag and
// connection drag must mutually exclude. `pointerdown` checks
// `isCanvasGestureActive()` and short-circuits if true; on activation
// sets it true; on release / cancel clears it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { isCanvasGestureActive, setCanvasGestureActive } from './_canvasGestureState';
import type { ToCData, Connection } from '../types';

/** Maximum distance (px, container-local) for "drag onto neighbor → remove". */
const MERGE_RADIUS_PX = 16;

export type WaypointDragKind = 'move' | 'insert';

export interface WaypointDragState {
  kind: WaypointDragKind;
  sourceNodeId: string;
  targetNodeId: string;
  /**
   * Index of the waypoint being dragged. For `kind: 'insert'`, this
   * is the index the NEW waypoint will occupy in the post-insert array
   * (which equals the `segmentIndex` clamped to the array length at
   * gesture-start).
   */
  waypointIndex: number;
  /** Latest container-local position of the waypoint during the drag. */
  pos: { x: number; y: number };
  /**
   * Snapshot of the connection's `waypoints` taken at gesture-start.
   * Every updater REPLAYS the gesture intent (move or insert) on top
   * of this snapshot, so each call is fully idempotent — `mutateDebounced`'s
   * latest-wins semantics produce the same final result regardless of
   * how many intermediate updaters fired.
   */
  initialWaypoints: Array<{ x: number; y: number }>;
}

export interface UseWaypointDragArgs {
  data: ToCData;
  editMode: boolean;
  /**
   * One-shot mutator. Used at the end of an `insert` gesture to remove
   * a still-merged waypoint if the user releases without moving. Also
   * available to consumers that want a non-debounced write path.
   */
  mutate: (updater: ToCData | ((prev: ToCData) => ToCData)) => void;
  /**
   * Streaming mutator. Called on every pointermove during the drag so
   * the canvas re-renders without a parent notify. Same key is reused
   * across the gesture so latest-wins semantics produce one buffered
   * updater at commit time (one undo entry).
   */
  mutateDebounced: (updater: ToCData | ((prev: ToCData) => ToCData), key: string) => void;
  /** Flush the buffered updater under `key` → one parent notify. */
  commit: (key?: string) => void;
  /**
   * Translate viewport client coords to container-local coords. Pure;
   * the hook calls it on pointerdown and every pointermove.
   */
  clientToContainer: (clientX: number, clientY: number) => { x: number; y: number };
}

export interface UseWaypointDragResult {
  dragState: WaypointDragState | null;
  isActive: boolean;
  bindWaypoint: (
    sourceNodeId: string,
    targetNodeId: string,
    waypointIndex: number,
  ) => { onPointerDown: (e: ReactPointerEvent) => void };
  bindMidpoint: (
    sourceNodeId: string,
    targetNodeId: string,
    segmentIndex: number,
  ) => { onPointerDown: (e: ReactPointerEvent) => void };
}

function findConnection(
  data: ToCData,
  sourceNodeId: string,
  targetNodeId: string,
): Connection | undefined {
  for (const section of data.sections) {
    for (const column of section.columns) {
      for (const node of column.nodes) {
        if (node.id !== sourceNodeId) continue;
        const conns = node.connections;
        if (!conns) return undefined;
        return conns.find((c) => c.targetId === targetNodeId);
      }
    }
  }
  return undefined;
}

/**
 * Pure: produce a new ToCData where the connection (S→T) has its
 * `waypoints` field replaced by `updater(current)`. Preserves all
 * other state (immutable copy along the path). Returns the input
 * unchanged if the connection isn't found (defensive — stale-edge race).
 */
function updateConnectionWaypoints(
  data: ToCData,
  sourceNodeId: string,
  targetNodeId: string,
  updater: (current: Array<{ x: number; y: number }>) => Array<{ x: number; y: number }>,
): ToCData {
  let changed = false;
  const sections = data.sections.map((section) => ({
    ...section,
    columns: section.columns.map((column) => ({
      ...column,
      nodes: column.nodes.map((node) => {
        if (node.id !== sourceNodeId) return node;
        if (!node.connections) return node;
        const idx = node.connections.findIndex((c) => c.targetId === targetNodeId);
        if (idx < 0) return node;
        const conn = node.connections[idx];
        const current = conn.waypoints ?? [];
        const next = updater(current);
        // Skip allocation if no change (insert/move-by-zero edge).
        if (next === current) return node;
        changed = true;
        const newConn: Connection = { ...conn, waypoints: next };
        const newConns = node.connections.slice();
        newConns[idx] = newConn;
        return { ...node, connections: newConns };
      }),
    })),
  }));
  return changed ? { ...data, sections } : data;
}

export function useWaypointDrag(args: UseWaypointDragArgs): UseWaypointDragResult {
  // `mutate` is part of the documented API for parity with the other
  // gesture hooks, but the current implementation routes ALL writes
  // through `mutateDebounced` + `commit` (the streaming-mutation
  // pattern), so we don't read `mutate` here. Surfaced in `args` so
  // consumers can pass the full mutation triad without conditionals.
  const { data, editMode, mutateDebounced, commit, clientToContainer } = args;

  const [dragState, setDragStateInternal] = useState<WaypointDragState | null>(null);
  const dragStateRef = useRef<WaypointDragState | null>(null);
  const setDragState = useCallback(
    (
      next:
        | WaypointDragState
        | null
        | ((prev: WaypointDragState | null) => WaypointDragState | null),
    ) => {
      const updated =
        typeof next === 'function'
          ? (next as (p: WaypointDragState | null) => WaypointDragState | null)(
              dragStateRef.current,
            )
          : next;
      dragStateRef.current = updated;
      setDragStateInternal(updated);
    },
    [],
  );

  // Refs so document handlers see the latest values without
  // re-subscribing.
  const dataRef = useRef(data);
  dataRef.current = data;
  const mutateDebouncedRef = useRef(mutateDebounced);
  mutateDebouncedRef.current = mutateDebounced;
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const clientToContainerRef = useRef(clientToContainer);
  clientToContainerRef.current = clientToContainer;
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;

  // Pointer capture bookkeeping.
  const activePointerIdRef = useRef<number | null>(null);
  const captureElRef = useRef<HTMLElement | null>(null);

  // The mutateDebounced key for the in-flight gesture. One key per
  // gesture so commit() flushes the whole drag as ONE entry.
  const gestureKeyRef = useRef<string | null>(null);

  const buildKey = useCallback(
    (sourceId: string, targetId: string): string => `waypoints-${sourceId}->${targetId}`,
    [],
  );

  // Cleanup releases the pointer, clears the gesture flag, resets
  // state. Safe to call multiple times.
  const cleanup = useCallback(() => {
    const el = captureElRef.current;
    const pointerId = activePointerIdRef.current;
    if (el && pointerId != null) {
      try {
        if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(pointerId)) {
          el.releasePointerCapture(pointerId);
        } else if (typeof el.releasePointerCapture === 'function') {
          el.releasePointerCapture(pointerId);
        }
      } catch {
        // jsdom / detached element — non-fatal.
      }
    }
    captureElRef.current = null;
    activePointerIdRef.current = null;
    gestureKeyRef.current = null;
    setCanvasGestureActive(false);
    setDragState(null);
  }, [setDragState]);

  // Build a single, idempotent "replay" updater: takes the gesture's
  // snapshot and replays the gesture intent (move-to-pos OR insert-
  // at-index, with optional neighbor-merge) on top of it. Each emitted
  // updater is fully self-contained, so `mutateDebounced`'s latest-wins
  // semantics converge to the right end state regardless of intermediate
  // updaters' apply order.
  const buildReplayUpdater = useCallback(
    (
      state: WaypointDragState,
      pos: { x: number; y: number },
      // `true` when the gesture should also evaluate neighbor-merge
      // (pointerup only). pointermove never merges so intermediate
      // hover-near-neighbor doesn't visually remove the waypoint
      // before the user has committed to that intent.
      evaluateMerge: boolean,
    ): ((prev: ToCData) => ToCData) => {
      return (prev: ToCData) =>
        updateConnectionWaypoints(prev, state.sourceNodeId, state.targetNodeId, () => {
          // Start from the gesture's snapshot, replay intent.
          const base = state.initialWaypoints.slice();
          let working: Array<{ x: number; y: number }>;
          let activeIndex: number;
          if (state.kind === 'insert') {
            const clamped = Math.max(0, Math.min(state.waypointIndex, base.length));
            base.splice(clamped, 0, { x: pos.x, y: pos.y });
            working = base;
            activeIndex = clamped;
          } else {
            // move: replace the position at waypointIndex with `pos`.
            if (state.waypointIndex < 0 || state.waypointIndex >= base.length) {
              return base;
            }
            base[state.waypointIndex] = { x: pos.x, y: pos.y };
            working = base;
            activeIndex = state.waypointIndex;
          }

          if (!evaluateMerge) return working;

          // Neighbor-merge: drop the active waypoint if its position is
          // within MERGE_RADIUS_PX of an immediate neighbor (left or right).
          const neighbors: number[] = [];
          if (activeIndex - 1 >= 0) neighbors.push(activeIndex - 1);
          if (activeIndex + 1 < working.length) neighbors.push(activeIndex + 1);
          for (const nIdx of neighbors) {
            const nw = working[nIdx];
            const dx = pos.x - nw.x;
            const dy = pos.y - nw.y;
            if (Math.hypot(dx, dy) <= MERGE_RADIUS_PX) {
              working.splice(activeIndex, 1);
              break;
            }
          }
          return working;
        });
    },
    [],
  );

  // pointermove: write live preview via mutateDebounced.
  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      const state = dragStateRef.current;
      if (!state) return;
      const pos = clientToContainerRef.current(e.clientX, e.clientY);

      setDragState({ ...state, pos });

      const key = gestureKeyRef.current!;
      mutateDebouncedRef.current(buildReplayUpdater(state, pos, false), key);
    },
    [setDragState, buildReplayUpdater],
  );

  // pointerup: maybe merge with neighbor, then commit one entry.
  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      const state = dragStateRef.current;
      const key = gestureKeyRef.current;
      if (!state || !key) {
        cleanup();
        return;
      }
      const pos = clientToContainerRef.current(e.clientX, e.clientY);

      mutateDebouncedRef.current(buildReplayUpdater(state, pos, true), key);
      commitRef.current(key);
      cleanup();
    },
    [cleanup, buildReplayUpdater],
  );

  const handlePointerCancel = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      cleanup();
    },
    [cleanup],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup();
    },
    [cleanup],
  );

  const handleSecondPointer = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId === activePointerIdRef.current) return;
      cleanup();
    },
    [cleanup],
  );

  // Subscribe document listeners only while a drag is in flight.
  useEffect(() => {
    if (dragState == null) return;
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerCancel);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handleSecondPointer);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerCancel);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handleSecondPointer);
    };
  }, [
    dragState,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleKeyDown,
    handleSecondPointer,
  ]);

  // Hook-unmount safety: clear gesture flag if hook tears down mid-drag.
  useEffect(() => {
    return () => {
      if (isCanvasGestureActive() && dragStateRef.current !== null) {
        setCanvasGestureActive(false);
      }
    };
  }, []);

  // ----- bindWaypoint / bindMidpoint ----------------------------------

  const startMoveGesture = useCallback(
    (sourceNodeId: string, targetNodeId: string, waypointIndex: number, e: ReactPointerEvent) => {
      if (!editModeRef.current) return;
      if (isCanvasGestureActive()) return;
      if (e.button != null && e.button !== 0) return;

      // Snapshot the connection's current waypoints; the gesture
      // replays its intent on top of this snapshot in every updater.
      const conn = findConnection(dataRef.current, sourceNodeId, targetNodeId);
      if (!conn) return; // defensive: connection vanished between hover and pointerdown
      const initialWaypoints = (conn.waypoints ?? []).map((w) => ({ x: w.x, y: w.y }));
      if (waypointIndex < 0 || waypointIndex >= initialWaypoints.length) return;

      const target = e.target as HTMLElement | null;
      if (target) {
        try {
          if (typeof target.setPointerCapture === 'function') {
            target.setPointerCapture(e.pointerId);
            captureElRef.current = target;
          }
        } catch {
          // jsdom / detached — non-fatal.
        }
      }

      activePointerIdRef.current = e.pointerId;
      setCanvasGestureActive(true);
      gestureKeyRef.current = buildKey(sourceNodeId, targetNodeId);

      const pos = clientToContainerRef.current(e.clientX, e.clientY);
      setDragState({
        kind: 'move',
        sourceNodeId,
        targetNodeId,
        waypointIndex,
        pos,
        initialWaypoints,
      });

      e.stopPropagation();
    },
    [buildKey, setDragState],
  );

  const startInsertGesture = useCallback(
    (sourceNodeId: string, targetNodeId: string, segmentIndex: number, e: ReactPointerEvent) => {
      if (!editModeRef.current) return;
      if (isCanvasGestureActive()) return;
      if (e.button != null && e.button !== 0) return;

      const conn = findConnection(dataRef.current, sourceNodeId, targetNodeId);
      if (!conn) return; // defensive: connection vanished
      const initialWaypoints = (conn.waypoints ?? []).map((w) => ({ x: w.x, y: w.y }));

      const target = e.target as HTMLElement | null;
      if (target) {
        try {
          if (typeof target.setPointerCapture === 'function') {
            target.setPointerCapture(e.pointerId);
            captureElRef.current = target;
          }
        } catch {
          // jsdom / detached — non-fatal.
        }
      }

      activePointerIdRef.current = e.pointerId;
      setCanvasGestureActive(true);
      const key = buildKey(sourceNodeId, targetNodeId);
      gestureKeyRef.current = key;

      const pos = clientToContainerRef.current(e.clientX, e.clientY);
      const insertedIndex = Math.max(0, Math.min(segmentIndex, initialWaypoints.length));

      const state: WaypointDragState = {
        kind: 'insert',
        sourceNodeId,
        targetNodeId,
        waypointIndex: insertedIndex,
        pos,
        initialWaypoints,
      };
      setDragState(state);

      // Emit a first idempotent replay so the canvas shows the new
      // waypoint right away (without merge evaluation — merge logic
      // only fires on pointerup).
      mutateDebouncedRef.current(buildReplayUpdater(state, pos, false), key);

      e.stopPropagation();
    },
    [buildKey, buildReplayUpdater, setDragState],
  );

  const bindWaypointCache = useRef<Map<string, { onPointerDown: (e: ReactPointerEvent) => void }>>(
    new Map(),
  );
  const bindMidpointCache = useRef<Map<string, { onPointerDown: (e: ReactPointerEvent) => void }>>(
    new Map(),
  );

  const bindWaypoint = useCallback(
    (sourceNodeId: string, targetNodeId: string, waypointIndex: number) => {
      const key = `${sourceNodeId}->${targetNodeId}|${waypointIndex}`;
      const cached = bindWaypointCache.current.get(key);
      if (cached) return cached;
      const entry = {
        onPointerDown: (e: ReactPointerEvent) =>
          startMoveGesture(sourceNodeId, targetNodeId, waypointIndex, e),
      };
      bindWaypointCache.current.set(key, entry);
      return entry;
    },
    [startMoveGesture],
  );

  const bindMidpoint = useCallback(
    (sourceNodeId: string, targetNodeId: string, segmentIndex: number) => {
      const key = `${sourceNodeId}->${targetNodeId}|${segmentIndex}`;
      const cached = bindMidpointCache.current.get(key);
      if (cached) return cached;
      const entry = {
        onPointerDown: (e: ReactPointerEvent) =>
          startInsertGesture(sourceNodeId, targetNodeId, segmentIndex, e),
      };
      bindMidpointCache.current.set(key, entry);
      return entry;
    },
    [startInsertGesture],
  );

  return useMemo(
    () => ({
      dragState,
      isActive: dragState !== null,
      bindWaypoint,
      bindMidpoint,
    }),
    [dragState, bindWaypoint, bindMidpoint],
  );
}
