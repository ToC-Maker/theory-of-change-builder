// `usePointerDrag` — pointer-events node drag, replacing the HTML5
// Drag and Drop API on the node-drag interaction.
//
// Why pointer events (not HTML5 DnD):
//   - Touch parity: HTML5 DnD has poor mobile support (no `dragstart`
//     on iOS Safari for many surfaces, partial Android behavior).
//   - Mid-gesture cancellation: HTML5 DnD has no programmatic cancel;
//     pointer events let us reset state cleanly on Escape, on a
//     second-finger touch (pinch-zoom takeover), and on cross-tab
//     deletion of the dragged node.
//   - The captured-pointer model also closes the "drop outside
//     container" gap that the old global `drop` listener used to
//     cover: a captured pointer keeps delivering `pointerup`
//     everywhere on the page.
//
// Cross-PR coordination:
//   PR 5 (`useConnectionDrag`) and PR 7 (`useWaypointDrag`) are built
//   on the same pattern. They check `isCanvasGestureActive()` (see
//   `./_canvasGestureState.ts`) on pointerdown and short-circuit if
//   another canvas gesture is in flight — the mutual-exclusion
//   primitive the red-team Important "PR 7 waypoint × connection-drag
//   gesture coordination" finding called for.
//
// Coordinate translation:
//   `clientX/Y` is viewport coordinates. The container may sit inside
//   a CSS-transform stack (zoom/pan from `useZoomPan`). We translate
//   to container-local by subtracting the container's bounding-rect
//   origin and dividing by `zoomScale`. Snapshot rects from
//   `classifyRegion` live in the same container-local space.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react';
import type { LayoutSnapshot, Region } from './useGraphLayout';
import { classifyRegion } from './useGraphLayout';
import { isCanvasGestureActive, setCanvasGestureActive } from './_canvasGestureState';
import type { ToCData } from '../types';
import { loggingService } from '../services/loggingService';
import { nodeExistsInData } from '../utils/findNode';

/**
 * Where the drop would land if the pointer were released right now.
 *
 * Mirrors the inner `Region` discriminated union from `useGraphLayout`
 * one-to-one so PR 5/7 consumers can `switch (kind)` and let TS check
 * exhaustiveness instead of probing optional flags. (Earlier shape
 * collapsed all four cases into optional `yPosition`/`isNewColumn`/
 * `isNewSection` flags, which were under-constrained at the type level
 * and prone to "which one wins?" bugs.)
 */
export type DragOverLocation =
  | { kind: 'node-slot'; sectionIndex: number; columnIndex: number; yPosition: number }
  | { kind: 'over-node'; sectionIndex: number; columnIndex: number }
  | { kind: 'new-column'; sectionIndex: number; columnIndex: number }
  | { kind: 'new-section'; sectionIndex: number };

export interface DragState {
  nodeId: string;
  /** Viewport-coords of the cursor; consumers translate as needed. */
  ghostPos: { x: number; y: number };
  /** The offset from cursor to node top-left at drag-start, viewport-coords. */
  pointerOffset: { x: number; y: number };
  /** The dimensions of the dragged node at drag-start, container-local px. */
  nodeSize: { width: number; height: number };
  /** Where the drop would land if released right now. */
  dragOverLocation: DragOverLocation | null;
  /**
   * False until the cursor has moved beyond a small threshold from
   * the pointerdown position. Consumers gate visual drag affordances
   * (ghost overlays, half-opacity-on-source) on this so a single tap
   * (pointerdown→pointerup with no intervening move) doesn't render a
   * one-frame ghost flicker.
   */
  hasMoved: boolean;
}

/**
 * Pixel threshold below which a gesture is treated as a tap rather
 * than a drag for rendering purposes. The state machine itself still
 * engages on pointerdown (we need to claim the mutex + pointer capture
 * before knowing whether it's a tap or a drag); this threshold only
 * controls when visual ghost affordances appear. 4px is a common UA
 * dead-zone for "click vs drag" distinction.
 */
const MOVE_THRESHOLD_PX = 4;

export interface UsePointerDragArgs {
  /** Current graph data; consulted on drop for stale-node guard. */
  data: ToCData;
  /** Container that wraps the canvas; rects in the snapshot are
   *  relative to its origin. */
  containerRef: RefObject<HTMLElement | null>;
  /** Layout snapshot accessor (from `useGraphLayout`). */
  getSnapshot: () => LayoutSnapshot;
  /** When false, pointerdown is a no-op (read-only mode). */
  editMode: boolean;
  /** Current zoom scale (1 = no zoom). Used to translate viewport→local. */
  zoomScale?: number;
  /** Node heights, keyed by node id, in container-local px. */
  nodeHeights: Record<string, number>;
  /**
   * Fired on drop with the mapped target. `pointerOffset` is the
   * viewport-coord offset from cursor to dragged node's top-left,
   * captured at drag-start (so the consumer can place the node such
   * that the grab point stays under the cursor). Passing it through
   * the callback (rather than letting the consumer read it from React
   * state) closes the scheduling gap that `dragStateRef` exists for
   * inside the hook.
   */
  onDrop: (
    target: DragOverLocation,
    draggedNodeId: string,
    pointerOffset: { x: number; y: number },
  ) => void;
  /** Fired once at drag-start. NodeEditor uses this to dismiss itself. */
  onDragStart?: (nodeId: string) => void;
  /**
   * Fired when a drop is aborted because the dragged node id is no
   * longer present in `data` (cross-tab delete race). Consumer can
   * surface a toast / banner so the user knows their drag was
   * discarded for a reason rather than vanishing silently.
   */
  onStaleDrop?: (nodeId: string) => void;
}

export interface UsePointerDragResult {
  dragState: DragState | null;
  /** Returns the props to spread on a node root to make it drag-bindable. */
  bindNode: (nodeId: string) => {
    onPointerDown: (e: ReactPointerEvent) => void;
  };
  /** Convenience read of `dragState !== null` for the polling-pause guard. */
  isActive: boolean;
}

/** Map a classifyRegion result onto the public DragOverLocation union. */
function regionToDragOverLocation(region: Region | null): DragOverLocation | null {
  if (!region) return null;
  switch (region.kind) {
    case 'node-slot':
      return {
        kind: 'node-slot',
        sectionIndex: region.sectionIdx,
        columnIndex: region.columnIdx,
        yPosition: region.yPosition,
      };
    case 'over-node':
      // Over an existing node: treat as a node-slot in the same column
      // so the drop reorders within the column. We don't have a cursor
      // y here (classifyRegion didn't pass it through for this variant);
      // the consumer falls back to its default position.
      return {
        kind: 'over-node',
        sectionIndex: region.sectionIdx,
        columnIndex: region.columnIdx,
      };
    case 'new-column':
      return {
        kind: 'new-column',
        sectionIndex: region.sectionIdx,
        columnIndex: region.columnIdx,
      };
    case 'new-section':
      // No existing code path inserts a new section via drag, but we
      // expose the signal so PR 5+ can react to it without another
      // round of plumbing.
      return { kind: 'new-section', sectionIndex: region.sectionIdx };
  }
}

export function usePointerDrag(args: UsePointerDragArgs): UsePointerDragResult {
  const {
    data,
    containerRef,
    getSnapshot,
    editMode,
    zoomScale = 1,
    nodeHeights,
    onDrop,
    onDragStart,
    onStaleDrop,
  } = args;

  const [dragState, setDragStateInternal] = useState<DragState | null>(null);

  // We keep a ref mirror of dragState so the document-level pointerup
  // handler can read the latest value synchronously without going
  // through React's state-setter callback (which is not guaranteed to
  // run synchronously in all React 18+ scheduling modes).
  const dragStateRef = useRef<DragState | null>(null);
  const setDragState = useCallback(
    (next: DragState | null | ((prev: DragState | null) => DragState | null)) => {
      if (typeof next === 'function') {
        const fn = next as (prev: DragState | null) => DragState | null;
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

  // We keep a ref mirror of the latest data so the stale-node guard at
  // drop-time sees the freshest snapshot (the React state callback in
  // pointerup won't have it otherwise).
  const dataRef = useRef(data);
  dataRef.current = data;

  // Latest zoomScale / nodeHeights / onDrop / onStaleDrop ref so the
  // document-level listeners (installed once) read the live values
  // without re-installing on every prop change.
  const zoomRef = useRef(zoomScale);
  zoomRef.current = zoomScale;
  const nodeHeightsRef = useRef(nodeHeights);
  nodeHeightsRef.current = nodeHeights;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onStaleDropRef = useRef(onStaleDrop);
  onStaleDropRef.current = onStaleDrop;

  // The pointer id we captured so we can release it on cleanup. Also
  // the active pointer id we ignore on the second-pointer guard.
  const activePointerIdRef = useRef<number | null>(null);
  // The element we called setPointerCapture on (typically the node root).
  const captureElRef = useRef<HTMLElement | null>(null);
  // The viewport coords of the cursor at drag-start. Compared against
  // each pointermove to detect when the gesture has moved beyond the
  // tap dead-zone (MOVE_THRESHOLD_PX). Distinct from `dragState.ghostPos`,
  // which tracks the live cursor and gets overwritten on each move.
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  // Cleanup: release pointer capture (if any), reset module-scope flag,
  // and clear local state. Safe to call multiple times.
  //
  // Per the Pointer Events spec, `releasePointerCapture` is a no-op when
  // no capture is held, so we don't precheck `hasPointerCapture`. The
  // try/catch still covers jsdom (no method) and detached elements.
  const cleanup = useCallback(() => {
    const el = captureElRef.current;
    const pointerId = activePointerIdRef.current;
    if (el && pointerId != null) {
      try {
        el.releasePointerCapture?.(pointerId);
      } catch {
        // jsdom or detached element — non-fatal.
      }
    }
    captureElRef.current = null;
    activePointerIdRef.current = null;
    startPosRef.current = null;
    setCanvasGestureActive(false);
    setDragState(null);
  }, [setDragState]);

  // pointermove handler — translate to container-local, classify, update state.
  const handlePointerMove = useCallback(
    (e: PointerEvent) => {
      // Ignore moves from other pointers (active pointer is the one we
      // captured at start; second pointers are handled separately).
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      const container = containerRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const localX = (e.clientX - containerRect.left) / zoomRef.current;
      const localY = (e.clientY - containerRect.top) / zoomRef.current;
      const snap = getSnapshot();
      const region = classifyRegion(snap, { x: localX, y: localY });
      const dragOverLocation = regionToDragOverLocation(region);
      setDragState((prev) => {
        if (!prev) return prev;
        // Flip hasMoved the first time the cursor crosses the tap
        // dead-zone. Compared against the *initial* pointerdown
        // position (in startPosRef), not the previous move — a slow
        // drag accumulating 1px-per-frame still crosses the threshold.
        let hasMoved = prev.hasMoved;
        if (!hasMoved && startPosRef.current) {
          const dx = e.clientX - startPosRef.current.x;
          const dy = e.clientY - startPosRef.current.y;
          hasMoved = Math.abs(dx) > MOVE_THRESHOLD_PX || Math.abs(dy) > MOVE_THRESHOLD_PX;
        }
        return {
          ...prev,
          ghostPos: { x: e.clientX, y: e.clientY },
          dragOverLocation,
          hasMoved,
        };
      });
    },
    [containerRef, getSnapshot, setDragState],
  );

  // pointerup handler — stale-node guard, then fire onDrop if valid.
  //
  // The consumer-supplied `onDrop` callback runs inside `try { ... }
  // finally { cleanup() }`. Without that, a throw in the consumer
  // escapes the listener and leaves four pieces of state stuck:
  //   - `isCanvasGestureActive` = true (PR 5/7 hooks short-circuit
  //      every pointerdown until next click anywhere)
  //   - dragState non-null (phantom ghost rendered indefinitely)
  //   - pointer capture not released
  //   - `isDragActive` stuck true (consumer's polling-pause never lifts)
  // The bug is silent and self-heals on next pointerdown via
  // `handleSecondPointer` → `cleanup()`, which is exactly what makes it
  // hard to diagnose. Surfacing the error via `loggingService` makes it
  // observable.
  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      const state = dragStateRef.current;
      try {
        if (state) {
          // Stale-node guard: cross-tab delete race.
          if (!nodeExistsInData(dataRef.current, state.nodeId)) {
            loggingService.reportError({
              error_name: 'stale-node-drop',
              error_message: `Dropped node ${state.nodeId} no longer exists in data`,
              request_metadata: { nodeId: state.nodeId },
            });
            onStaleDropRef.current?.(state.nodeId);
          } else if (state.dragOverLocation) {
            onDropRef.current(state.dragOverLocation, state.nodeId, state.pointerOffset);
          }
        }
      } catch (err) {
        loggingService.reportError({
          error_name: 'drop-handler-threw',
          error_message: err instanceof Error ? err.message : String(err),
          stack_trace: err instanceof Error ? err.stack : undefined,
          request_metadata: { nodeId: state?.nodeId },
        });
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
      // The first pointerdown of the gesture comes through the React
      // handler in bindNode; document-level pointerdowns are everything
      // else. Ignore the active pointer's own re-dispatch (rare but
      // safe to guard).
      if (activePointerIdRef.current != null && e.pointerId === activePointerIdRef.current) return;
      cleanup();
    },
    [cleanup],
  );

  // Subscribe document listeners while a drag is in flight. We tear
  // them down on cleanup so they don't fire spuriously between drags.
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

  // Hook-unmount safety: if the consumer unmounts mid-drag (e.g. route
  // change while a finger is down), make sure the gesture flag doesn't
  // leak to PR 5/7's pointer handlers.
  //
  // We only clear the flag if WE set it (i.e. our own dragStateRef is
  // populated). The earlier shape cleared unconditionally on any
  // `isCanvasGestureActive()`, which would wipe a sibling drag hook's
  // claim if a PR 5/7 hook held the flag when this one unmounted. The
  // ref check makes ownership explicit.
  useEffect(() => {
    return () => {
      if (dragStateRef.current !== null && isCanvasGestureActive()) {
        setCanvasGestureActive(false);
      }
    };
  }, []);

  // Mirror render-time props/callbacks behind refs so the per-id
  // pointerdown handler can stay referentially stable across renders.
  // `React.memo(NodeComponent)` requires stable callback props; if
  // `bindNode(id).onPointerDown` returned a fresh function every parent
  // render, the memo would always invalidate. The per-id handler reads
  // current values via these refs at call time instead of closing over
  // them.
  const editModeRef = useRef(editMode);
  editModeRef.current = editMode;
  const getSnapshotRef = useRef(getSnapshot);
  getSnapshotRef.current = getSnapshot;
  const onDragStartRef = useRef(onDragStart);
  onDragStartRef.current = onDragStart;

  // Per-id handler cache so the returned object identity is stable
  // for a given node id across re-renders. Cleared on unmount only
  // (entries are small; the cache size is bounded by the live node set).
  const bindCacheRef = useRef<Map<string, { onPointerDown: (e: ReactPointerEvent) => void }>>(
    new Map(),
  );

  const startDrag = useCallback(
    (nodeId: string, e: ReactPointerEvent) => {
      if (!editModeRef.current) return;
      if (isCanvasGestureActive()) return;
      if (e.button != null && e.button !== 0) return;

      const target = e.target as HTMLElement | null;
      const container = containerRef.current;
      if (!target || !container) return;

      try {
        if (typeof target.setPointerCapture === 'function') {
          target.setPointerCapture(e.pointerId);
          captureElRef.current = target;
        }
      } catch {
        // jsdom or detached element — non-fatal.
      }

      activePointerIdRef.current = e.pointerId;
      startPosRef.current = { x: e.clientX, y: e.clientY };
      setCanvasGestureActive(true);
      onDragStartRef.current?.(nodeId);

      const nodeEl = e.currentTarget as HTMLElement;
      const containerRect = container.getBoundingClientRect();
      const nodeRect = nodeEl.getBoundingClientRect();
      const pointerOffset = {
        x: e.clientX - nodeRect.left,
        y: e.clientY - nodeRect.top,
      };
      const nodeSize = {
        width: nodeEl.offsetWidth,
        height: nodeHeightsRef.current[nodeId] || nodeEl.offsetHeight,
      };

      const localX = (e.clientX - containerRect.left) / zoomRef.current;
      const localY = (e.clientY - containerRect.top) / zoomRef.current;
      const initialRegion = classifyRegion(getSnapshotRef.current(), { x: localX, y: localY });

      setDragState({
        nodeId,
        ghostPos: { x: e.clientX, y: e.clientY },
        pointerOffset,
        nodeSize,
        dragOverLocation: regionToDragOverLocation(initialRegion),
        hasMoved: false,
      });
    },
    [containerRef, setDragState],
  );

  const bindNode = useCallback(
    (nodeId: string) => {
      const cached = bindCacheRef.current.get(nodeId);
      if (cached) return cached;
      const entry = {
        onPointerDown: (e: ReactPointerEvent) => startDrag(nodeId, e),
      };
      bindCacheRef.current.set(nodeId, entry);
      return entry;
    },
    [startDrag],
  );

  return useMemo(
    () => ({
      dragState,
      bindNode,
      isActive: dragState !== null,
    }),
    [dragState, bindNode],
  );
}
