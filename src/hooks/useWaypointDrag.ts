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
//     (and must not leave a phantom preview in local state). Instead the
//     press may carry a per-press `onTap` handler, called when it is
//     released without ever arming (never after a drag, even one that
//     returned to the press point, and never after a cancel). The
//     midpoint circle unmounts on pointerdown and Chrome then delivers
//     no `click` for the press, so the hook reports the tap itself; the
//     caller uses it to open the connection editor.
//
//   bindWaypoint(sourceId, targetId, waypointIndex)
//     Drag the existing waypoint. Every write REPLACES the whole
//     `waypoints` array with `[draggedPos]`.
//
//     Whatever the array held before (several waypoints, or entries
//     that render as the automatic curve) is replaced by the one
//     dragged waypoint on the first actual drag. A sub-threshold click
//     is NOT an edit and leaves the stored array untouched.
//
//   bindWaypoint(...).onDoubleClick / resetWaypoints(sourceId, targetId)
//     Remove the waypoint(s) entirely — the connection returns to its
//     automatic curve. One commit → one undo entry. (The old
//     "drag onto a neighbor waypoint to merge" affordance died with
//     the multi-waypoint model; with a single waypoint there is no
//     neighbor, so reset needs its own affordance.) `resetWaypoints`
//     is exposed on the result so the EdgeEditor's "Reset path"
//     button (PR #34 round-7 issue 78) shares the exact same code
//     path as the dblclick reset.
//
//   bindPath(sourceId, targetId)  — PR #34 round-7 issue 78
//     Drag starting anywhere on the connection's fat hit-path. Enters
//     the SAME gesture flow as bindMidpoint/bindWaypoint (identical
//     threshold/cancel/undo semantics; the waypoint goes where the
//     cursor goes), superseding K7's "drag from a connection does
//     nothing" decision. Whether the connection already has a
//     waypoint is irrelevant to the write (it always REPLACES the
//     array with [cursorPos]); kind 'path' only affects the
//     pointerup validity check (connection-exists, like 'insert') and
//     the trailing-click suppression flag below.
//
//   consumePathGestureArmed()
//     One-shot signal for the fat path's click handler. Browsers fire
//     `click` after every down/up pair on the path (pointer capture
//     keeps the target stable through the drag), so the component
//     must distinguish "that gesture was a drag — suppress the
//     EdgeEditor" from "that was a click — open it". The positional
//     dead-zone the component already had (K7) cannot tell an
//     out-and-back drag from a click, so the hook records whether the
//     most recent path-initiated gesture armed; consuming clears it,
//     and the next path pointerdown resets it (cancel paths can set
//     the flag without any click ever firing).
//
// ---------------------------------------------------------------------------
// Mutation model
// ---------------------------------------------------------------------------
//
// During the drag we use `mutateDebounced` with `idleCommit: false` so the
// UI updates synchronously without committing, however long the pointer
// rests. On pointerup we `commit(key)` once, producing exactly one commit
// and one undo entry.
//
// **Invariant: one gesture = one undo entry.** All writes during a drag
// must go through `mutateDebounced` with the same `key`; the final
// `commit(key)` is what makes the bend visible to undo/redo.
//
// **Invariant: sub-threshold gestures write nothing.** The first write
// only happens once the pointer has moved ≥ DRAG_THRESHOLD_PX from the
// press point. This keeps plain clicks (including the two clicks of a
// double-click) from committing collapse/no-op edits or leaving
// uncommitted preview state behind.
//
// A chart landing from the server or an AI reply mid-drag merges into the
// store, and the bend preview wins on the bend itself. Every write names the
// connection by its node ids and replaces its `waypoints`, so it applies to
// whatever chart the store holds at that move.
//
// On Escape / pointercancel / second-pointer we DO NOT commit. The connection
// goes back to the waypoints the store has committed (which include a change to
// its bend that landed during the drag): the preview is overwritten through
// `mutateDebounced`, and then `discardBuffered(key)` drops that buffered key so
// a later `commit()` cannot turn the cancel into a save. No commit and no undo
// entry land, and a later unrelated edit saves the connection as it was.
//
// The one way the preview can be committed anyway is another commit during the
// drag (another key's idle timer, a keyboard edit, an AI edit or an undo, each of
// which commits the store's whole preview layer). `notifyCount` tells the cancel
// whether that happened since the drag armed; if so the committed state holds
// the preview, so the cancel restores the waypoints the press found and commits
// them. That is an ordinary edit: it adds an undo step.
//
// ---------------------------------------------------------------------------
// Coordinate translation
// ---------------------------------------------------------------------------
//
// Pointer events arrive as `clientX/clientY` (viewport coords). The
// caller passes a `clientToContainer` translator (container-local px,
// zoom factored out) so the hook doesn't have to know about camera/zoom
// math. Identity translator is fine for hosts without zoom. The drag
// threshold is measured in CLIENT pixels so it tracks finger/mouse
// travel rather than zoom-scaled chart distance.
//
// Waypoints are STORED as offsets from the midpoint of the straight
// line between the connection's anchors (see `connectionGeometry.ts`),
// so the hook subtracts that midpoint from the container-local pointer
// position. The caller supplies it via `getLineMidpoint`, which the hook
// reads on every move: a landing can move a node or change a column
// mid-drag, and `null` means an end node is gone.
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
import { offsetFromMidpoint } from '../utils/connectionGeometry';
import type { ToCData, Connection, WaypointOffset } from '../types';

/**
 * Minimum pointer travel (client px) before a press becomes a drag.
 *
 * Below this, pointerup is treated as a click: nothing is written, no
 * commit, no undo entry. 3px is the conventional dead-zone — small
 * enough that intentional drags arm on the first meaningful move,
 * large enough that the micro-jitter of a click (or of the two clicks
 * in a double-click) never mutates the chart. This matters doubly for
 * connections carrying several waypoints, where an armed drag COLLAPSES
 * them to one: a plain click must not be destructive.
 */
const DRAG_THRESHOLD_PX = 3;

/**
 * 'move'   — drag of an existing waypoint handle.
 * 'insert' — drag of the at-rest midpoint affordance.
 * 'path'   — drag starting on the connection's fat hit-path (round-7
 *            issue 78). Write/undo semantics are identical to
 *            'insert'; the distinct kind exists for the pointerup
 *            validity check (no waypoint-index requirement) and for
 *            the trailing-click suppression flag.
 */
export type WaypointDragKind = 'move' | 'insert' | 'path';

export interface WaypointDragState {
  kind: WaypointDragKind;
  sourceNodeId: string;
  targetNodeId: string;
  /**
   * For `kind: 'move'`, the index of the waypoint being dragged (only
   * checked when the press lands; the write itself always collapses to a
   * single waypoint). For `kind: 'insert'` / `'path'`, 0.
   */
  waypointIndex: number;
}

export interface UseWaypointDragArgs {
  data: ToCData;
  editMode: boolean;
  /**
   * Streaming mutator. Called on every pointermove during the drag so
   * the canvas re-renders without a commit. Same key is reused across the
   * gesture, so the one `commit(key)` at the end is one undo entry.
   */
  mutateDebounced: (
    updater: ToCData | ((prev: ToCData) => ToCData),
    key: string,
    options?: { idleCommit?: boolean },
  ) => void;
  /** Commit the preview under `key` → one commit. */
  commit: (key?: string) => void;
  /**
   * Forget `key` WITHOUT committing. Called on Escape / pointercancel /
   * second-pointer right after the preview is written back, so the
   * written-back state is not saved as an edit.
   */
  discardBuffered: (key: string) => void;
  /** Store commits so far; see "Mutation model". */
  notifyCount: () => number;
  /** The committed chart, which a cancel restores the connection's bend from. */
  getCommitted: () => ToCData;
  /**
   * Translate viewport client coords to container-local coords. Pure;
   * the hook calls it on every armed pointermove.
   */
  clientToContainer: (clientX: number, clientY: number) => { x: number; y: number };
  /**
   * Midpoint of the straight line between the connection's source and
   * target anchors, in the same container-local space as
   * `clientToContainer`; null when either end node is no longer on the
   * canvas.
   */
  getLineMidpoint: (sourceNodeId: string, targetNodeId: string) => { x: number; y: number } | null;
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
  ) => { onPointerDown: (e: ReactPointerEvent, onTap?: () => void) => void };
  /** Round-7 issue 78: drag starting anywhere on the fat hit-path. */
  bindPath: (
    sourceNodeId: string,
    targetNodeId: string,
  ) => { onPointerDown: (e: ReactPointerEvent) => void };
  /**
   * One-shot: true iff the most recent path-initiated gesture armed
   * (crossed the drag threshold). Consumed by the fat path's click
   * handler to suppress the EdgeEditor after a drag. Reading clears
   * the flag.
   */
  consumePathGestureArmed: () => boolean;
  /**
   * Clear the connection's waypoints → automatic curve. Same code
   * path as `bindWaypoint(...).onDoubleClick`; also wired to the
   * EdgeEditor's "Reset path" button (round-7 issue 78), which calls
   * it without an event. One commit → one undo entry.
   */
  resetWaypoints: (sourceNodeId: string, targetNodeId: string, e?: ReactMouseEvent) => void;
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
 * Pure: produce a new ToCData where the connection (S→T) is replaced by
 * `update(connection)`. Preserves all other state (immutable copy along
 * the path). Returns the input unchanged if the connection isn't found
 * (defensive — stale-edge race) or `update` returns the connection as is.
 */
function updateConnection(
  data: ToCData,
  sourceNodeId: string,
  targetNodeId: string,
  update: (conn: Connection) => Connection,
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
        const newConn = update(conn);
        // Skip allocation if no change (insert/move-by-zero edge).
        if (newConn === conn) return node;
        changed = true;
        const newConns = node.connections.slice();
        newConns[idx] = newConn;
        return { ...node, connections: newConns };
      }),
    })),
  }));
  return changed ? { ...data, sections } : data;
}

function updateConnectionWaypoints(
  data: ToCData,
  sourceNodeId: string,
  targetNodeId: string,
  updater: (current: WaypointOffset[]) => WaypointOffset[],
): ToCData {
  return updateConnection(data, sourceNodeId, targetNodeId, (conn) => {
    const current = conn.waypoints ?? [];
    const next = updater(current);
    return next === current ? conn : { ...conn, waypoints: next };
  });
}

/** Put back the connection's `waypoints` field exactly (absent when it had none). */
function restoreConnectionWaypoints(
  data: ToCData,
  sourceNodeId: string,
  targetNodeId: string,
  original: WaypointOffset[] | undefined,
): ToCData {
  return updateConnection(data, sourceNodeId, targetNodeId, (conn) => {
    const restored = { ...conn };
    if (original === undefined) delete restored.waypoints;
    else restored.waypoints = original;
    return restored;
  });
}

export function useWaypointDrag(args: UseWaypointDragArgs): UseWaypointDragResult {
  const {
    data,
    editMode,
    mutateDebounced,
    commit,
    discardBuffered,
    notifyCount,
    getCommitted,
    clientToContainer,
    getLineMidpoint,
  } = args;

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
  const notifyCountRef = useRef(notifyCount);
  notifyCountRef.current = notifyCount;
  const getCommittedRef = useRef(getCommitted);
  getCommittedRef.current = getCommitted;
  const clientToContainerRef = useRef(clientToContainer);
  clientToContainerRef.current = clientToContainer;
  const getLineMidpointRef = useRef(getLineMidpoint);
  getLineMidpointRef.current = getLineMidpoint;
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;

  // Pointer capture bookkeeping.
  const activePointerIdRef = useRef<number | null>(null);
  const captureElRef = useRef<HTMLElement | null>(null);

  // The mutateDebounced key for the in-flight gesture. One key per
  // gesture so commit() flushes the whole drag as ONE entry.
  const gestureKeyRef = useRef<string | null>(null);

  // The connection's `waypoints` as they were when the press landed, so a
  // cancel can put them back.
  const originalWaypointsRef = useRef<WaypointOffset[] | undefined>(undefined);

  // Drag-threshold bookkeeping: where the press landed (client coords)
  // and whether the gesture has crossed DRAG_THRESHOLD_PX. Until armed,
  // NOTHING is written — see "sub-threshold gestures write nothing".
  const gestureStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const gestureArmedRef = useRef(false);
  // The store's commit count when the gesture armed: if it has moved by
  // cancel time, something else committed the preview.
  const notifyCountAtArmRef = useRef(0);

  // The press's `onTap` handler, called when it is released without
  // arming. Per press, so it always comes from the render the user
  // pressed in.
  const tapHandlerRef = useRef<(() => void) | undefined>(undefined);

  // Round-7 issue 78: sticky "the last path-initiated gesture was a
  // drag" flag, read (and cleared) by the fat path's click handler via
  // `consumePathGestureArmed`. Recorded in `cleanup` — which runs on
  // pointerup BEFORE the browser dispatches the trailing click — and
  // only for kind 'path' (handle gestures keep their own click
  // handling and must not poison the flag).
  const pathGestureArmedRef = useRef(false);

  const buildKey = useCallback(
    (sourceId: string, targetId: string): string => `waypoints-${sourceId}->${targetId}`,
    [],
  );

  // The exact handler references currently subscribed on `document`.
  // They are installed imperatively in `startGesture`, not from an
  // effect keyed on `dragState`: an effect only attaches after React
  // has flushed passive effects, so a pointerup dispatched in the same
  // task as the pointerdown (a trackpad tap) would go unheard and leave
  // the gesture active.
  const docListenersRef = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    cancel: (e: PointerEvent) => void;
    keydown: (e: KeyboardEvent) => void;
    down: (e: PointerEvent) => void;
  } | null>(null);

  const removeDocListeners = useCallback(() => {
    const l = docListenersRef.current;
    if (!l) return;
    document.removeEventListener('pointermove', l.move);
    document.removeEventListener('pointerup', l.up);
    document.removeEventListener('pointercancel', l.cancel);
    document.removeEventListener('keydown', l.keydown);
    document.removeEventListener('pointerdown', l.down);
    docListenersRef.current = null;
  }, []);

  // Cleanup unsubscribes the document listeners, releases the pointer,
  // clears the gesture flag, resets state. Safe to call multiple
  // times. `cancel=true` (Escape /
  // pointercancel / second-pointer) also discards the buffered
  // `mutateDebounced` updater so a later `commit()` cannot turn cancel
  // into a commit.
  const cleanup = useCallback(
    (cancel = false) => {
      removeDocListeners();
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
        if (key !== null) discardBufferedRef.current(key);
      }
      // Record the click-suppression flag BEFORE resetting the gesture
      // state. Cancel paths (Escape/pointercancel) record too: the
      // user's eventual release after a cancelled drag must not open
      // the editor either.
      if (dragStateRef.current?.kind === 'path') {
        pathGestureArmedRef.current = gestureArmedRef.current;
      }
      captureElRef.current = null;
      activePointerIdRef.current = null;
      gestureKeyRef.current = null;
      gestureStartClientRef.current = null;
      gestureArmedRef.current = false;
      setCanvasGestureActive(false);
      setDragState(null);
    },
    [removeDocListeners, setDragState],
  );

  // The single write shape of the gesture: REPLACE the connection's
  // waypoints with `[offset]`. Idempotent and self-contained, so
  // `mutateDebounced`'s latest-wins semantics converge to the right end
  // state regardless of intermediate updaters' apply order. This also
  // replaces whatever was stored before with the one dragged waypoint.
  const buildReplayUpdater = useCallback(
    (state: WaypointDragState, offset: WaypointOffset): ((prev: ToCData) => ToCData) => {
      return (prev: ToCData) =>
        updateConnectionWaypoints(prev, state.sourceNodeId, state.targetNodeId, () => [offset]);
    },
    [],
  );

  /**
   * Pointer position as an offset from the dragged connection's line midpoint,
   * which is read now: a landing may have moved its nodes since the press.
   * Null when an end node is gone.
   */
  const offsetAt = useCallback(
    (state: WaypointDragState, clientX: number, clientY: number): WaypointOffset | null => {
      const midpoint = getLineMidpointRef.current(state.sourceNodeId, state.targetNodeId);
      if (!midpoint) return null;
      return offsetFromMidpoint(clientToContainerRef.current(clientX, clientY), midpoint);
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
      notifyCountAtArmRef.current = notifyCountRef.current();
      return true;
    }
    return false;
  }, []);

  // pointermove: write live preview via mutateDebounced once armed.
  // Note: we don't mirror `pos` into dragState because nothing reads
  // it: the live position lives in the store's preview. Skipping the
  // setState here saves one render per pointermove tick.
  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      const state = dragStateRef.current;
      if (!state) return;
      if (!armIfPastThreshold(e.clientX, e.clientY)) return;

      // An end node is gone (a landing removed it): nothing to bend. The
      // release reports the stale drop.
      const offset = offsetAt(state, e.clientX, e.clientY);
      if (!offset) return;
      mutateDebouncedRef.current(buildReplayUpdater(state, offset), gestureKeyRef.current!, {
        idleCommit: false,
      });
    },
    [buildReplayUpdater, armIfPastThreshold, offsetAt],
  );

  // pointerup: commit one entry if the gesture armed; otherwise it was
  // a click — clean up without writing anything. If the connection
  // vanished mid-gesture (a collaborator's or AI edit landed) the replay
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
      // cleanup suffices: no commit, no undo entry, and the stored
      // waypoints stay as they were. The tap handler runs once the gesture
      // has ended, so it never observes a live one.
      if (!armIfPastThreshold(e.clientX, e.clientY)) {
        const onTap = tapHandlerRef.current;
        cleanup();
        onTap?.();
        return;
      }

      // The connection existing, with both end nodes on the canvas, is the
      // whole validity story. The press-time waypoint index is not checked
      // here: the first armed move already replaced the connection's waypoints
      // with the single dragged one, so a later waypoint of a legacy
      // multi-waypoint connection would always look gone and its drop would
      // never commit.
      const offset = offsetAt(state, e.clientX, e.clientY);
      if (!offset || !findConnection(dataRef.current, state.sourceNodeId, state.targetNodeId)) {
        loggingService.reportError({
          error_name: 'stale-waypoint-drop',
          error_message: `Waypoint drop on ${state.sourceNodeId}->${state.targetNodeId} hit stale state (connection or an end node vanished)`,
          request_metadata: {
            sourceNodeId: state.sourceNodeId,
            targetNodeId: state.targetNodeId,
            kind: state.kind,
            waypointIndex: state.waypointIndex,
          },
        });
        // Treat as cancel: no commit, forget the key so a later
        // `commit()` can't flush a stale shape.
        cleanup(true);
        return;
      }

      // Both calls are caller code: if either throws, the gesture must
      // still end, or the flag stays set and no later drag can start.
      try {
        mutateDebouncedRef.current(buildReplayUpdater(state, offset), key);
        commitRef.current(key);
      } finally {
        cleanup();
      }
    },
    [cleanup, buildReplayUpdater, armIfPastThreshold, offsetAt],
  );

  // Escape / pointercancel / second pointer: undo what the preview wrote
  // and end the gesture without committing. A press that never crossed the
  // drag threshold wrote nothing, so there is nothing to put back. If another
  // commit has already carried the preview, the restored waypoints are
  // committed as well (see "Mutation model").
  const cancelGesture = useCallback(() => {
    const state = dragStateRef.current;
    const key = gestureKeyRef.current;
    try {
      if (state && key !== null && gestureArmedRef.current) {
        const carried = notifyCountRef.current() !== notifyCountAtArmRef.current;
        const original = carried
          ? originalWaypointsRef.current
          : findConnection(getCommittedRef.current(), state.sourceNodeId, state.targetNodeId)
              ?.waypoints;
        mutateDebouncedRef.current(
          (prev) =>
            restoreConnectionWaypoints(prev, state.sourceNodeId, state.targetNodeId, original),
          key,
        );
        if (carried) commitRef.current(key);
      }
    } finally {
      cleanup(true);
    }
  }, [cleanup]);

  const handlePointerCancel = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      cancelGesture();
    },
    [cancelGesture],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelGesture();
    },
    [cancelGesture],
  );

  const handleSecondPointer = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId === activePointerIdRef.current) return;
      cancelGesture();
    },
    [cancelGesture],
  );

  const installDocListeners = useCallback(() => {
    // Never double-subscribe (a no-op when nothing is installed).
    removeDocListeners();
    docListenersRef.current = {
      move: handlePointerMove,
      up: handlePointerUp,
      cancel: handlePointerCancel,
      keydown: handleKeyDown,
      down: handleSecondPointer,
    };
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerCancel);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handleSecondPointer);
  }, [
    removeDocListeners,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleKeyDown,
    handleSecondPointer,
  ]);

  // Hook-unmount safety: drop the document listeners and clear the
  // gesture flag if the hook tears down mid-drag.
  useEffect(() => {
    return () => {
      removeDocListeners();
      if (isCanvasGestureActive() && dragStateRef.current !== null) {
        setCanvasGestureActive(false);
      }
    };
  }, [removeDocListeners]);

  // ----- gesture starters ----------------------------------------------

  const startGesture = useCallback(
    (
      kind: WaypointDragKind,
      sourceNodeId: string,
      targetNodeId: string,
      waypointIndex: number,
      e: ReactPointerEvent,
      onTap?: () => void,
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
      tapHandlerRef.current = onTap;
      gestureKeyRef.current = buildKey(sourceNodeId, targetNodeId);
      originalWaypointsRef.current = conn.waypoints;
      gestureStartClientRef.current = { x: e.clientX, y: e.clientY };
      gestureArmedRef.current = false;
      // Subscribe NOW, synchronously — see `docListenersRef`.
      installDocListeners();

      setDragState({
        kind,
        sourceNodeId,
        targetNodeId,
        waypointIndex: kind === 'move' ? waypointIndex : 0,
      });

      e.stopPropagation();
    },
    [buildKey, setDragState, installDocListeners],
  );

  /**
   * Remove the waypoint(s) — the connection returns to its automatic
   * curve. Two callers share this seam (round-7 issue 78):
   *   - double-click on a waypoint handle (passes the mouse event so
   *     the dblclick doesn't bubble into canvas handlers); the two
   *     clicks that precede the dblclick are sub-threshold gestures
   *     and wrote nothing (see DRAG_THRESHOLD_PX);
   *   - the EdgeEditor's "Reset path" button (no event — button
   *     clicks live inside the portal, nothing to stop).
   * Either way: one mutateDebounced + one commit → one undo entry.
   */
  const resetWaypoints = useCallback(
    (sourceNodeId: string, targetNodeId: string, e?: ReactMouseEvent) => {
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
      e?.stopPropagation();
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
  const bindMidpointCache = useRef<
    Map<string, { onPointerDown: (e: ReactPointerEvent, onTap?: () => void) => void }>
  >(new Map());

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
        onPointerDown: (e: ReactPointerEvent, onTap?: () => void) =>
          startGesture('insert', sourceNodeId, targetNodeId, 0, e, onTap),
      };
      bindMidpointCache.current.set(key, entry);
      return entry;
    },
    [startGesture],
  );

  const bindPathCache = useRef<Map<string, { onPointerDown: (e: ReactPointerEvent) => void }>>(
    new Map(),
  );

  const bindPath = useCallback(
    (sourceNodeId: string, targetNodeId: string) => {
      const key = `${sourceNodeId}->${targetNodeId}`;
      const cached = bindPathCache.current.get(key);
      if (cached) return cached;
      const entry = {
        onPointerDown: (e: ReactPointerEvent) => {
          // Every new path press starts with a clean suppression flag:
          // a cancelled previous gesture may have set it without any
          // click ever firing (pointer released off-path), and a press
          // that never becomes a gesture (view mode, mutex held) must
          // leave the click handler in its positional-fallback mode.
          pathGestureArmedRef.current = false;
          startGesture('path', sourceNodeId, targetNodeId, 0, e);
        },
      };
      bindPathCache.current.set(key, entry);
      return entry;
    },
    [startGesture],
  );

  const consumePathGestureArmed = useCallback((): boolean => {
    const armed = pathGestureArmedRef.current;
    pathGestureArmedRef.current = false;
    return armed;
  }, []);

  return useMemo(
    () => ({
      dragState,
      isActive: dragState !== null,
      bindWaypoint,
      bindMidpoint,
      bindPath,
      consumePathGestureArmed,
      resetWaypoints,
    }),
    [dragState, bindWaypoint, bindMidpoint, bindPath, consumePathGestureArmed, resetWaypoints],
  );
}
