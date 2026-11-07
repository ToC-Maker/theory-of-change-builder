// `useConnectionDrag` — pointer-events drag-to-connect gesture.
//
// Sibling of `usePointerDrag` (PR 4). Built on the same primitives:
// pointer capture, `isCanvasGestureActive()` mutual exclusion, doc-
// level pointermove/up/cancel/keydown/second-pointer subscription,
// hook-unmount safety. Plumbs into the same `setCanvasGestureActive`
// flag so PR 7's `useWaypointDrag` short-circuits when a connection
// drag is in flight.
//
// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
//
//   pointerdown on handle dot (left or right of node) →
//     - check editMode + `isCanvasGestureActive` guards
//     - capture pointer (keep receiving moves even if cursor leaves)
//     - set `isCanvasGestureActive(true)`
//     - subscribe document-level pointermove/up/cancel/keydown +
//       second-pointer pointerdown
//     - transition `dragState` from null to {sourceNodeId, sourceSide,
//       ghostPos, targetNodeId}
//
//   pointermove →
//     - update `ghostPos` to {clientX, clientY}
//     - hit-test the cursor against any DOM element carrying
//       `data-tocb-node="<nodeId>"` (the attribute NodeComponent
//       carries from PR 4). Resolve to `targetNodeId` if found and
//       different from `sourceNodeId`.
//
//   pointerup →
//     - if `targetNodeId` is set and the target node still exists in
//       `data` (stale-node guard, same rationale as `usePointerDrag`),
//       call `onConnect(sourceNodeId, targetNodeId)` exactly once.
//     - cleanup (release pointer capture, clear listeners, clear
//       `isCanvasGestureActive`, reset state).
//
//   pointercancel / Escape / second-pointer →
//     - cleanup, no onConnect.
//
//   hook unmount mid-drag →
//     - cleanup so the gesture flag doesn't leak.
//
// ---------------------------------------------------------------------------
// Why not share `usePointerDrag` directly
// ---------------------------------------------------------------------------
//
// The shapes are similar but not identical:
//   - `usePointerDrag` reads a layout snapshot (`classifyRegion`) on
//     every move to decide where the drop would land.
//   - `useConnectionDrag` reads the live DOM (a `document.elementFromPoint`
//     style lookup) for the target node id. No layout snapshot involved.
//   - Drop payload shape differs: pointer-drag returns a column / region;
//     connection-drag returns a single target node id.
//
// Extracting a shared "useGesture" base would amount to ~30 lines of
// pointer-capture boilerplate. The cost of duplication is low and the
// risk of premature abstraction is real (PR 7's waypoint drag will be
// the third user, by which point the right shape will be clearer).
// We opt for explicit duplication and re-revisit at PR 7.
//
// ---------------------------------------------------------------------------
// Coordinate translation
// ---------------------------------------------------------------------------
//
// `clientX/Y` is viewport coordinates. The connection-drag ghost block
// in `TheoryOfChangeGraph` (~line 1696, `data-testid="connection-drag-
// ghost"`) reads `dragState.ghostPos` and translates to container-local
// coords as `(clientX - containerRect.left) / zoomScale` — the same
// approach `usePointerDrag` consumers use for the drop-preview ghost.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { isCanvasGestureActive, setCanvasGestureActive } from './_canvasGestureState';
import type { ToCData } from '../types';
import { loggingService } from '../services/loggingService';
import { nodeExistsInData } from '../utils/findNode';

export type HandleSide = 'left' | 'right';

export interface ConnectionDragState {
  sourceNodeId: string;
  sourceSide: HandleSide;
  /** Current viewport coords; updated on every pointermove. */
  ghostPos: { x: number; y: number };
  /** The node under the cursor right now, if any (and not the source). */
  targetNodeId: string | null;
}

export interface UseConnectionDragArgs {
  /** Current graph data; consulted on drop for stale-node guard. */
  data: ToCData;
  /** When false, pointerdown is a no-op (read-only mode). */
  editMode: boolean;
  /**
   * Called on successful drop. Fires exactly once per gesture, with
   * the source and target node ids. Implementations should write
   * through `useGraphMutation.mutate` so the connection becomes a
   * single undo entry.
   */
  onConnect: (sourceNodeId: string, targetNodeId: string) => void;
}

/**
 * Returns the props to spread on a handle dot. The pointerdown handler
 * starts the gesture if no other canvas gesture is in flight; otherwise
 * it's a no-op. Shared signature consumed by `ConnectionHandles` and
 * `NodeComponent` so the three sites stay in lockstep (a type change
 * here cascades to consumers).
 */
export type BindConnectionHandle = (
  nodeId: string,
  side: HandleSide,
) => { onPointerDown: (e: ReactPointerEvent) => void };

export interface UseConnectionDragResult {
  dragState: ConnectionDragState | null;
  bindHandle: BindConnectionHandle;
  /** Convenience read of `dragState !== null` for the polling-pause guard. */
  isActive: boolean;
}

/**
 * Resolve the node id under the pointer by walking up from
 * `elementFromPoint` until we hit a `[data-tocb-node]` ancestor (the
 * attribute NodeComponent carries — see PR 4). Returns null if no node
 * is under the cursor or if the cursor is over the source node itself.
 */
function nodeIdUnderPoint(clientX: number, clientY: number, sourceNodeId: string): string | null {
  const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
  if (!el) return null;
  // Walk up to find a `[data-tocb-node]` ancestor.
  let cursor: HTMLElement | null = el;
  while (cursor) {
    const id = cursor.dataset?.tocbNode;
    if (id) {
      return id === sourceNodeId ? null : id;
    }
    cursor = cursor.parentElement;
  }
  return null;
}

export function useConnectionDrag(args: UseConnectionDragArgs): UseConnectionDragResult {
  const { data, editMode, onConnect } = args;

  const [dragState, setDragStateInternal] = useState<ConnectionDragState | null>(null);

  // Ref mirror so document handlers can read latest synchronously.
  const dragStateRef = useRef<ConnectionDragState | null>(null);
  const setDragState = useCallback(
    (
      next:
        | ConnectionDragState
        | null
        | ((prev: ConnectionDragState | null) => ConnectionDragState | null),
    ) => {
      if (typeof next === 'function') {
        const fn = next as (prev: ConnectionDragState | null) => ConnectionDragState | null;
        const updated = fn(dragStateRef.current);
        dragStateRef.current = updated;
        setDragStateInternal(updated);
      } else {
        dragStateRef.current = next;
        setDragStateInternal(next);
      }
    },
    [],
  );

  // Latest-data ref so stale-node guard at pointerup sees freshest snapshot.
  const dataRef = useRef(data);
  dataRef.current = data;

  // Latest-onConnect ref so document handlers (installed once) don't
  // need re-installation on every prop change.
  const onConnectRef = useRef(onConnect);
  onConnectRef.current = onConnect;

  // Captured pointer state.
  const activePointerIdRef = useRef<number | null>(null);
  const captureElRef = useRef<HTMLElement | null>(null);

  // The exact handler references currently subscribed on `document`.
  // They are installed imperatively in `startDrag`, not from an effect
  // keyed on `dragState`: an effect only attaches after React has
  // flushed passive effects, so a pointerup dispatched in the same task
  // as the pointerdown (a trackpad tap) would go unheard and leave the
  // gesture active, handing the next drag a stale source.
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

  // Cleanup: unsubscribe document listeners, release capture, clear
  // flag, reset state. Safe to call multiple times.
  const cleanup = useCallback(() => {
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
        // jsdom or detached element — non-fatal.
      }
    }
    captureElRef.current = null;
    activePointerIdRef.current = null;
    setCanvasGestureActive(false);
    setDragState(null);
  }, [removeDocListeners, setDragState]);

  // pointermove — update ghostPos, hit-test for target node.
  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      setDragState((prev) => {
        if (!prev) return prev;
        const targetNodeId = nodeIdUnderPoint(e.clientX, e.clientY, prev.sourceNodeId);
        return {
          ...prev,
          ghostPos: { x: e.clientX, y: e.clientY },
          targetNodeId,
        };
      });
    },
    [setDragState],
  );

  // pointerup — fire onConnect if target is valid, then cleanup.
  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      const state = dragStateRef.current;
      // `onConnect` is caller code: if it throws, the gesture must still
      // end, or the flag stays set and no later drag can start.
      try {
        if (state) {
          const targetId = nodeIdUnderPoint(e.clientX, e.clientY, state.sourceNodeId);
          if (targetId) {
            // Stale-node guard: same rationale as `usePointerDrag`. If
            // the source or target was deleted (cross-tab race) between
            // pointerdown and pointerup, log and abort.
            if (!nodeExistsInData(dataRef.current, state.sourceNodeId)) {
              loggingService.reportError({
                error_name: 'stale-connection-source',
                error_message: `Connection source ${state.sourceNodeId} no longer exists`,
                request_metadata: { sourceNodeId: state.sourceNodeId, targetNodeId: targetId },
              });
            } else if (!nodeExistsInData(dataRef.current, targetId)) {
              loggingService.reportError({
                error_name: 'stale-connection-target',
                error_message: `Connection target ${targetId} no longer exists`,
                request_metadata: { sourceNodeId: state.sourceNodeId, targetNodeId: targetId },
              });
            } else {
              onConnectRef.current(state.sourceNodeId, targetId);
            }
          }
        }
      } finally {
        cleanup();
      }
    },
    [cleanup],
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
      if (e.key === 'Escape') {
        cleanup();
      }
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

  // Latest editMode ref so the per-id handler reads it at call time
  // instead of closing over a render-time value.
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;

  // Per-(id,side) handler cache. Keys are `${nodeId}|${side}`.
  const bindCacheRef = useRef<Map<string, { onPointerDown: (e: ReactPointerEvent) => void }>>(
    new Map(),
  );

  const startDrag = useCallback(
    (nodeId: string, side: HandleSide, e: ReactPointerEvent) => {
      if (!editModeRef.current) return;
      if (isCanvasGestureActive()) return;
      if (e.button != null && e.button !== 0) return;

      const target = e.target as HTMLElement | null;
      if (!target) return;

      try {
        if (typeof target.setPointerCapture === 'function') {
          target.setPointerCapture(e.pointerId);
          captureElRef.current = target;
        }
      } catch {
        // jsdom or detached element — non-fatal.
      }

      activePointerIdRef.current = e.pointerId;
      setCanvasGestureActive(true);
      // Subscribe NOW, synchronously — see `docListenersRef`.
      installDocListeners();

      setDragState({
        sourceNodeId: nodeId,
        sourceSide: side,
        ghostPos: { x: e.clientX, y: e.clientY },
        targetNodeId: null,
      });

      // Don't bubble pointerdown to the parent NodeComponent's drag
      // binder — that would race the two gestures for the same pointer.
      // (NodeComponent's onPointerDown is on the node root; the handle
      // dot sits inside the node root. Stop here.)
      e.stopPropagation();
    },
    [setDragState, installDocListeners],
  );

  const bindHandle = useCallback(
    (nodeId: string, side: HandleSide) => {
      const key = `${nodeId}|${side}`;
      const cached = bindCacheRef.current.get(key);
      if (cached) return cached;
      const entry = {
        onPointerDown: (e: ReactPointerEvent) => startDrag(nodeId, side, e),
      };
      bindCacheRef.current.set(key, entry);
      return entry;
    },
    [startDrag],
  );

  return useMemo(
    () => ({
      dragState,
      bindHandle,
      isActive: dragState !== null,
    }),
    [dragState, bindHandle],
  );
}
