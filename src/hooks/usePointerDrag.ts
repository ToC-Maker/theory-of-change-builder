// `usePointerDrag` — pointer-events node drag, replacing the HTML5
// Drag and Drop API on the node-drag interaction.
//
// Why pointer events:
//   - Touch parity: HTML5 DnD has poor mobile support (no `dragstart`
//     on iOS Safari for many surfaces, partial Android behavior).
//   - Mid-gesture cancellation: HTML5 DnD has no programmatic cancel;
//     pointer events let us reset state cleanly on Escape, on a
//     second-finger touch (pinch-zoom takeover), and on cross-tab
//     deletion of the dragged node.
//   - Zoom-aware coordinates: pointer events deliver `clientX/Y` we
//     can translate to canvas-local via `useGraphLayout.getLocalPosition`
//     for the drop calculation.
//   - Future-proof: PR 5 (`useConnectionDrag`) and PR 7 (`useWaypointDrag`)
//     are built on the same pattern. They check
//     `isCanvasGestureActive()` (see `./_canvasGestureState.ts`) on
//     pointerdown and short-circuit if another canvas gesture is in
//     flight — the mutual-exclusion primitive that the red-team
//     Important finding "PR 7 waypoint × connection-drag gesture
//     coordination" called for.
//
// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
//
//   pointerdown on node →
//     - check editMode + isCanvasGestureActive guards
//     - capture pointer (so we keep receiving moves even if the
//       cursor leaves the node element)
//     - set isCanvasGestureActive(true)
//     - fire onDragStart (NodeEditor uses this to dismiss itself)
//     - subscribe document-level pointermove/up/cancel/keydown +
//       second-pointer pointerdown
//     - return; the React state update sets dragState != null
//
//   pointermove →
//     - update ghostPos to {clientX, clientY}
//     - translate to container-local, call classifyRegion, map the
//       resulting region into the existing DragOverLocation shape
//
//   pointerup →
//     - stale-node guard: verify the dragged node id still exists in
//       current data (red-team Important "PR 4 pointer-capture during
//       cross-tab delete race"); if not, abort with
//       loggingService.reportError
//     - if region is non-null, call onDrop with the mapped target
//     - cleanup (release pointer capture, clear listeners, clear
//       isCanvasGestureActive, reset state)
//
//   pointercancel →
//     - cleanup, no onDrop
//
//   keydown Escape →
//     - cleanup, no onDrop
//
//   pointerdown (second pointer) →
//     - cleanup, no onDrop. Pinch-zoom (via useZoomPan or similar)
//       then takes over.
//
//   hook unmount mid-drag →
//     - cleanup so the gesture flag doesn't leak to PR 5/7's pointer
//       handlers.
//
// ---------------------------------------------------------------------------
// Coordinate translation
// ---------------------------------------------------------------------------
//
// `clientX/Y` is viewport coordinates. The container may be inside a
// CSS-transform stack (zoom/pan from `useZoomPan`). We translate to
// container-local by subtracting the container's bounding-rect origin
// and dividing by `zoomScale`. This matches the existing
// `useGraphLayout.classifyRegion` contract (snapshot rects are stored
// in container-local px, captured via `el.getBoundingClientRect()` —
// itself in viewport space, but the snapshot already subtracts
// `containerRect.left/top`).
//
// Note: zoom is applied uniformly (no rotate/skew), so a single divide
// is sufficient. If the zoom hook ever introduces non-uniform scale
// the translation here will need an inverse-matrix step.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject, PointerEvent as ReactPointerEvent } from 'react';
import type { LayoutSnapshot, Region } from './useGraphLayout';
import { classifyRegion } from './useGraphLayout';
import { isCanvasGestureActive, setCanvasGestureActive } from './_canvasGestureState';
import type { ToCData } from '../types';
import { loggingService } from '../services/loggingService';

export interface DragOverLocation {
  sectionIndex: number;
  columnIndex: number;
  /** Container-local Y where the cursor sits, in node-slot regions only. */
  yPosition?: number;
  /** True for new-column gutters (drop becomes a column-insert at columnIndex). */
  isNewColumn?: boolean;
  /** True for new-section gutters (drop becomes a section-insert at sectionIndex). */
  isNewSection?: boolean;
}

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
}

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
  /** Fired on drop with the mapped target. */
  onDrop: (target: DragOverLocation, draggedNodeId: string) => void;
  /** Fired once at drag-start. NodeEditor uses this to dismiss itself. */
  onDragStart?: (nodeId: string) => void;
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

/** Map a classifyRegion result to the legacy DragOverLocation shape. */
function regionToDragOverLocation(region: Region | null): DragOverLocation | null {
  if (!region) return null;
  switch (region.kind) {
    case 'node-slot':
      return {
        sectionIndex: region.sectionIdx,
        columnIndex: region.columnIdx,
        yPosition: region.yPosition,
        isNewColumn: false,
      };
    case 'over-node':
      // Over an existing node: treat as a node-slot in the same column
      // so the drop reorders within the column. Drop math uses
      // yPosition from the cursor; we don't have it here, so we leave
      // it undefined and let the consumer fall back to its default.
      return {
        sectionIndex: region.sectionIdx,
        columnIndex: region.columnIdx,
        isNewColumn: false,
      };
    case 'new-column':
      return {
        sectionIndex: region.sectionIdx,
        columnIndex: region.columnIdx,
        isNewColumn: true,
      };
    case 'new-section':
      // No existing code path inserts a new section via drag, but we
      // expose the signal so PR 5+ can react to it without another
      // round of plumbing. The legacy `handleDrop` ignores
      // isNewSection.
      return {
        sectionIndex: region.sectionIdx,
        columnIndex: 0,
        isNewSection: true,
      };
  }
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

  // Latest zoomScale / nodeHeights / onDrop ref so the document-level
  // listeners (installed once) read the live values without re-installing
  // on every prop change.
  const zoomRef = useRef(zoomScale);
  zoomRef.current = zoomScale;
  const nodeHeightsRef = useRef(nodeHeights);
  nodeHeightsRef.current = nodeHeights;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  // The pointer id we captured so we can release it on cleanup. Also
  // the active pointer id we ignore on the second-pointer guard.
  const activePointerIdRef = useRef<number | null>(null);
  // The element we called setPointerCapture on (typically the node root).
  const captureElRef = useRef<HTMLElement | null>(null);

  // Cleanup: release pointer capture (if any), reset module-scope flag,
  // and clear local state. Safe to call multiple times.
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
        // jsdom or detached element — non-fatal. Pointer capture is a
        // best-effort signal; clearing local state is what matters.
      }
    }
    captureElRef.current = null;
    activePointerIdRef.current = null;
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
      setDragState((prev) =>
        prev
          ? {
              ...prev,
              ghostPos: { x: e.clientX, y: e.clientY },
              dragOverLocation,
            }
          : prev,
      );
    },
    [containerRef, getSnapshot, setDragState],
  );

  // pointerup handler — stale-node guard, then fire onDrop if valid.
  const handlePointerUp = useCallback(
    (e: PointerEvent) => {
      if (activePointerIdRef.current != null && e.pointerId !== activePointerIdRef.current) return;
      const state = dragStateRef.current;
      if (state) {
        // Stale-node guard: cross-tab delete race.
        if (!nodeExistsInData(dataRef.current, state.nodeId)) {
          loggingService.reportError({
            error_name: 'stale-node-drop',
            error_message: `Dropped node ${state.nodeId} no longer exists in data`,
            request_metadata: { nodeId: state.nodeId },
          });
        } else if (state.dragOverLocation) {
          onDropRef.current(state.dragOverLocation, state.nodeId);
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
  useEffect(() => {
    return () => {
      if (isCanvasGestureActive()) {
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
