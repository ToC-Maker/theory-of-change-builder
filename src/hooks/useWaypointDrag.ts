// `useWaypointDrag` — pointer-events drag for THE connection waypoint.
//
// Sibling of `useConnectionDrag` (PR 5) and `usePointerDrag` (PR 4).
// Built on the same primitives: pointer capture, `isCanvasGestureActive`
// mutual exclusion, doc-level pointermove/up/cancel/keydown/second-pointer
// subscription, hook-unmount safety.
//
// ---------------------------------------------------------------------------
// Single-waypoint model (PR #34 feedback 53)
// ---------------------------------------------------------------------------
//
// Each connection has AT MOST ONE user-editable waypoint. The reviewer
// on the original N-waypoint design: "I don't think we really need to
// be able to edit multiple waypoints (editing the midway point
// shouldn't create two extra midway points)." So:
//
//   bindMidpoint(sourceId, targetId, segmentIndex)
//     Drag the at-rest midpoint affordance to CREATE the waypoint.
//     `segmentIndex` is retained in the signature for caller symmetry
//     but the gesture always produces a single-element `waypoints`
//     array. Nothing is written until the pointer travels beyond
//     DRAG_THRESHOLD_PX — a plain click must not create a waypoint
//     (and must not leave a phantom preview in local state).
//
//   bindWaypoint(sourceId, targetId, waypointIndex)
//     Drag the existing waypoint. Every write REPLACES the whole
//     `waypoints` array with `[draggedPos]`.
//
//     Legacy-chart policy: charts saved by the earlier multi-waypoint
//     build may carry N > 1 waypoints. They keep RENDERING with all N
//     (see `computePathWithWaypoints`), and every legacy waypoint stays
//     visible/draggable — but the first actual drag collapses the
//     array to the single dragged waypoint. A sub-threshold click is
//     NOT an edit and leaves the legacy shape untouched.
//
//   bindWaypoint(...).onDoubleClick
//     Remove the waypoint(s) entirely — the connection returns to its
//     automatic curve. One commit → one undo entry. (The old
//     "drag onto a neighbor waypoint to merge" affordance died with
//     the multi-waypoint model; with a single waypoint there is no
//     neighbor, so reset needs its own affordance.)
//
// ---------------------------------------------------------------------------
// Mutation model
// ---------------------------------------------------------------------------
//
// During the drag we use `mutateDebounced(updater, key)` so the UI
// updates synchronously without notifying the parent. On pointerup we
// `commit(key)` once, producing exactly one parent notify and one undo
// entry.
//
// **Invariant: one gesture = one undo entry.** All writes during a drag
// must go through `mutateDebounced` with the same `key`; the final
// `commit(key)` is what makes the parent visible to undo/redo.
//
// **Invariant: sub-threshold gestures write nothing.** The first write
// only happens once the pointer has moved ≥ DRAG_THRESHOLD_PX from the
// press point. This keeps plain clicks (including the two clicks of a
// double-click) from committing collapse/no-op edits or leaving
// uncommitted preview state behind.
//
// On Escape / pointercancel / second-pointer we DO NOT commit; we also
// call `discardBuffered(key)` so the `mutateDebounced` 200ms idle timer
// can't fire an auto-commit and turn a cancel into a delayed commit.
// The synchronous `writeLocal` side effect of prior `mutateDebounced`
// calls remains in local state (matching the existing slider behavior),
// but no parent notify / undo entry lands.
//
// ---------------------------------------------------------------------------
// Coordinate translation
// ---------------------------------------------------------------------------
//
// Pointer events arrive as `clientX/clientY` (viewport coords).
// Waypoint positions are stored in container-local coords (same space
// as `node.yPosition`). The caller passes a `clientToContainer`
// translator so the hook doesn't have to know about camera/zoom math.
// Identity translator is fine for hosts without zoom. The drag
// threshold is measured in CLIENT pixels so it tracks finger/mouse
// travel rather than zoom-scaled chart distance.
//
// ---------------------------------------------------------------------------
// Mutual exclusion
// ---------------------------------------------------------------------------
//
// Red-team Important (plan/figma-redesign.md:203): waypoint drag and
// connection drag must mutually exclude. `pointerdown` checks
// `isCanvasGestureActive()` and short-circuits if true; on activation
// sets it true; on release / cancel clears it. `useZoomPan` reads the
// same flag in its mousedown handler so a waypoint drag can never be
// shadowed by a canvas pan (PR #34 feedback 50).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { isCanvasGestureActive, setCanvasGestureActive } from './_canvasGestureState';
import { loggingService } from '../services/loggingService';
import type { ToCData, Connection } from '../types';

/**
 * Minimum pointer travel (client px) before a press becomes a drag.
 *
 * Below this, pointerup is treated as a click: nothing is written, no
 * commit, no undo entry. 3px is the conventional dead-zone — small
 * enough that intentional drags arm on the first meaningful move,
 * large enough that the micro-jitter of a click (or of the two clicks
 * in a double-click) never mutates the chart. This matters doubly for
 * legacy multi-waypoint charts, where an armed drag COLLAPSES the
 * waypoints to one: a plain click must not be destructive.
 */
const DRAG_THRESHOLD_PX = 3;

export type WaypointDragKind = 'move' | 'insert';

export interface WaypointDragState {
  kind: WaypointDragKind;
  sourceNodeId: string;
  targetNodeId: string;
  /**
   * For `kind: 'move'`, the index of the waypoint being dragged (only
   * relevant for the stale-gesture validity check on pointerup; the
   * write itself always collapses to a single waypoint). For
   * `kind: 'insert'`, 0.
   */
  waypointIndex: number;
}

export interface UseWaypointDragArgs {
  data: ToCData;
  editMode: boolean;
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
   * Drop the buffered updater for `key` WITHOUT a parent notify. Used
   * on Escape / pointercancel / second-pointer to make cancel semantics
   * true: the buffered live-preview state stays in memory but no undo
   * entry lands when the 200ms idle timer fires.
   */
  discardBuffered?: (key: string) => void;
  /**
   * Translate viewport client coords to container-local coords. Pure;
   * the hook calls it on every armed pointermove.
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
  ) => {
    onPointerDown: (e: ReactPointerEvent) => void;
    onDoubleClick: (e: ReactMouseEvent) => void;
  };
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
  const { data, editMode, mutateDebounced, commit, discardBuffered, clientToContainer } = args;

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
  const discardBufferedRef = useRef(discardBuffered);
  discardBufferedRef.current = discardBuffered;
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

  // Drag-threshold bookkeeping: where the press landed (client coords)
  // and whether the gesture has crossed DRAG_THRESHOLD_PX. Until armed,
  // NOTHING is written — see "sub-threshold gestures write nothing".
  const gestureStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const gestureArmedRef = useRef(false);

  const buildKey = useCallback(
    (sourceId: string, targetId: string): string => `waypoints-${sourceId}->${targetId}`,
    [],
  );

  // Cleanup releases the pointer, clears the gesture flag, resets
  // state. Safe to call multiple times. `cancel=true` (Escape /
  // pointercancel / second-pointer) also discards the buffered
  // `mutateDebounced` updater so the 200ms idle timer cannot fire an
  // auto-commit that would turn cancel into a delayed commit.
  const cleanup = useCallback(
    (cancel = false) => {
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
      if (cancel) {
        const key = gestureKeyRef.current;
        if (key !== null) discardBufferedRef.current?.(key);
      }
      captureElRef.current = null;
      activePointerIdRef.current = null;
      gestureKeyRef.current = null;
      gestureStartClientRef.current = null;
      gestureArmedRef.current = false;
      setCanvasGestureActive(false);
      setDragState(null);
    },
    [setDragState],
  );

  // The single write shape of the gesture: REPLACE the connection's
  // waypoints with `[pos]`. Idempotent and self-contained, so
  // `mutateDebounced`'s latest-wins semantics converge to the right end
  // state regardless of intermediate updaters' apply order. This is
  // also what implements the legacy-chart collapse policy: an old
  // multi-waypoint array becomes the single dragged waypoint.
  const buildReplayUpdater = useCallback(
    (state: WaypointDragState, pos: { x: number; y: number }): ((prev: ToCData) => ToCData) => {
      return (prev: ToCData) =>
        updateConnectionWaypoints(prev, state.sourceNodeId, state.targetNodeId, () => [
          { x: pos.x, y: pos.y },
        ]);
    },
    [],
  );

  /**
   * Threshold gate. Returns true once the pointer has traveled ≥
   * DRAG_THRESHOLD_PX from the press point (and latches: a gesture
   * that armed stays armed even if the pointer returns to the press
   * point — releasing there is a legitimate "moved then changed my
   * mind a little" drop, not a click).
   */
  const armIfPastThreshold = useCallback((clientX: number, clientY: number): boolean => {
    if (gestureArmedRef.current) return true;
    const start = gestureStartClientRef.current;
    if (!start) return false;
    const dist = Math.hypot(clientX - start.x, clientY - start.y);
    if (dist >= DRAG_THRESHOLD_PX) {
      gestureArmedRef.current = true;
      return true;
    }
    return false;
  }, []);

  // pointermove: write live preview via mutateDebounced once armed.
  // Note: we don't mirror `pos` into dragState because nothing reads
  // it — the live position lives in `data` via writeLocal. Skipping
  // the setState here saves one render per pointermove tick.
  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      const state = dragStateRef.current;
      if (!state) return;
      if (!armIfPastThreshold(e.clientX, e.clientY)) return;
      const pos = clientToContainerRef.current(e.clientX, e.clientY);

      const key = gestureKeyRef.current!;
      mutateDebouncedRef.current(buildReplayUpdater(state, pos), key);
    },
    [buildReplayUpdater, armIfPastThreshold],
  );

  // pointerup: commit one entry if the gesture armed; otherwise it was
  // a click — clean up without writing anything. If the connection or
  // waypoint vanished mid-gesture (cross-tab AI/collab edit) the replay
  // updater no-ops gracefully; we log one `stale-waypoint-drop` per
  // drop (NOT per pointermove — logging from the pure updater would
  // flood under the same race). Mirrors PR 4 `stale-node-drop` and PR 5
  // `stale-connection-source/target` so log facets stay consistent.
  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      const state = dragStateRef.current;
      const key = gestureKeyRef.current;
      if (!state || !key) {
        cleanup();
        return;
      }

      // Sub-threshold press+release = click, not drag. Nothing was
      // written (pointermove gates on the same flag), so a plain
      // cleanup suffices: no commit, no undo entry, and a legacy
      // multi-waypoint chart keeps its shape.
      if (!armIfPastThreshold(e.clientX, e.clientY)) {
        cleanup();
        return;
      }

      const liveConn = findConnection(dataRef.current, state.sourceNodeId, state.targetNodeId);
      const waypointStillValid =
        !!liveConn &&
        (state.kind === 'insert' ||
          (state.waypointIndex >= 0 && state.waypointIndex < (liveConn.waypoints?.length ?? 0)));
      if (!waypointStillValid) {
        loggingService.reportError({
          error_name: 'stale-waypoint-drop',
          error_message: `Waypoint drop on ${state.sourceNodeId}->${state.targetNodeId} hit stale state (connection or waypoint vanished)`,
          request_metadata: {
            sourceNodeId: state.sourceNodeId,
            targetNodeId: state.targetNodeId,
            kind: state.kind,
            waypointIndex: state.waypointIndex,
          },
        });
        // Treat as cancel: no commit, drop the buffered updater so the
        // 200ms idle timer doesn't auto-commit a stale shape.
        cleanup(true);
        return;
      }

      const pos = clientToContainerRef.current(e.clientX, e.clientY);
      mutateDebouncedRef.current(buildReplayUpdater(state, pos), key);
      commitRef.current(key);
      cleanup();
    },
    [cleanup, buildReplayUpdater, armIfPastThreshold],
  );

  const handlePointerCancel = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      cleanup(true);
    },
    [cleanup],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') cleanup(true);
    },
    [cleanup],
  );

  const handleSecondPointer = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId === activePointerIdRef.current) return;
      cleanup(true);
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

  // ----- gesture starters ----------------------------------------------

  const startGesture = useCallback(
    (
      kind: WaypointDragKind,
      sourceNodeId: string,
      targetNodeId: string,
      waypointIndex: number,
      e: ReactPointerEvent,
    ) => {
      if (!editModeRef.current) return;
      if (isCanvasGestureActive()) return;
      if (e.button != null && e.button !== 0) return;

      const conn = findConnection(dataRef.current, sourceNodeId, targetNodeId);
      if (!conn) return; // defensive: connection vanished between hover and pointerdown
      if (kind === 'move') {
        const count = conn.waypoints?.length ?? 0;
        if (waypointIndex < 0 || waypointIndex >= count) return;
      }

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
      gestureStartClientRef.current = { x: e.clientX, y: e.clientY };
      gestureArmedRef.current = false;

      setDragState({
        kind,
        sourceNodeId,
        targetNodeId,
        waypointIndex: kind === 'move' ? waypointIndex : 0,
      });

      e.stopPropagation();
    },
    [buildKey, setDragState],
  );

  /**
   * Double-click on a waypoint handle: remove the waypoint(s) — the
   * connection returns to its automatic curve. The two clicks that
   * precede the dblclick are sub-threshold gestures and wrote nothing
   * (see DRAG_THRESHOLD_PX), so this is the only mutation: one
   * mutateDebounced + one commit → one undo entry.
   */
  const resetWaypoints = useCallback(
    (sourceNodeId: string, targetNodeId: string, e: ReactMouseEvent) => {
      if (!editModeRef.current) return;
      if (isCanvasGestureActive()) return;
      const conn = findConnection(dataRef.current, sourceNodeId, targetNodeId);
      if (!conn) return;
      if ((conn.waypoints?.length ?? 0) === 0) return;

      const key = buildKey(sourceNodeId, targetNodeId);
      mutateDebouncedRef.current(
        (prev: ToCData) => updateConnectionWaypoints(prev, sourceNodeId, targetNodeId, () => []),
        key,
      );
      commitRef.current(key);
      e.stopPropagation();
    },
    [buildKey],
  );

  const bindWaypointCache = useRef<
    Map<
      string,
      {
        onPointerDown: (e: ReactPointerEvent) => void;
        onDoubleClick: (e: ReactMouseEvent) => void;
      }
    >
  >(new Map());
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
          startGesture('move', sourceNodeId, targetNodeId, waypointIndex, e),
        onDoubleClick: (e: ReactMouseEvent) => resetWaypoints(sourceNodeId, targetNodeId, e),
      };
      bindWaypointCache.current.set(key, entry);
      return entry;
    },
    [startGesture, resetWaypoints],
  );

  const bindMidpoint = useCallback(
    (sourceNodeId: string, targetNodeId: string, segmentIndex: number) => {
      const key = `${sourceNodeId}->${targetNodeId}|${segmentIndex}`;
      const cached = bindMidpointCache.current.get(key);
      if (cached) return cached;
      const entry = {
        onPointerDown: (e: ReactPointerEvent) =>
          startGesture('insert', sourceNodeId, targetNodeId, 0, e),
      };
      bindMidpointCache.current.set(key, entry);
      return entry;
    },
    [startGesture],
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
