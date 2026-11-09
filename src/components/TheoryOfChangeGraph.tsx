import clsx from 'clsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ToCData, Node } from '../types';
import { getContrastTextColor } from '../utils';
import { clampNodeCenterY, computeDropCenterY, resolveNodeCenterY } from '../utils/nodePosition';
import { computeLandingIndicator } from '../utils/landingIndicator';
import { computeDropPreview } from '../utils/dropPreview';
import { planColumnDrop } from '../utils/makeRoom';
import { computeAlignedSections } from '../utils/alignNodes';
import { useSuspendForExport } from '../utils/exportSuspend';
import { NodeComponent } from './NodeComponent';
import { ConnectionsComponent } from './ConnectionsComponent';
import { AlignmentSuggestionBanner } from './AlignmentSuggestionBanner';
import { NodeEditor } from './node-editor/NodeEditor';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useGraphLayout, getLocalPosition } from '../hooks/useGraphLayout';
import { DEFAULT_NODE_WIDTH, columnWidth } from '../utils/nodeWidth';
import { useGraphMutation } from '../hooks/useGraphMutation';
import { usePointerDrag } from '../hooks/usePointerDrag';
import type { DragOverLocation } from '../hooks/usePointerDrag';
import { useConnectionDrag } from '../hooks/useConnectionDrag';
import { useWaypointDrag } from '../hooks/useWaypointDrag';
import {
  computeConnectionAnchors,
  getConnectionDirection,
  lineMidpoint,
} from '../utils/connectionGeometry';
import { buildConnectionPath } from './canvas/connectionPath';
import { ColumnDeleteAffordance } from './canvas/ColumnDeleteAffordance';
import { DropLandingIndicator } from './canvas/DropLandingIndicator';
import { AddControlZone, CANVAS_EDGE_PX, ColumnSlot } from './canvas/AddControlZone';
import type { AddControl } from './canvas/AddControlZone';
import { CANVAS_DOM_ATTR } from './canvas/editorSwitchTargets';
import { PlusIcon, MinusIcon } from '@heroicons/react/24/outline';

// The data an updater receives is the object App keeps as the undo
// snapshot, so insertions copy every array they extend instead of
// splicing it.
const insertSection = (data: ToCData, index: number): ToCData => ({
  ...data,
  sections: [
    ...data.sections.slice(0, index),
    { title: 'New Section', columns: [{ nodes: [] }] },
    ...data.sections.slice(index),
  ],
});

const insertColumn = (data: ToCData, sectionIndex: number, index: number): ToCData => ({
  ...data,
  sections: data.sections.map((section, i) =>
    i === sectionIndex
      ? {
          ...section,
          columns: [
            ...section.columns.slice(0, index),
            { nodes: [] },
            ...section.columns.slice(index),
          ],
        }
      : section,
  ),
});

// PR 1 task 1.7: TopBar at App-level took over undo/redo/save-status,
// so the old prop drilling for those (`undoHistory`, `redoHistory`,
// `handleUndo`, `handleRedo`, `isSaving`, `lastSyncTime`,
// `isManualSyncing`, `handleManualSync`, `getTimeAgo`) is no longer
// needed by `ToC`.
//
// PR 2: the share-dialog block also moved up to App.tsx, so
// `currentEditToken` and `onChartCreated` are no longer threaded
// through. The remaining props are the canvas-layer hooks (camera,
// viewport, container-size callbacks) + highlight notifier.
export function ToC({
  data: initialData,
  onSizeChange,
  onDataChange,
  showEditButton = true,
  zoomScale = 1,
  camera,
  onHighlightedNodesChange,
  onDragActiveChange,
}: {
  data: ToCData;
  onSizeChange?: (size: { width: number; height: number }) => void;
  onDataChange?: (data: ToCData) => void;
  showEditButton?: boolean;
  zoomScale?: number;
  camera?: { x: number; y: number; z: number };
  onHighlightedNodesChange?: (highlightedNodes: Set<string>) => void;
  /**
   * PR 4: fired when a pointer-drag starts or ends. App.tsx uses this
   * to pause its 30s sync poll so the in-flight gesture isn't fighting
   * a stale server snapshot for control of the canvas state
   * (red-team Important "PR 4 pointer-capture during cross-tab delete
   * race"). Best-effort: a missed `false` after unmount is fine — the
   * polling effect re-snapshots `data` next tick.
   */
  onDragActiveChange?: (isActive: boolean) => void;
  // PR 3: `viewportOffset` was used by the NodePopup / EdgePopup modal
  // sizing math; both modals retired, so the prop is gone. The
  // anchored editors are positioned by `useAnchorPosition` directly.
}) {
  // Graph mutation seam: see `src/hooks/useGraphMutation.ts` for the
  // queueMicrotask-deferral rationale (replaces the previous
  // `setTimeout(0)` hack with a precise documented primitive). Three
  // entry points:
  //
  //   mutate(updater)              — discrete user actions
  //                                   (drop, delete, add-node, add-column,
  //                                   add-section, etc.)
  //   mutateDebounced(updater,key) — streaming inputs
  //                                   (slider drags, color, title typing).
  //                                   No parent notify until commit().
  //   commit(key?)                 — flush buffered key(s); produces ONE
  //                                   undo entry per gesture.
  //
  // `setData` from the hook is exposed for direct AI-edit / external
  // state-replace paths (the `useEffect` that resets `data` when
  // `initialData` changes).
  const {
    data,
    setData,
    mutate: setDataAndNotify,
    mutateDebounced,
    commit: commitMutation,
    discardBuffered: discardBufferedMutation,
    notifyCount,
  } = useGraphMutation(initialData, onDataChange);
  const [nodeRefs, setNodeRefs] = useState<{
    [key: string]: HTMLDivElement | null;
  }>({});
  // Ref mirror of `nodeRefs` for the drag-handler hot path (read-only).
  // Reading via a ref keeps `handleDragStart`'s useCallback dep list
  // stable across node mount/unmount churn (a `useState`-keyed dep
  // mutates on every ref-callback fire, invalidating React.memo on
  // every node and defeating Task 0.4's bail-out work).
  const nodeRefsRef = useRef<{ [key: string]: HTMLDivElement | null }>({});
  const [nodeHeights, setNodeHeights] = useState<{
    [key: string]: number;
  }>({});
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set());

  // Notify parent when highlighted nodes change
  useEffect(() => {
    onHighlightedNodesChange?.(highlightedNodes);
  }, [highlightedNodes, onHighlightedNodesChange]);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  // An export shows the chart without a selection or hover.
  useSuspendForExport(() => {
    const selected = highlightedNodes;
    setHighlightedNodes(new Set());
    setHoveredNode(null);
    return () => setHighlightedNodes(selected);
  });
  // PR 4: legacy `draggedNode`, `dragOffset`, `dragOverLocation` state
  // retired — `usePointerDrag` now owns drag state internally and
  // returns `dragState` (or null). The hook is wired below after
  // `useGraphLayout` (it needs the snapshot accessor).
  // PR 5 Task 5.4: `layoutMode` deleted. The dual-mode toggle is
  // gone; edit-mode now provides the always-on hover affordances
  // (gutters, hover-× delete, connection handles) that used to be
  // gated behind layoutMode. `editMode` remains as the view/edit
  // distinction, set by the parent route (showEditButton).
  // Direct prop-mirror (no setter, no state slot): if the parent
  // ever flips `showEditButton`, this component re-renders with the
  // new value rather than freezing the mount-time value.
  const editMode = showEditButton;
  // The Format menu writes these into the data, so they follow the prop.
  // A setting that is not set renders its default: undo can restore a
  // chart that never had it.
  const curvature = initialData.curvature ?? 0.5;
  const textSize = initialData.textSize ?? 1; // 0.5 to 2.0 scale
  const fontFamily = initialData.fontFamily ?? "'Ubuntu', sans-serif";
  const columnPadding = initialData.columnPadding ?? 24; // pixels
  const sectionPadding = initialData.sectionPadding ?? 32; // pixels
  const [nodeWidth, setNodeWidth] = useState(DEFAULT_NODE_WIDTH);
  const [nodeColor, setNodeColor] = useState('#ffffff'); // Default white background
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingSectionIndex, setEditingSectionIndex] = useState<number | null>(null);
  // Width (content px) the edited section's title bar had when its
  // editor opened. The bar keeps it while typing so the section doesn't
  // resize under the cursor.
  const [editingBarWidth, setEditingBarWidth] = useState(0);
  // PR 3: `editingNodeId` / `nodePopup` / `edgePopup` state retired —
  // node editing now lives in the anchored `<NodeEditor>` (mounted
  // alongside the selected node) and edge editing in `<EdgeEditor>`
  // (owned by `ConnectionsComponent`'s `selectedEdge` state).
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });
  const graphContainerRef = useRef<HTMLDivElement>(null);

  const updateNodeRef = useCallback((id: string, ref: HTMLDivElement | null) => {
    nodeRefsRef.current[id] = ref;
    setNodeRefs((prev) => ({ ...prev, [id]: ref }));

    // Update height when ref changes - use offsetHeight for local (pre-transform) height
    if (ref) {
      const height = ref.offsetHeight;
      setNodeHeights((prev) => ({ ...prev, [id]: height }));
    }
  }, []);

  // PR 3: `updateNode` and `updateNodeTitle` retired — node title and
  // markdown details are now mutated via the `useNodeProperties` hook
  // inside `<NodeEditor>`, which writes through the same
  // `useGraphMutation` primitive (`mutateDebounced` + `commit`) every
  // other streaming input uses. Per-keystroke height recompute is
  // handled by the ResizeObserver in `useAnchorPosition`.

  // Pending height-recalc timer. Tracked so unmount can clear it: the
  // bare setTimeout used to outlive the component (it fires on every
  // mount via the initialData effect below), and a mount→unmount inside
  // the 50ms window made the callback setState against a dead tree —
  // observed as a flaky "window is not defined" unhandled error when a
  // jsdom test environment tore down first.
  const heightRecalcTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (heightRecalcTimerRef.current != null) clearTimeout(heightRecalcTimerRef.current);
    };
  }, []);

  const recalculateAllNodeHeights = useCallback(() => {
    // Force recalculation of all node heights. Last call wins — a
    // pending timer is superseded (the callback recomputes ALL heights
    // from the current refs, so collapsing rapid calls is lossless).
    if (heightRecalcTimerRef.current != null) clearTimeout(heightRecalcTimerRef.current);
    heightRecalcTimerRef.current = setTimeout(() => {
      heightRecalcTimerRef.current = null;
      Object.entries(nodeRefs).forEach(([nodeId, ref]) => {
        if (ref) {
          const height = ref.offsetHeight;
          setNodeHeights((prev) => ({ ...prev, [nodeId]: height }));
        }
      });
    }, 50); // Slightly longer delay to ensure DOM updates
  }, [nodeRefs]);

  // Update internal data state when prop changes. Separate from the
  // height recalculation below: that callback changes whenever nodes
  // remount (a node moved to another column), and re-running this effect
  // then would replace an edit not yet reported to the parent with the
  // unchanged prop.
  useEffect(() => {
    console.log('ToC component received new initialData:', initialData);
    setData(initialData);
  }, [initialData, setData]);

  // Recalculate node heights when data changes (e.g., from AI edits)
  useEffect(() => {
    recalculateAllNodeHeights();
  }, [initialData, recalculateAllNodeHeights]);

  // Generate unique node ID
  const generateNodeId = useCallback((): string => {
    return `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }, []);

  // Create new node at specified position
  const createNewNode = useCallback(
    (sectionIndex: number, columnIndex: number, yPosition: number) => {
      if (!editMode) return;

      // Get the column to determine width
      const column = data.sections[sectionIndex]?.columns[columnIndex];
      if (!column) return;

      // Calculate width to match the column
      let newNodeWidth = nodeWidth; // Default to current width setting
      if (column.nodes.length > 0) {
        // If column has nodes, match their width (use max width in column)
        const columnNodeWidths = column.nodes.map((node) => node.width || DEFAULT_NODE_WIDTH);
        newNodeWidth = Math.max(...columnNodeWidths);
      }

      // yPosition is where the user clicked - this becomes the center Y
      // of the node, clamped so a double-click near the column top
      // doesn't place the node over the section title bar (PR #34 fb
      // 46). 76px is the typical rendered height of a fresh "New Node"
      // (same default the renderer uses before measurement).
      const newNode: Node = {
        id: generateNodeId(),
        title: 'New Node',
        text: 'Details of New Node.',
        connectionIds: [],
        connections: [],
        yPosition: clampNodeCenterY(yPosition, 76), // Click position = center Y
        width: newNodeWidth, // Match column width
        color: nodeColor, // Use current color setting
      };

      setDataAndNotify((prevData) => ({
        ...prevData,
        sections: prevData.sections.map((section, sIdx) =>
          sIdx === sectionIndex
            ? {
                ...section,
                columns: section.columns.map((column, cIdx) =>
                  cIdx === columnIndex
                    ? {
                        ...column,
                        nodes: [...column.nodes, newNode],
                      }
                    : column,
                ),
              }
            : section,
        ),
      }));

      // PR 3: selecting the new node opens the anchored NodeEditor
      // beside it (single-click semantics). No separate "enter edit
      // mode" state is needed; the editor manages its own focus.
      setHighlightedNodes(new Set([newNode.id]));
    },
    [editMode, nodeWidth, nodeColor, setDataAndNotify, generateNodeId, data.sections],
  );

  // findNodeLocation is hoisted above toggleHighlight so the useCallback
  // dep array can reference it.
  const findNodeLocation = useCallback(
    (nodeId: string) => {
      for (let sectionIndex = 0; sectionIndex < data.sections.length; sectionIndex++) {
        for (
          let columnIndex = 0;
          columnIndex < data.sections[sectionIndex].columns.length;
          columnIndex++
        ) {
          const node = data.sections[sectionIndex].columns[columnIndex].nodes.find(
            (n) => n.id === nodeId,
          );
          if (node) {
            return { sectionIndex, columnIndex, node };
          }
        }
      }
      return null;
    },
    [data.sections],
  );

  // useCallback so React.memo(NodeComponent) can bail out on referentially-
  // identical callbacks. Without this, every re-render of TheoryOfChangeGraph
  // creates a new toggleHighlight reference, defeating the memo. See
  // `NodeComponent.memo.test.tsx`.
  const toggleHighlight = useCallback(
    (id: string, selectionMode: 'single' | 'multi' | 'column' = 'single') => {
      setHighlightedNodes((prev) => {
        if (selectionMode === 'multi') {
          // Multi-select mode (Ctrl held): toggle individual nodes
          const newSet = new Set(prev);
          if (newSet.has(id)) {
            newSet.delete(id);
          } else {
            newSet.add(id);
          }

          // When adding a node to selection, snap width slider and color to that node's properties
          if (newSet.size === 1 && newSet.has(id)) {
            // Only snap if this is the first/only selected node
            const nodeLocation = findNodeLocation(id);
            if (nodeLocation) {
              const node = nodeLocation.node;
              const currentWidth = node.width || DEFAULT_NODE_WIDTH;
              const currentColor = node.color || '#ffffff';
              setNodeWidth(currentWidth);
              setNodeColor(currentColor);
            }
          }
          return newSet;
        } else if (selectionMode === 'column') {
          // Column select mode (Shift held): select all nodes in the same column
          const nodeLocation = findNodeLocation(id);
          if (nodeLocation) {
            const { sectionIndex, columnIndex } = nodeLocation;
            const columnNodes = data.sections[sectionIndex].columns[columnIndex].nodes;
            const columnNodeIds = columnNodes.map((node) => node.id);

            // Check if all column nodes are already selected
            const allColumnNodesSelected = columnNodeIds.every((nodeId) => prev.has(nodeId));

            if (allColumnNodesSelected) {
              // If all column nodes are selected, deselect them
              const newSet = new Set(prev);
              columnNodeIds.forEach((nodeId) => newSet.delete(nodeId));
              return newSet;
            } else {
              // Select all nodes in the column (add to existing selection)
              const newSet = new Set(prev);
              columnNodeIds.forEach((nodeId) => newSet.add(nodeId));

              // Snap to the clicked node's properties
              const node = nodeLocation.node;
              const currentWidth = node.width || DEFAULT_NODE_WIDTH;
              const currentColor = node.color || '#ffffff';
              setNodeWidth(currentWidth);
              setNodeColor(currentColor);

              return newSet;
            }
          }
          return prev;
        } else {
          // Single select mode (default): clear existing selection and select only this node
          const newSet = new Set<string>();
          if (!prev.has(id) || prev.size > 1) {
            // Either this node wasn't selected, or multiple nodes were selected
            // In both cases, select only this node
            newSet.add(id);

            // Snap width slider and color to the selected node's properties
            const nodeLocation = findNodeLocation(id);
            if (nodeLocation) {
              const node = nodeLocation.node;
              const currentWidth = node.width || DEFAULT_NODE_WIDTH;
              const currentColor = node.color || '#ffffff';
              setNodeWidth(currentWidth);
              setNodeColor(currentColor);
            }
          }
          // If this node was the only selected node, deselect it (newSet remains empty)
          return newSet;
        }
      });
    },
    [data.sections, findNodeLocation, setNodeWidth, setNodeColor],
  );

  const moveNodeVertically = useCallback(
    (nodeId: string, direction: 'up' | 'down') => {
      const moveAmount = direction === 'up' ? -20 : 20;

      setDataAndNotify((prevData) => ({
        ...prevData,
        sections: prevData.sections.map((section) => ({
          ...section,
          columns: section.columns.map((column) => ({
            ...column,
            nodes: column.nodes.map((node, nodeIndex) => {
              if (node.id === nodeId) {
                // Use cached height or default
                const actualHeight = nodeHeights[node.id] || 76;

                // Calculate current center Y position. Clamp so
                // arrow-key moves can't push the node above the column
                // body into the section title bar (PR #34 fb 46).
                const defaultCenterY = nodeIndex * 180 + 30 + actualHeight / 2;
                const currentCenterY = node.yPosition ?? defaultCenterY;
                return {
                  ...node,
                  yPosition: clampNodeCenterY(currentCenterY + moveAmount, actualHeight),
                };
              }
              return node;
            }),
          })),
        })),
      }));
    },
    [setDataAndNotify, nodeHeights],
  );

  // Feedback 67: the alignment math lives in `computeAlignedSections`
  // (`src/utils/alignNodes.ts`) — a PURE function. The previous inline
  // implementation shallow-copied `prevData` and then assigned into the
  // shared nested `sections[i].columns[j].nodes[k]` arrays, mutating
  // the previous state in place. App.tsx's undo history deep-clones
  // exactly that previous object (`saveToHistory(dataRef.current)`),
  // so the undo entry already carried the aligned positions and Ctrl+Z
  // after "Align nodes" was a no-op. Regression tests:
  // `tests/frontend/TheoryOfChangeGraph.alignment.test.tsx`.
  const straightenEdges = useCallback(() => {
    if (!editMode) return;

    setDataAndNotify((prevData) => {
      const nextSections = computeAlignedSections(prevData.sections, nodeHeights);
      if (nextSections === prevData.sections) return prevData; // nothing to align
      return { ...prevData, sections: nextSections };
    });
  }, [editMode, setDataAndNotify, nodeHeights]);

  // PR 4: HTML5 DnD retired. `handleDragStart` / `handleDragEnd` /
  // `handleDragOver` and the global `dragover` / `drop` document
  // listeners are gone. Pointer-events drag is owned by
  // `usePointerDrag` (wired below, after `useGraphLayout` because the
  // hook needs `getSnapshot`).
  //
  // The scaled-clone drag-image wrapper that this section used to
  // build (for the HTML5 DnD `setDragImage` call at the original
  // zoom) is no longer needed: our React-rendered drop-preview ghost
  // (see render path below) follows the pointer in the same
  // transform stack as the canvas, so the browser doesn't have to
  // composite a separate drag-image layer.

  // Section widths + column-rect snapshot from useGraphLayout.
  // `getSnapshot` is consumed by `usePointerDrag` mid-drag to feed
  // `classifyRegion` (the only path that reads rects during a gesture;
  // PR 5 / PR 7 will share the same accessor).
  const { sectionWidths, getSnapshot } = useGraphLayout({
    data,
    containerRef: graphContainerRef,
    columnPadding,
    sectionPadding,
    // PR #34 zoom fix: the hook divides viewport rect deltas by the
    // zoom so the snapshot is content-space, matching the zoom-divided
    // classify points `usePointerDrag` feeds to `classifyRegion`.
    zoomScale,
  });

  const areNodesConnected = useCallback(
    (sourceId: string, targetId: string) => {
      const sourceLocation = findNodeLocation(sourceId);
      if (!sourceLocation) return false;

      const sourceNode = sourceLocation.node;

      // Check if connection exists in either direction
      if (sourceNode.connections) {
        return sourceNode.connections.some((conn) => conn.targetId === targetId);
      } else if (sourceNode.connectionIds) {
        return sourceNode.connectionIds.includes(targetId);
      }

      return false;
    },
    [findNodeLocation],
  );

  // Generic function to delete a specific connection
  const deleteConnection = useCallback(
    (sourceId: string, targetId: string) => {
      if (!editMode) return;

      setDataAndNotify((prevData) => ({
        ...prevData,
        sections: prevData.sections.map((section) => ({
          ...section,
          columns: section.columns.map((column) => ({
            ...column,
            nodes: column.nodes.map((node) => {
              if (node.id === sourceId) {
                // Remove connection
                if (node.connections) {
                  return {
                    ...node,
                    connections: node.connections.filter((conn) => conn.targetId !== targetId),
                  };
                } else if (node.connectionIds) {
                  return {
                    ...node,
                    connectionIds: node.connectionIds.filter((id) => id !== targetId),
                  };
                }
              }
              return node;
            }),
          })),
        })),
      }));
    },
    [editMode, setDataAndNotify],
  );

  // PR 3: `deleteNode(nodeId)` callback retired — node deletion is
  // now driven by the NodeEditor's `useNodeProperties.deleteSelectedNodes`
  // (multi-select aware) and by the keyboard-shortcut delete handler in
  // `useKeyboardShortcuts.ts` (which does its own atomic batch).

  const disconnectSelectedNodes = useCallback(() => {
    if (!editMode) return;

    if (highlightedNodes.size !== 2) {
      return;
    }

    const [sourceId, targetId] = Array.from(highlightedNodes);
    deleteConnection(sourceId, targetId);

    // Clear selection after disconnecting
    setHighlightedNodes(new Set());
    setNodeWidth(DEFAULT_NODE_WIDTH);
    setNodeColor('#ffffff');
  }, [editMode, highlightedNodes, deleteConnection]);

  const connectSelectedNodes = useCallback(() => {
    if (!editMode) return;

    if (highlightedNodes.size !== 2) {
      alert('Please select exactly two nodes to connect');
      return;
    }

    const [sourceId, targetId] = Array.from(highlightedNodes);

    // Check if nodes are already connected
    if (areNodesConnected(sourceId, targetId)) {
      // Disconnect them
      disconnectSelectedNodes();
      return;
    }

    setDataAndNotify((prevData) => ({
      ...prevData,
      sections: prevData.sections.map((section) => ({
        ...section,
        columns: section.columns.map((column) => ({
          ...column,
          nodes: column.nodes.map((node) => {
            if (node.id === sourceId) {
              // Add new connection
              if (node.connections) {
                return {
                  ...node,
                  connections: [...node.connections, { targetId, confidence: 75 }],
                };
              } else {
                return {
                  ...node,
                  connectionIds: [...node.connectionIds, targetId],
                  connections: [
                    ...node.connectionIds.map((id) => ({ targetId: id, confidence: 50 })),
                    { targetId, confidence: 75 },
                  ],
                };
              }
            }
            return node;
          }),
        })),
      })),
    }));

    // Clear selection after connecting
    setHighlightedNodes(new Set());
    setNodeWidth(DEFAULT_NODE_WIDTH);
    setNodeColor('#ffffff');
  }, [editMode, highlightedNodes, setDataAndNotify, areNodesConnected, disconnectSelectedNodes]);

  // PR 4: `handleDrop` signature refactored to take a `DragOverLocation`
  // and the dragged node id directly (the hook supplies both via its
  // `onDrop` callback). The previous (sectionIndex, columnIndex,
  // isNewColumn, yPosition) shape is gone — all 6+ JSX callsites
  // that used to wire it up via `onDragOver` / `onDrop` are deleted
  // along with HTML5 DnD. The hook also closes the "drop outside
  // container" gap that the old global `drop` listener used to cover:
  // captured pointer events deliver `pointerup` everywhere.
  //
  // `pointerOffset` is the offset (in viewport px) from the cursor to
  // the top of the dragged node at drag-start; the hook passes it
  // through so we don't have to re-read it from React state at drop
  // time (closing the scheduling gap `dragStateRef` exists to cover).
  const handleDrop = useCallback(
    (target: DragOverLocation, draggedNodeId: string, pointerOffset: { x: number; y: number }) => {
      const sourceLocation = findNodeLocation(draggedNodeId);
      if (!sourceLocation) {
        console.log('Source location not found for node:', draggedNodeId);
        return;
      }
      // No drag-driven new-section path today; ignore the signal.
      if (target.kind === 'new-section') return;

      const targetSectionIndex = target.sectionIndex;
      const targetColumnIndex = target.columnIndex;
      const isNewColumn = target.kind === 'new-column';

      // Adjust yPosition so the node appears where the user grabbed it.
      // `target.yPosition` (node-slot and over-node, PR #34 fb 45/46)
      // is container-local; the hook already divided by zoomScale.
      // `pointerOffset.y` is viewport-space (captured at drag-start
      // with no zoom applied); `computeDropCenterY` divides it by
      // zoomScale to put both in the same coord system before
      // subtracting. new-column carries no cursor Y and takes the
      // top-of-column default. Every result is clamped below the
      // section title bar (PR #34 fb 46).
      const draggedNodeHeight = nodeHeights[draggedNodeId] || 76;
      const landingCenterY = computeDropCenterY({
        cursorColumnLocalY:
          target.kind === 'node-slot' || target.kind === 'over-node' ? target.yPosition : null,
        pointerOffsetY: pointerOffset.y,
        zoomScale,
        nodeHeight: draggedNodeHeight,
      });

      console.log('Moving node', draggedNodeId, 'from', sourceLocation, 'to', {
        targetSectionIndex,
        targetColumnIndex,
        isNewColumn,
        yPosition: landingCenterY,
      });

      const isSameColumnMove =
        !isNewColumn &&
        sourceLocation.sectionIndex === targetSectionIndex &&
        sourceLocation.columnIndex === targetColumnIndex;

      setDataAndNotify((prevData) => {
        // Locate the source node fresh inside the updater so we don't
        // leak `findNodeLocation`'s closed-over data snapshot.
        let sourceNode: Node | null = null;
        for (const section of prevData.sections) {
          for (const column of section.columns) {
            const found = column.nodes.find((n) => n.id === draggedNodeId);
            if (found) {
              sourceNode = found;
              break;
            }
          }
          if (sourceNode) break;
        }
        if (!sourceNode) return prevData;

        // The nodes of the target column make room for the dropped one,
        // by the same maths the live preview ran (`planColumnDrop`), and
        // are written in this one change. A new column has no other
        // nodes, so nothing shifts there. The plan reads the column as it
        // is NOW, so a node moved or deleted since the drag began is
        // accounted for.
        const targetColumn = isNewColumn
          ? undefined
          : prevData.sections[targetSectionIndex]?.columns[targetColumnIndex];
        const { droppedCenterY, shifted } = targetColumn
          ? planColumnDrop({
              columnNodes: targetColumn.nodes,
              draggedId: draggedNodeId,
              draggedHeight: draggedNodeHeight,
              landingCenterY,
              nodeHeights,
            })
          : { droppedCenterY: landingCenterY, shifted: new Map<string, number>() };
        const settle = (node: Node): Node => {
          if (node.id === draggedNodeId) return { ...node, yPosition: droppedCenterY };
          const yPosition = shifted.get(node.id);
          return yPosition === undefined ? node : { ...node, yPosition };
        };

        // Same-column move: positions updated in place.
        if (isSameColumnMove) {
          const sectionsAfterMove = prevData.sections.map((section, sIndex) =>
            sIndex === targetSectionIndex
              ? {
                  ...section,
                  columns: section.columns.map((column, cIndex) =>
                    cIndex === targetColumnIndex
                      ? { ...column, nodes: column.nodes.map(settle) }
                      : column,
                  ),
                }
              : section,
          );
          return { ...prevData, sections: sectionsAfterMove };
        }

        // Cross-column / cross-section / new-column move: remove from
        // source, add to target.
        const newData = { ...prevData };
        newData.sections = prevData.sections.map((section) => ({
          ...section,
          columns: section.columns.map((column) => ({
            ...column,
            nodes: column.nodes.filter((node) => node.id !== draggedNodeId),
          })),
        }));

        const droppedNode = settle(sourceNode);
        if (isNewColumn) {
          const targetSection = newData.sections[targetSectionIndex];
          targetSection.columns.splice(targetColumnIndex, 0, { nodes: [droppedNode] });
        } else {
          const column = newData.sections[targetSectionIndex].columns[targetColumnIndex];
          column.nodes = [...column.nodes.map(settle), droppedNode];
        }

        return newData;
      });
    },
    [findNodeLocation, zoomScale, nodeHeights, setDataAndNotify],
  );

  // PR 4: `usePointerDrag` owns drag state. `onDrop` flows directly to
  // `handleDrop` above (the hook supplies `pointerOffset` as the third
  // argument, so the consumer doesn't have to read it back from React
  // state). `onDragStart` dispatches the NodeEditor-close callback
  // registered via `nodeEditorDragStartRef` (set up below in
  // `NodeEditorMount`).
  const nodeEditorDragStartRef = useRef<(() => void) | null>(null);

  const {
    dragState,
    bindNode: bindNodeDrag,
    isActive: isDragActive,
  } = usePointerDrag({
    data,
    containerRef: graphContainerRef,
    getSnapshot,
    editMode,
    zoomScale,
    nodeHeights,
    onDrop: handleDrop,
    onDragStart: (_nodeId, modifiers) => {
      // Notify the anchored NodeEditor to dismiss (if mounted). Skip
      // the dismiss when a multi-select modifier is held — the click is
      // a selection-extension gesture, not a real drag, and dismissing
      // here would clear `highlightedNodes` before React's onClick can
      // call `toggleHighlight('multi')` to extend the selection.
      if (modifiers.metaKey || modifiers.ctrlKey) return;
      nodeEditorDragStartRef.current?.();
    },
  });

  // Where the dragged node's copy snaps while the pointer is over a
  // column, or null (copy follows the cursor), and how that column's other
  // nodes shift to make room. Computed from the same placement maths
  // `handleDrop` uses, so the preview is what the drop commits. Only while
  // the dragged node still exists: when someone else deletes it mid-drag
  // the copy is gone, and the column must not stay opened up around it.
  const dropPreview =
    dragState && findNodeLocation(dragState.nodeId)
      ? computeDropPreview({
          dragState,
          snapshot: getSnapshot(),
          zoomScale,
          sections: data.sections,
          nodeHeights,
        })
      : null;

  // PR 5 Task 5.3: column / section delete callbacks shared by the
  // hover-`×` affordance. Each writes through `setDataAndNotify` so the
  // op is one undo entry. Deleting the last column in a section
  // collapses the section too (consistent with the legacy
  // layoutMode behavior).
  const deleteColumn = useCallback(
    (sectionIndex: number, columnIndex: number) => {
      if (!editMode) return;
      setDataAndNotify((prevData) => {
        const updatedSection = {
          ...prevData.sections[sectionIndex],
          columns: prevData.sections[sectionIndex].columns.filter((_, i) => i !== columnIndex),
        };
        const newSections =
          updatedSection.columns.length === 0
            ? prevData.sections.filter((_, i) => i !== sectionIndex)
            : prevData.sections.map((s, i) => (i === sectionIndex ? updatedSection : s));
        return { ...prevData, sections: newSections };
      });
      // Clear selection if any deleted nodes were highlighted.
      setHighlightedNodes(new Set());
    },
    [editMode, setDataAndNotify],
  );

  const deleteSection = useCallback(
    (sectionIndex: number) => {
      if (!editMode) return;
      setDataAndNotify((prevData) => ({
        ...prevData,
        sections: prevData.sections.filter((_, i) => i !== sectionIndex),
      }));
      setHighlightedNodes(new Set());
    },
    [editMode, setDataAndNotify],
  );

  // PR 5 Task 5.2: drag-to-connect gesture. `useConnectionDrag` shares
  // the `isCanvasGestureActive` mutual-exclusion flag with
  // `usePointerDrag` (so node-drag and connection-drag can't start
  // concurrently). On successful drop the hook calls `onConnect` which
  // commits a single `mutate()` undo entry.
  const addConnection = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return;
      // No-op if already connected (idempotent commit avoids spurious
      // undo entries on accidental re-drops).
      if (areNodesConnected(sourceId, targetId)) return;
      setDataAndNotify((prevData) => ({
        ...prevData,
        sections: prevData.sections.map((section) => ({
          ...section,
          columns: section.columns.map((column) => ({
            ...column,
            nodes: column.nodes.map((node) => {
              if (node.id !== sourceId) return node;
              if (node.connections) {
                return {
                  ...node,
                  connections: [...node.connections, { targetId, confidence: 75 }],
                };
              }
              // Old format → migrate to new on first write.
              return {
                ...node,
                connectionIds: [...(node.connectionIds || []), targetId],
                connections: [
                  ...(node.connectionIds || []).map((id) => ({ targetId: id, confidence: 50 })),
                  { targetId, confidence: 75 },
                ],
              };
            }),
          })),
        })),
      }));
    },
    [areNodesConnected, setDataAndNotify],
  );

  const {
    dragState: connectionDragState,
    bindHandle: bindConnectionHandle,
    isActive: isConnectionDragActive,
  } = useConnectionDrag({
    data,
    editMode,
    onConnect: addConnection,
  });

  // PR 7: waypoint drag is hoisted up to `TheoryOfChangeGraph` (parity
  // with `useConnectionDrag` placement) so its `isActive` flag can OR
  // into `isAnyDragActive` below — that is the polling-pause signal the
  // 30s sync poll consumes via App.tsx's `isDragInFlightRef`. Previously
  // this hook lived inside `<ConnectionsComponent>` and the signal
  // never reached the parent (a poll mid-waypoint-drag could overwrite
  // the buffered `mutateDebounced` state). Bind accessors and the
  // current drag state are passed down to `<ConnectionsComponent>`,
  // which forwards them to per-connection `<ConnectionWaypointHandles>`.
  const clientToContainer = useCallback(
    (clientX: number, clientY: number) => {
      const container = graphContainerRef.current;
      if (!container) return { x: clientX, y: clientY };
      const rect = container.getBoundingClientRect();
      const zoom = camera?.z ?? 1;
      return {
        x: (clientX - rect.left) / zoom,
        y: (clientY - rect.top) / zoom,
      };
    },
    [camera],
  );

  // Waypoints are stored relative to the midpoint of the straight line
  // between a connection's anchors; the drag hook needs that midpoint
  // to turn the pointer position into an offset. Computed from the same
  // DOM geometry and anchor rules `ConnectionsComponent` draws with.
  const getLineMidpoint = useCallback(
    (sourceId: string, targetId: string) => {
      // A press only reaches the hook from a rendered connection, so the
      // container, both node elements and both locations exist.
      const container = graphContainerRef.current!;
      const { source, target } = computeConnectionAnchors(
        getLocalPosition(nodeRefsRef.current[sourceId]!, container),
        getLocalPosition(nodeRefsRef.current[targetId]!, container),
        getConnectionDirection(findNodeLocation(sourceId)!, findNodeLocation(targetId)!),
      );
      return lineMidpoint(source, target);
    },
    [findNodeLocation],
  );

  const waypointDrag = useWaypointDrag({
    data,
    editMode,
    mutateDebounced,
    commit: commitMutation,
    discardBuffered: discardBufferedMutation,
    notifyCount,
    clientToContainer,
    getLineMidpoint,
  });

  // Notify parent (App) of drag-active transitions so the 30s sync
  // poll can pause while a gesture is in flight (red-team Important).
  // We OR-combine the node-drag, connection-drag, and waypoint-drag
  // flags so any gesture pauses polling.
  //
  // Cleanup fires `false` if this component unmounts while a drag is
  // active — otherwise the parent's `isDragInFlightRef` stays `true`
  // for the rest of the App's lifetime (the polling effect would
  // silently skip every sync tick).
  const isAnyDragActive = isDragActive || isConnectionDragActive || waypointDrag.isActive;
  useEffect(() => {
    onDragActiveChange?.(isAnyDragActive);
    return () => {
      if (isAnyDragActive) onDragActiveChange?.(false);
    };
  }, [isAnyDragActive, onDragActiveChange]);

  const connectedNodes = useMemo(() => {
    if (highlightedNodes.size === 0) {
      return new Set<string>();
    }

    const allConnectedNodes = new Set<string>();

    highlightedNodes.forEach((nodeId) => {
      // Add the selected node itself
      allConnectedNodes.add(nodeId);

      // Find the node's location and connections
      const nodeLocation = findNodeLocation(nodeId);
      if (nodeLocation) {
        const node = nodeLocation.node;

        // Add nodes that this node connects TO (outgoing connections)
        if (node.connections) {
          node.connections.forEach((conn) => allConnectedNodes.add(conn.targetId));
        } else if (node.connectionIds) {
          node.connectionIds.forEach((connId) => allConnectedNodes.add(connId));
        }
      }

      // Find nodes that connect TO this node (incoming connections)
      data.sections.forEach((section) => {
        section.columns.forEach((column) => {
          column.nodes.forEach((otherNode) => {
            if (otherNode.connections) {
              if (otherNode.connections.some((conn) => conn.targetId === nodeId)) {
                allConnectedNodes.add(otherNode.id);
              }
            } else if (otherNode.connectionIds) {
              if (otherNode.connectionIds.includes(nodeId)) {
                allConnectedNodes.add(otherNode.id);
              }
            }
          });
        });
      });
    });

    return allConnectedNodes;
  }, [highlightedNodes, data, findNodeLocation]);

  const hoveredConnections = useMemo(() => {
    if (!hoveredNode) return new Set<string>();

    const connections = new Set<string>();
    connections.add(hoveredNode);

    data.sections.forEach((section) => {
      section.columns.forEach((column) => {
        column.nodes.forEach((node) => {
          if (node.id === hoveredNode) {
            // Handle both old connectionIds and new connections format
            if (node.connections) {
              node.connections.forEach((conn) => connections.add(conn.targetId));
            } else {
              node.connectionIds.forEach((id) => connections.add(id));
            }
          }
          // Check if any connection points to the hovered node
          const hasConnectionTo = node.connections
            ? node.connections.some((conn) => conn.targetId === hoveredNode)
            : node.connectionIds.includes(hoveredNode);
          if (hasConnectionTo) {
            connections.add(node.id);
          }
        });
      });
    });

    return connections;
  }, [hoveredNode, data]);

  // Initialize keyboard shortcuts hook (side effects only — return value unused)
  useKeyboardShortcuts({
    data,
    setDataAndNotify,
    highlightedNodes,
    setHighlightedNodes,
    editMode,
    nodeRefs,
    setNodeWidth,
    setNodeColor,
    moveNodeVertically,
    nodeHeights,
  });

  // View mode shows the title block only when the chart has a title; edit
  // mode matches it, so an untitled chart gets no block (its "Click to
  // add title" prompt is an overlay) until the title starts being typed.
  const titleBlockShown = Boolean(data.title) || (editMode && editingTitle);

  const addColumn = (sectionIndex: number, at: number) => {
    setDataAndNotify((prevData) => insertColumn(prevData, sectionIndex, at));
  };

  const addSection = (at: number) => {
    setDataAndNotify((prevData) => insertSection(prevData, at));
  };

  // Add controls for the gap on a section's outer side(s): the chart's
  // outer edge before the first section and after the last, otherwise the
  // gap shared with the next section. Ordered left to right by what each
  // control adds.
  const renderSectionZones = (sectionIndex: number) => {
    const { sections } = data;
    const section = sections[sectionIndex];
    const lastColumnIndex = Math.max(0, section.columns.length - 1);
    const sectionControl = (at: number, title: string, testId: string): AddControl => ({
      kind: 'section',
      title,
      testId,
      onClick: () => addSection(at),
    });
    const endColumnControl: AddControl = {
      kind: 'column',
      towards: 'left',
      title: `Add a column at the end of "${section.title}"`,
      testId: `add-column-after-${sectionIndex}-${lastColumnIndex}`,
      onClick: () => addColumn(sectionIndex, section.columns.length),
    };
    const startColumnControl = (target: number): AddControl => ({
      kind: 'column',
      towards: 'right',
      title: `Add a column at the start of "${sections[target].title}"`,
      testId: `add-column-before-${target}-0`,
      onClick: () => addColumn(target, 0),
    });

    return (
      <>
        {sectionIndex === 0 && (
          <AddControlZone
            testId="add-zone-edge-start"
            edge="left"
            outerEdge
            width={CANVAS_EDGE_PX}
            zoomScale={zoomScale}
            controls={[
              sectionControl(0, 'Add a section at the start', 'add-section-before'),
              startColumnControl(0),
            ]}
          />
        )}
        {sectionIndex === sections.length - 1 ? (
          <AddControlZone
            testId="add-zone-edge-end"
            edge="right"
            outerEdge
            width={CANVAS_EDGE_PX}
            zoomScale={zoomScale}
            controls={[
              endColumnControl,
              sectionControl(
                sectionIndex + 1,
                'Add a section at the end',
                'add-section-after-last',
              ),
            ]}
          />
        ) : (
          <AddControlZone
            testId={`add-zone-section-gap-${sectionIndex}`}
            edge="right"
            width={sectionPadding}
            zoomScale={zoomScale}
            controls={[
              endColumnControl,
              sectionControl(sectionIndex + 1, 'Add a section here', 'add-section-before'),
              startColumnControl(sectionIndex + 1),
            ]}
          />
        )}
      </>
    );
  };

  return (
    // The canvas root: presses inside it are the ones the editors'
    // dismiss-click guard protects (see `editorSwitchTargets.ts`).
    <div className="flex flex-col" {...{ [CANVAS_DOM_ATTR]: '' }}>
      {/* Graph Title */}
      {titleBlockShown && (
        <div className="mb-6">
          {editMode && editingTitle ? (
            <input
              type="text"
              value={data.title || ''}
              // Streaming input (typing). Buffer per-keystroke under
              // 'graph-title'; commit once on blur / Enter so a single
              // editing pass produces one undo entry, not one per char.
              onChange={(e) => {
                const value = e.target.value;
                mutateDebounced((prev) => ({ ...prev, title: value }), 'graph-title');
              }}
              onBlur={() => {
                commitMutation('graph-title');
                setEditingTitle(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitMutation('graph-title');
                  setEditingTitle(false);
                }
              }}
              // `text-4xl` (2.25rem) replaced by an inline
              // `fontSize: textSize * 2.25rem` so the chart title scales
              // with the Format menu's text-size multiplier alongside
              // section + node titles. Each layer keeps its own base
              // size (chart 2.25rem > section 1.875rem > node 1.125rem)
              // so the visual hierarchy is preserved; textSize is a
              // global multiplier on top.
              className="font-bold text-center text-gray-800 tracking-wider w-full bg-transparent border-b-2 border-gray-400 outline-none focus:border-indigo-500"
              style={{
                fontFamily: fontFamily,
                fontSize: `${textSize * 2.25}rem`,
              }}
              autoFocus
            />
          ) : (
            <h1
              className={`font-bold text-center text-gray-800 tracking-wider ${editMode ? 'cursor-pointer hover:text-indigo-600 transition-colors' : ''}`}
              style={{
                fontFamily: fontFamily,
                fontSize: `${textSize * 2.25}rem`,
              }}
              onClick={() => editMode && setEditingTitle(true)}
              title={editMode ? 'Click to edit title' : ''}
            >
              {data.title}
            </h1>
          )}
        </div>
      )}

      <div
        ref={graphContainerRef}
        className="flex relative min-w-fit overflow-visible"
        style={{
          gap: `${sectionPadding}px`,
          width: svgSize.width > 0 ? `${svgSize.width}px` : 'auto',
          // In edit mode the container takes its height from content
          // (the section wrappers, whose column bodies carry the
          // explicit height below), so the add-control zones, which
          // stretch to their section, end at the canvas content edge.
          // View mode keeps the explicit height: its column bodies are
          // auto-height (nodes are absolutely positioned), so without
          // it the container — and the click-to-deselect area — would
          // collapse to the title bars.
          ...(editMode
            ? {}
            : {
                height: svgSize.height > 0 ? `${svgSize.height - 55}px` : '100vh', // I don't understand why I need to subtract 55, but it works
              }),
        }}
        onClick={(e) => {
          // Clear selections when clicking empty space in both view and edit mode
          if (e.target === e.currentTarget) {
            setHighlightedNodes(new Set());
            // Reset controls to default when clearing selection
            setNodeWidth(DEFAULT_NODE_WIDTH);
            setNodeColor('#ffffff');
          }
        }}
      >
        {/* Prompt for an untitled chart: a chip floating just above the
          canvas card, so view mode's layout is kept. It is sized in
          on-screen pixels (content pixels divided by the zoom) so it
          stays readable when the chart is zoomed out to fit. */}
        {editMode && !titleBlockShown && (
          <button
            type="button"
            data-export-exclude=""
            className="absolute left-1/2 whitespace-nowrap rounded-md border border-gray-300 bg-white px-2 py-1 text-gray-600 shadow-sm hover:border-indigo-300 hover:text-indigo-600 transition-colors"
            style={{
              bottom: `calc(100% + ${CANVAS_EDGE_PX + 6 / zoomScale}px)`,
              fontSize: 13,
              lineHeight: 1.2,
              transform: `translateX(-50%) scale(${1 / zoomScale})`,
              transformOrigin: 'bottom center',
            }}
            title="Click to edit title"
            onClick={() => setEditingTitle(true)}
          >
            Click to add title
          </button>
        )}

        {Array.isArray(data.sections) ? (
          data.sections.map((section, sectionIndex) => (
            <React.Fragment key={sectionIndex}>
              <div
                onClick={(e) => {
                  // Allow deselection by clicking section area in both view and edit mode
                  if (e.target === e.currentTarget) {
                    setHighlightedNodes(new Set());
                    setNodeWidth(DEFAULT_NODE_WIDTH);
                    setNodeColor('#ffffff');
                  }
                }}
              >
                <div className="flex">
                  {/* Section title positioned to center over actual columns */}
                  <div className="flex flex-col" data-section-index={sectionIndex}>
                    <div
                      className={clsx(
                        'rounded py-3 mb-2 px-3',
                        // PR 5 Task 5.3 + PR 7 task 8: `group/section
                        // relative` lives on the section *title bar*,
                        // not the outer column wrapper, so the section
                        // × reveals only when the title bar itself is
                        // hovered. Hovering inside a column does NOT
                        // light it up — CSS `:hover` bubbles through
                        // ancestors, so putting the group on the outer
                        // wrapper made every descendant-hover (every
                        // column, every node) also satisfy
                        // `.group/section:hover`. Title bar is the
                        // visually-obvious hover target for "delete
                        // this section".
                        editMode && 'group/section relative',
                      )}
                      style={{
                        backgroundColor: data.color || '#374151', // Default to gray-700
                        // The label sets the bar's width, but never less
                        // than the columns below it. While the label is
                        // being edited the bar keeps the width it had when
                        // the editor opened: the input's own intrinsic
                        // width would otherwise resize the whole section.
                        minWidth: `${sectionWidths[sectionIndex]}px`,
                        width:
                          editMode && editingSectionIndex === sectionIndex
                            ? `${editingBarWidth}px`
                            : 'max-content',
                      }}
                    >
                      {/* PR 5 Task 5.3: hover-revealed section delete
                        (bare trash glyph, light tone for the dark
                        title bar — issue 54). Visible only when the
                        title bar is hovered (via the parent's
                        `group/section` class). Click → React confirm
                        modal. */}
                      {editMode && (
                        <ColumnDeleteAffordance
                          nodeCount={section.columns.reduce(
                            (sum, col) => sum + col.nodes.length,
                            0,
                          )}
                          scope="section"
                          onDelete={() => deleteSection(sectionIndex)}
                          testIdSuffix={`${sectionIndex}`}
                        />
                      )}
                      {editMode && editingSectionIndex === sectionIndex ? (
                        <input
                          type="text"
                          value={section.title}
                          // Streaming input (typing). Buffer under
                          // 'section-N-title'; commit on blur/Enter so a
                          // single editing pass = one undo entry.
                          onChange={(e) => {
                            const value = e.target.value;
                            mutateDebounced(
                              (prev) => ({
                                ...prev,
                                sections: prev.sections.map((s, idx) =>
                                  idx === sectionIndex ? { ...s, title: value } : s,
                                ),
                              }),
                              `section-${sectionIndex}-title`,
                            );
                          }}
                          onBlur={() => {
                            commitMutation(`section-${sectionIndex}-title`);
                            setEditingSectionIndex(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              commitMutation(`section-${sectionIndex}-title`);
                              setEditingSectionIndex(null);
                            }
                          }}
                          // PR 7 task 15: keep section dimensions stable
                          // while editing the title.
                          //   - `w-full` (no HTML `size` attribute): the
                          //     input fills the title bar width — no
                          //     horizontal growth per character.
                          //   - `border-b-2 border-white/50` matches the
                          //     pre-PR-7 focus underline; the matching
                          //     h2 below carries `border-b-2
                          //     border-transparent` so the swap is
                          //     vertically identical (no height jump).
                          // PR 7 task 13: `text-3xl` (1.875rem) replaced
                          // by inline `fontSize: textSize * 1.875rem` so
                          // section titles scale with the Format menu's
                          // text-size setting (Tailwind text-* classes win
                          // over inline style, so the static class has to
                          // come off).
                          className="w-full font-bold text-center text-white uppercase bg-transparent border-b-2 border-white/50 outline-none focus:border-white"
                          style={{
                            fontFamily: fontFamily,
                            fontSize: `${textSize * 1.875}rem`,
                          }}
                          autoFocus
                        />
                      ) : (
                        <h2
                          // PR 7 task 15: the 2px transparent bottom
                          // border matches the input's `border-b-2`
                          // underline, so swapping between view and
                          // edit doesn't change the title row's height.
                          // PR 7 task 13: inline `fontSize` (see input
                          // comment above) so section titles scale.
                          className={`block w-full font-bold text-center text-white uppercase border-b-2 border-transparent ${editMode ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
                          style={{
                            fontFamily: fontFamily,
                            fontSize: `${textSize * 1.875}rem`,
                          }}
                          onClick={(e) => {
                            if (!editMode) return;
                            const bar = e.currentTarget.parentElement!;
                            setEditingBarWidth(bar.getBoundingClientRect().width / zoomScale);
                            setEditingSectionIndex(sectionIndex);
                          }}
                          title={editMode ? 'Click to edit section label' : ''}
                        >
                          {section.title}
                        </h2>
                      )}
                    </div>
                    <div
                      className={clsx('flex', editMode && 'relative')}
                      style={{
                        gap: `${columnPadding}px`,
                        justifyContent: 'center',
                      }}
                    >
                      {section.columns.map((column, colIndex) => (
                        <ColumnSlot key={`${sectionIndex}-${colIndex}`} editMode={editMode}>
                          {/* PR 5 Task 5.1: column body. No more
                            `layoutMode` red-state for empty columns
                            (delete-column moves to Task 5.3's hover-×
                            affordance). Empty columns simply render
                            with a `cell` cursor so the user knows
                            double-click adds a node at the cursor's
                            Y position (the existing behavior). */}
                          <div
                            data-column={`${sectionIndex}-${colIndex}`}
                            className={clsx(
                              'relative',
                              // PR 5 Task 5.3 + PR 7 task 8:
                              // `group/column` enables the *column* ×
                              // delete button's hover-reveal. Named
                              // group so hovering one column doesn't
                              // light up sibling columns' × buttons
                              // (or the surrounding section's ×).
                              editMode && 'group/column',
                              // CSS-hover affordance for empty-column
                              // body: `cursor-cell` signals "click here
                              // to drop a node". Pure CSS, no JS hover
                              // tracking.
                              editMode &&
                                column.nodes.length === 0 &&
                                'cursor-cell hover:bg-gray-500/5 transition-colors rounded-lg',
                            )}
                            style={{
                              width: `${columnWidth(column.nodes)}px`,
                              // Edit-mode bodies get an explicit height so the
                              // empty space under the nodes can be
                              // double-clicked to add one. 62 = section
                              // header budget; 80 = title block, when it
                              // takes space (ConnectionsComponent's
                              // updateSize adds the same 80, so body bottom
                              // and card bottom stay glued).
                              height: editMode
                                ? svgSize.height > 0
                                  ? `${svgSize.height - 62 - (titleBlockShown ? 80 : 0)}px`
                                  : '740px'
                                : 'auto',
                            }}
                            onClick={(e) => {
                              // Deselect nodes when clicking the
                              // column area (not a node inside it).
                              if (e.target === e.currentTarget) {
                                setHighlightedNodes(new Set());
                                setNodeWidth(DEFAULT_NODE_WIDTH);
                                setNodeColor('#ffffff');
                              }
                            }}
                            onDoubleClick={
                              editMode
                                ? (e) => {
                                    // Double-click in blank column
                                    // area → add a node at the
                                    // cursor's Y position.
                                    if (e.target === e.currentTarget) {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      const viewportY = e.clientY - rect.top;
                                      const localY = viewportY / zoomScale;
                                      createNewNode(sectionIndex, colIndex, localY);
                                    }
                                  }
                                : undefined
                            }
                          >
                            {column.nodes.map((node, nodeIndex) => {
                              const nodeWidth = node.width || DEFAULT_NODE_WIDTH;
                              const leftOffset = Math.max(
                                0,
                                (columnWidth(column.nodes) - nodeWidth) / 2,
                              );
                              // Cached measured height; 76px is the
                              // typical height for "New Node".
                              const nodeHeight = nodeHeights[node.id] || 76;

                              // While a drag previews this column, the nodes
                              // that make room render at their shifted
                              // centre. A transient override: the stored
                              // yPosition is not touched.
                              const previewCenterY =
                                dropPreview?.sectionIndex === sectionIndex &&
                                dropPreview.columnIndex === colIndex
                                  ? dropPreview.shifted.get(node.id)
                                  : undefined;
                              // Convert from center to top position. The
                              // stored center is clamped VISUALLY so
                              // out-of-range data (old charts, AI edits)
                              // renders inside the column body instead of
                              // over the section title bar (PR #34 fb 46).
                              const nodeTop =
                                (previewCenterY ??
                                  resolveNodeCenterY(node.yPosition, nodeIndex, nodeHeight)) -
                                nodeHeight / 2;

                              return (
                                <div
                                  key={node.id}
                                  className={clsx(
                                    'absolute',
                                    // Ease a node while it is shifted to
                                    // make room. `top` is what connections
                                    // measure, and their per-frame refresh
                                    // follows it. Only shifted nodes carry
                                    // the transition, so the rest of the
                                    // chart costs nothing extra per frame.
                                    previewCenterY !== undefined &&
                                      'transition-[top] duration-[120ms] ease-out motion-reduce:transition-none',
                                  )}
                                  style={{
                                    top: `${nodeTop}px`,
                                    left: `${leftOffset}px`,
                                    width: `${nodeWidth}px`,
                                  }}
                                >
                                  <NodeComponent
                                    node={node}
                                    updateNodeRef={updateNodeRef}
                                    isHighlighted={highlightedNodes.has(node.id)}
                                    isConnected={connectedNodes.has(node.id)}
                                    isHovered={hoveredNode === node.id}
                                    isDragging={dragState?.nodeId === node.id && dragState.hasMoved}
                                    toggleHighlight={toggleHighlight}
                                    setHoveredNode={setHoveredNode}
                                    hasHighlightedNodes={highlightedNodes.size > 0}
                                    onPointerDown={bindNodeDrag(node.id).onPointerDown}
                                    bindConnectionHandle={bindConnectionHandle}
                                    editMode={editMode}
                                    textSize={textSize}
                                    fontFamily={fontFamily}
                                  />
                                </div>
                              );
                            })}

                            {/* PR 5 Task 5.3: hover-revealed column
                              delete (bare trash glyph — issue 54).
                              Visible only on column hover via the
                              parent's `group/column` class. Click →
                              React confirm modal (NOT window.confirm). */}
                            {editMode && (
                              <ColumnDeleteAffordance
                                nodeCount={column.nodes.length}
                                scope="column"
                                onDelete={() => deleteColumn(sectionIndex, colIndex)}
                                testIdSuffix={`${sectionIndex}-${colIndex}`}
                              />
                            )}
                          </div>

                          {editMode && colIndex < section.columns.length - 1 && (
                            <AddControlZone
                              testId={`add-zone-column-gap-${sectionIndex}-${colIndex}`}
                              edge="right"
                              width={columnPadding}
                              zoomScale={zoomScale}
                              controls={[
                                {
                                  kind: 'column',
                                  title: 'Add a column here',
                                  testId: `add-column-after-${sectionIndex}-${colIndex}`,
                                  onClick: () => addColumn(sectionIndex, colIndex + 1),
                                },
                              ]}
                            />
                          )}
                        </ColumnSlot>
                      ))}
                      {editMode && renderSectionZones(sectionIndex)}
                    </div>
                  </div>
                </div>
              </div>
            </React.Fragment>
          ))
        ) : (
          <div className="flex items-center justify-center h-64 bg-red-50 border-2 border-red-200 rounded-lg">
            <div className="text-center">
              <div className="text-red-600 text-lg font-semibold mb-2">Data Error Detected</div>
              <div className="text-red-500 text-sm">
                The graph data structure has been corrupted. Please reload the page.
              </div>
            </div>
          </div>
        )}

        <ConnectionsComponent
          data={data}
          mutate={setDataAndNotify}
          mutateDebounced={mutateDebounced}
          commit={commitMutation}
          nodeRefs={nodeRefs}
          nodeHeights={nodeHeights}
          highlightedNodes={highlightedNodes}
          connectedNodes={connectedNodes}
          hoveredConnections={hoveredConnections}
          curvature={curvature}
          editMode={editMode}
          titleBlockShown={titleBlockShown}
          sectionWidths={sectionWidths}
          columnPadding={columnPadding}
          sectionPadding={sectionPadding}
          onSizeChange={(size) => {
            setSvgSize(size);
            onSizeChange?.(size);
          }}
          containerRef={graphContainerRef}
          camera={camera}
          fontFamily={fontFamily}
          bindWaypoint={waypointDrag.bindWaypoint}
          bindMidpoint={waypointDrag.bindMidpoint}
          bindPath={waypointDrag.bindPath}
          consumePathGestureArmed={waypointDrag.consumePathGestureArmed}
          resetWaypoints={waypointDrag.resetWaypoints}
          waypointDragState={waypointDrag.dragState}
        />

        {/* PR 3: only the alignment-suggestion banner remains in this
          overlay. The per-selection toolbar's width/color/delete
          controls moved into the anchored `<NodeEditor>` (mounted
          below alongside the selected node). The ShareDialog moved up
          to App.tsx in PR 2. */}
        {createPortal(
          <AlignmentSuggestionBanner
            editMode={editMode}
            showEditButton={showEditButton}
            data={data}
            straightenEdges={straightenEdges}
          />,
          document.body,
        )}

        {/* Connect Nodes Popup - shows when exactly 2 nodes are selected in edit mode */}
        {editMode &&
          highlightedNodes.size === 2 &&
          (() => {
            const nodeIds = Array.from(highlightedNodes);
            const [sourceId, targetId] = nodeIds;

            // This component will continuously update position during interactions
            const ConnectButton = () => {
              const [position, setPosition] = useState({ x: 0, y: 0 });
              const positionCalculatedRef = useRef(false);

              // Calculate position only once per button instance
              useEffect(() => {
                // Only calculate once per button pair
                if (positionCalculatedRef.current) {
                  return;
                }

                const sourceNodeRef = nodeRefs[sourceId];
                const targetNodeRef = nodeRefs[targetId];

                if (!sourceNodeRef || !targetNodeRef) {
                  return;
                }

                const container =
                  graphContainerRef.current || sourceNodeRef.closest('.flex.relative');
                if (!container) {
                  return;
                }

                const sourcePos = getLocalPosition(sourceNodeRef, container as HTMLElement);
                const targetPos = getLocalPosition(targetNodeRef, container as HTMLElement);

                // Check if nodes are in the same column for vertical connections
                const sourceLocation = findNodeLocation(sourceId);
                const targetLocation = findNodeLocation(targetId);
                const isSameColumn =
                  sourceLocation &&
                  targetLocation &&
                  sourceLocation.sectionIndex === targetLocation.sectionIndex &&
                  sourceLocation.columnIndex === targetLocation.columnIndex;

                // Check if this is a backward connection (right to left)
                const isBackwardConnection =
                  !isSameColumn &&
                  sourceLocation &&
                  targetLocation &&
                  (targetLocation.sectionIndex < sourceLocation.sectionIndex ||
                    (targetLocation.sectionIndex === sourceLocation.sectionIndex &&
                      targetLocation.columnIndex < sourceLocation.columnIndex));

                let startX, startY, endX, endY;

                if (isSameColumn) {
                  // Vertical connection logic (using local coordinates)
                  startX = sourcePos.x + sourcePos.width / 2;
                  endX = targetPos.x + targetPos.width / 2;

                  if (sourcePos.y < targetPos.y) {
                    startY = sourcePos.y + sourcePos.height;
                    endY = targetPos.y - 14;
                  } else {
                    startY = sourcePos.y;
                    endY = targetPos.y + targetPos.height + 14;
                  }
                } else if (isBackwardConnection) {
                  // Backward connection logic (right to left)
                  startX = sourcePos.x; // Start from left side of source node
                  startY = sourcePos.y + sourcePos.height / 2;
                  endX = targetPos.x + targetPos.width + 14; // End at right side of target node with arrow offset
                  endY = targetPos.y + targetPos.height / 2;
                } else {
                  // Forward connection logic (left to right)
                  startX = sourcePos.x + sourcePos.width;
                  startY = sourcePos.y + sourcePos.height / 2;
                  endX = targetPos.x - 14;
                  endY = targetPos.y + targetPos.height / 2;
                }

                // Position at midpoint
                const midX = (startX + endX) / 2;
                const midY = (startY + endY) / 2;

                setPosition({ x: midX, y: midY });
                positionCalculatedRef.current = true; // Mark as calculated
                // sourceId/targetId are local consts captured by closure, not
                // reactive values — this component is re-created each parent
                // render when highlightedNodes flips, so the closure is fresh.
              }, []);

              // Reset calculation flag when nodes change
              useEffect(() => {
                positionCalculatedRef.current = false;
              }, []);

              const isConnected = areNodesConnected(sourceId, targetId);

              return (
                <div
                  className="absolute z-50 p-3 pointer-events-none"
                  data-export-exclude=""
                  style={{
                    left: `${position.x}px`,
                    top: `${position.y}px`,
                    transform: 'translate(-50%, -50%)',
                  }}
                >
                  <div className="pointer-events-auto">
                    {isConnected ? (
                      <button
                        onClick={disconnectSelectedNodes}
                        className="flex items-center justify-center w-6 h-6 bg-white text-gray-600 hover:text-red-600 rounded-full border border-gray-300 hover:border-red-300 transition-colors shadow-sm"
                        title="Disconnect nodes"
                      >
                        <MinusIcon className="w-4 h-4" />
                      </button>
                    ) : (
                      <button
                        onClick={connectSelectedNodes}
                        className="flex items-center justify-center w-6 h-6 bg-white text-gray-600 hover:text-gray-800 rounded-full border border-gray-300 hover:border-gray-400 transition-colors shadow-sm"
                        title="Connect nodes"
                      >
                        <PlusIcon className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            };

            return <ConnectButton />;
          })()}

        {/* The connection-strength Legend is no longer rendered here
          (PR #34 round-7 feedback 76): it's view-mode chrome now,
          mounted by `ToCViewerOnly` OUTSIDE the zoom/pan transform so
          it neither scales with zoom nor covers canvas content. The
          editor surface gets no legend at all — editors read
          confidence numerically in the EdgeEditor. */}

        {/* Anchored NodeEditor — replaces NodePopup (modal) and the
          per-selection toolbar. Single-click on a node opens it; it
          stays anchored beside the first selected node across pan,
          zoom, and DOM reflow via `useAnchorPosition`. */}
        {editMode && highlightedNodes.size > 0 && (
          <NodeEditorMount
            highlightedNodes={highlightedNodes}
            nodeRefs={nodeRefs}
            data={data}
            mutate={setDataAndNotify}
            mutateDebounced={mutateDebounced}
            commit={commitMutation}
            camera={camera ?? { x: 0, y: 0, z: 1 }}
            onRequestClose={() => setHighlightedNodes(new Set())}
            registerOnDragStartedElsewhere={(cb) => {
              nodeEditorDragStartRef.current = cb;
            }}
            fontFamily={fontFamily}
          />
        )}

        {/* Landing indicator: the tinted gutter a new column would be
            inserted into. Over a column body nothing is drawn here; the
            dragged node's copy snaps into place instead (below). Absent
            unless a drag has left the tap dead-zone. */}
        {dragState ? (
          <DropLandingIndicator
            indicator={computeLandingIndicator({ dragState, snapshot: getSnapshot() })}
            zoomScale={zoomScale}
          />
        ) : null}

        {/* PR 4 + PR 7 feedback (#3): the dragged node's copy, a visual
            clone of it. Renders the actual title/color/size/font so the
            user is looking at the same thing they grabbed (with reduced
            opacity). The original node still renders at half opacity in
            place via NodeComponent's `isDragging` prop above (visual
            anchor for the source location). There is no separate
            drop-preview silhouette, which confused reviewers about which
            shape was the node.

            Over a column the copy snaps into it, centred and at the exact
            height the drop will place the node (`dropPreview`); anywhere
            else it follows the cursor. The copy sits in the same transform
            stack as the canvas so it translates with pan/zoom.

            Two nested elements keep the axes separate: the outer one carries
            the vertical position (`top`, never transitioned, so the copy
            tracks the pointer's vertical moves without lag) and the inner
            one the horizontal position as a transform. Only while snapped
            does the inner one glide, so the jump between columns is
            softened but the cursor-following copy is never delayed. */}
        {dragState && dragState.hasMoved && graphContainerRef.current
          ? (() => {
              const draggedLoc = findNodeLocation(dragState.nodeId);
              if (!draggedLoc) return null;
              const draggedNode = draggedLoc.node;

              // Follow the cursor: translate ghostPos (viewport coords) to
              // container-local so the absolute-positioned copy lines up
              // with the canvas geometry. The cursor offset within the
              // node is preserved (the grab point stays under the finger
              // / mouse).
              const containerRect = graphContainerRef.current.getBoundingClientRect();
              const localX = (dragState.ghostPos.x - containerRect.left) / zoomScale;
              const localY = (dragState.ghostPos.y - containerRect.top) / zoomScale;
              const offsetXLocal = dragState.pointerOffset.x / zoomScale;
              const offsetYLocal = dragState.pointerOffset.y / zoomScale;
              const ghostWidth = dragState.nodeSize.width;
              const copyLeft = dropPreview ? dropPreview.copy.left : localX - offsetXLocal;
              const copyTop = dropPreview ? dropPreview.copy.top : localY - offsetYLocal;
              return (
                <div
                  className="pointer-events-none absolute left-0 z-[60] opacity-50"
                  style={{ top: `${copyTop}px` }}
                  aria-hidden
                  data-testid="node-drag-ghost"
                >
                  <div
                    className={
                      dropPreview
                        ? 'transition-transform duration-[90ms] ease-out motion-reduce:transition-none'
                        : undefined
                    }
                    style={{
                      transform: `translateX(${copyLeft}px)`,
                      width: `${ghostWidth}px`,
                    }}
                  >
                    {/* Mirrors NodeComponent's visual chrome (sans
                        interactive bits — no ring, no hover scale, no
                        connection handles). The copy is a pure visual
                        duplicate so the user sees the exact node they're
                        dragging, only translucent. */}
                    <div
                      className="flex flex-col border-0 rounded-xl shadow-[0_10px_15px_-3px_rgba(0,0,0,0.3),_0_4px_6px_-2px_rgba(0,0,0,0.15)] pt-3 px-3 pb-6 select-none"
                      style={{
                        backgroundColor: draggedNode.color || '#ffffff',
                      }}
                    >
                      <div className="flex flex-col justify-center relative py-2">
                        <div
                          className="font-medium text-center leading-tight break-words"
                          style={{
                            fontSize: `${textSize * 1.125}rem`,
                            fontFamily: fontFamily,
                            color: draggedNode.color
                              ? getContrastTextColor(draggedNode.color)
                              : '#000000',
                          }}
                        >
                          {draggedNode.title}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()
          : null}

        {/* PR 5 Task 5.2: drag-to-connect in-flight ghost line. Renders
            an SVG path from the source handle's node edge to the
            cursor (or to the hovered target node's opposite edge).
            Shares the cubic-bezier math with the select-2 ghost via
            `buildConnectionPath`. The SVG covers the container so the
            single path positions in container-local coords. */}
        {connectionDragState && graphContainerRef.current
          ? (() => {
              const containerRect = graphContainerRef.current.getBoundingClientRect();
              const sourceEl = nodeRefs[connectionDragState.sourceNodeId];
              if (!sourceEl) return null;
              const sourcePos = getLocalPosition(sourceEl, graphContainerRef.current);
              // Start at the source node's left or right edge midpoint.
              const startX =
                connectionDragState.sourceSide === 'left'
                  ? sourcePos.x
                  : sourcePos.x + sourcePos.width;
              const startY = sourcePos.y + sourcePos.height / 2;

              // End at the target node's opposite edge (if hovered),
              // else at the cursor. The cursor branch translates
              // viewport coords to container-local via zoom.
              let endX: number;
              let endY: number;
              const targetId = connectionDragState.targetNodeId;
              const targetEl = targetId ? nodeRefs[targetId] : null;
              if (targetEl && graphContainerRef.current) {
                const tPos = getLocalPosition(targetEl, graphContainerRef.current);
                // Snap to the side facing the source so the ghost
                // doesn't cross the target node.
                if (
                  connectionDragState.sourceSide === 'right' &&
                  tPos.x >= sourcePos.x + sourcePos.width
                ) {
                  endX = tPos.x - 6;
                } else if (
                  connectionDragState.sourceSide === 'left' &&
                  tPos.x + tPos.width <= sourcePos.x
                ) {
                  endX = tPos.x + tPos.width + 6;
                } else {
                  // Mismatched side; just snap to the nearest edge.
                  const sourceMid = startX;
                  endX = tPos.x + tPos.width / 2 < sourceMid ? tPos.x + tPos.width + 6 : tPos.x - 6;
                }
                endY = tPos.y + tPos.height / 2;
              } else {
                endX = (connectionDragState.ghostPos.x - containerRect.left) / zoomScale;
                endY = (connectionDragState.ghostPos.y - containerRect.top) / zoomScale;
              }

              // 'forward' if cursor is right of source, else 'backward'.
              const direction = endX >= startX ? 'forward' : 'backward';
              const ghostPathD = buildConnectionPath({
                startX,
                startY,
                endX,
                endY,
                curvature,
                direction,
              });
              // SVG canvas sized to the container; the path coords are
              // in container-local space so they line up with nodes.
              const w = graphContainerRef.current.offsetWidth || svgSize.width;
              const h = graphContainerRef.current.offsetHeight || svgSize.height;
              return (
                <svg
                  className="pointer-events-none absolute inset-0 z-[59]"
                  width={w}
                  height={h}
                  aria-hidden
                  data-testid="connection-drag-ghost"
                >
                  <path
                    d={ghostPathD}
                    className="fill-none stroke-indigo-500"
                    style={{
                      strokeWidth: '2px',
                      strokeDasharray: '6 4',
                      opacity: 0.7,
                    }}
                  />
                </svg>
              );
            })()
          : null}
      </div>
    </div>
  );
}

/**
 * `NodeEditorMount` — internal wrapper that picks the anchor element
 * from `nodeRefs` based on the first selected node id. Lifting this
 * out of the main render lets us keep the ref hand-off purely inside
 * the editor render path and avoids re-deriving the anchor on every
 * parent render.
 */
function NodeEditorMount({
  highlightedNodes,
  nodeRefs,
  data,
  mutate,
  mutateDebounced,
  commit,
  camera,
  onRequestClose,
  registerOnDragStartedElsewhere,
  fontFamily,
}: {
  highlightedNodes: Set<string>;
  nodeRefs: { [key: string]: HTMLDivElement | null };
  data: ToCData;
  mutate: (updater: ToCData | ((prev: ToCData) => ToCData)) => void;
  mutateDebounced: (updater: ToCData | ((prev: ToCData) => ToCData), key: string) => void;
  commit: (key?: string) => void;
  camera: { x: number; y: number; z: number };
  onRequestClose: () => void;
  /**
   * PR 4 seam: NodeEditor calls this once on mount with its dismiss
   * callback. The parent (TheoryOfChangeGraph) stores it in a ref the
   * `usePointerDrag` hook reads on `onDragStart`.
   */
  registerOnDragStartedElsewhere?: (cb: () => void) => void;
  fontFamily?: string;
}) {
  const selectedIds = Array.from(highlightedNodes);
  // Sort the array so the anchor is stable across additions to the
  // selection (e.g. Cmd+click extending the set). Without sort the
  // first-id flips depending on Set iteration order.
  const sorted = [...selectedIds].sort();
  const anchorId = sorted[0];
  const anchorRef = useRef<HTMLElement | null>(null);
  // Keep the ref pointed at the anchor's DOM node. This re-runs every
  // render but is cheap (a single object property assignment).
  anchorRef.current = anchorId ? (nodeRefs[anchorId] ?? null) : null;

  if (!anchorRef.current) return null;

  return (
    <NodeEditor
      selectedNodeIds={selectedIds}
      data={data}
      mutate={mutate}
      mutateDebounced={mutateDebounced}
      commit={commit}
      anchorRef={anchorRef}
      camera={camera}
      onRequestClose={onRequestClose}
      registerOnDragStartedElsewhere={registerOnDragStartedElsewhere}
      fontFamily={fontFamily}
    />
  );
}
