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
// `clientX/Y` is viewport coordinates. Consumers (the ghost line
// renderer in `ConnectionsComponent`) translate to container-local
// using the same approach as `TheoryOfChangeGraph`'s drop-preview
// ghost: `(clientX - containerRect.left) / zoomScale`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react';
import { isCanvasGestureActive, setCanvasGestureActive } from './_canvasGestureState';
import type { ToCData } from '../types';
import { loggingService } from '../services/loggingService';

export type HandleSide = 'left' | 'right';

export interface ConnectionDragState {
  sourceNodeId: string;
  sourceSide: HandleSide;
  /** Viewport coords of the cursor at the moment of capture. */
  startPos: { x: number; y: number };
  /** Current viewport coords; updated on every pointermove. */
  ghostPos: { x: number; y: number };
  /** The node under the cursor right now, if any (and not the source). */
  targetNodeId: string | null;
}

export interface UseConnectionDragArgs {
  /** Current graph data; consulted on drop for stale-node guard. */
  data: ToCData;
  /** Container that wraps the canvas; used for hit-testing if needed. */
  containerRef: RefObject<HTMLElement | null>;
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

export interface UseConnectionDragResult {
  dragState: ConnectionDragState | null;
  /**
   * Returns the props to spread on a handle dot. The pointerdown
   * handler starts the gesture if no other canvas gesture is in
   * flight; otherwise it's a no-op.
   */
  bindHandle: (
    nodeId: string,
    side: HandleSide,
  ) => {
    onPointerDown: (e: ReactPointerEvent) => void;
  };
  /** Convenience read of `dragState !== null` for the polling-pause guard. */
  isActive: boolean;
}

function nodeExistsInData(data: ToCData, nodeId: string): boolean {
  for (const section of data.sections) {
    for (const column of section.columns) {
      for (const node of column.nodes) {
        if (node.id === nodeId) return true;
      }
    }
  }
  return false;
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

  // Cleanup: release capture, clear flag, reset state. Safe to call
  // multiple times.
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
        // jsdom or detached element — non-fatal.
      }
    }
    captureElRef.current = null;
    activePointerIdRef.current = null;
    setCanvasGestureActive(false);
    setDragState(null);
  }, [setDragState]);

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
      cleanup();
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

      setDragState({
        sourceNodeId: nodeId,
        sourceSide: side,
        startPos: { x: e.clientX, y: e.clientY },
        ghostPos: { x: e.clientX, y: e.clientY },
        targetNodeId: null,
      });

      // Don't bubble pointerdown to the parent NodeComponent's drag
      // binder — that would race the two gestures for the same pointer.
      // (NodeComponent's onPointerDown is on the node root; the handle
      // dot sits inside the node root. Stop here.)
      e.stopPropagation();
    },
    [setDragState],
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
