import clsx from 'clsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ToCData, Node } from '../types';
import { NodeComponent } from './NodeComponent';
import { ConnectionsComponent } from './ConnectionsComponent';
import { AlignmentSuggestionBanner } from './AlignmentSuggestionBanner';
import { Legend } from './Legend';
import { NodeEditor } from './node-editor/NodeEditor';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useGraphLayout, getLocalPosition } from '../hooks/useGraphLayout';
import { useGraphMutation } from '../hooks/useGraphMutation';
import { usePointerDrag } from '../hooks/usePointerDrag';
import type { DragOverLocation } from '../hooks/usePointerDrag';
import { useConnectionDrag } from '../hooks/useConnectionDrag';
import { buildConnectionPath } from './canvas/connectionPath';
import { ColumnDeleteAffordance } from './canvas/ColumnDeleteAffordance';
import { PlusIcon, MinusIcon } from '@heroicons/react/24/outline';

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
  // PR 4: legacy `draggedNode`, `dragOffset`, `dragOverLocation` state
  // retired — `usePointerDrag` now owns drag state internally and
  // returns `dragState` (or null). The hook is wired below after
  // `useGraphLayout` (it needs the snapshot accessor).
  // editMode/layoutMode setters dropped along with the inline
  // EditToolbar mode toggle — the canvas still reads the state but no
  // longer needs to flip it from inside.
  const [editMode] = useState(showEditButton);
  const [layoutMode] = useState(false);
  const [curvature, setCurvature] = useState(initialData.curvature ?? 0.5);
  const [textSize, setTextSize] = useState(initialData.textSize ?? 1); // 0.5 to 2.0 scale
  const [fontFamily, setFontFamily] = useState(initialData.fontFamily ?? "'Ubuntu', sans-serif"); // Default font family
  const [nodeWidth, setNodeWidth] = useState(192); // Default width in pixels (w-48)
  const [nodeColor, setNodeColor] = useState('#ffffff'); // Default white background
  const [columnPadding, setColumnPadding] = useState(initialData.columnPadding ?? 24); // Default column padding in pixels
  const [sectionPadding, setSectionPadding] = useState(initialData.sectionPadding ?? 32); // Default section padding in pixels
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingSectionIndex, setEditingSectionIndex] = useState<number | null>(null);
  // PR 3: `editingNodeId` / `nodePopup` / `edgePopup` state retired —
  // node editing now lives in the anchored `<NodeEditor>` (mounted
  // alongside the selected node) and edge editing in `<EdgeEditor>`
  // (owned by `ConnectionsComponent`'s `selectedEdge` state).
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });
  const [legendPosition, setLegendPosition] = useState({ x: 340, y: 70 });
  const [isDraggingLegend, setIsDraggingLegend] = useState(false);
  const [legendDragOffset, setLegendDragOffset] = useState({ x: 0, y: 0 });
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

  const recalculateAllNodeHeights = useCallback(() => {
    // Force recalculation of all node heights
    setTimeout(() => {
      Object.entries(nodeRefs).forEach(([nodeId, ref]) => {
        if (ref) {
          const height = ref.offsetHeight;
          setNodeHeights((prev) => ({ ...prev, [nodeId]: height }));
        }
      });
    }, 50); // Slightly longer delay to ensure DOM updates
  }, [nodeRefs]);

  const handleLegendMouseMove = useCallback(
    (e: MouseEvent) => {
      if (isDraggingLegend) {
        setLegendPosition({
          x: e.clientX - legendDragOffset.x,
          y: e.clientY - legendDragOffset.y,
        });
      }
    },
    [isDraggingLegend, legendDragOffset],
  );

  const handleLegendMouseUp = useCallback(() => {
    setIsDraggingLegend(false);
  }, []);

  useEffect(() => {
    if (isDraggingLegend) {
      document.addEventListener('mousemove', handleLegendMouseMove);
      document.addEventListener('mouseup', handleLegendMouseUp);
      return () => {
        document.removeEventListener('mousemove', handleLegendMouseMove);
        document.removeEventListener('mouseup', handleLegendMouseUp);
      };
    }
  }, [isDraggingLegend, handleLegendMouseMove, handleLegendMouseUp]);

  // Update internal data state when prop changes
  useEffect(() => {
    console.log('ToC component received new initialData:', initialData);
    setData(initialData);
    // Recalculate node heights when data changes (e.g., from AI edits)
    recalculateAllNodeHeights();
  }, [initialData, recalculateAllNodeHeights, setData]);

  // Update settings when data changes
  useEffect(() => {
    if (initialData.textSize !== undefined) {
      setTextSize(initialData.textSize);
    }
    if (initialData.curvature !== undefined) {
      setCurvature(initialData.curvature);
    }
    if (initialData.columnPadding !== undefined) {
      setColumnPadding(initialData.columnPadding);
    }
    if (initialData.sectionPadding !== undefined) {
      setSectionPadding(initialData.sectionPadding);
    }
    if (initialData.fontFamily !== undefined) {
      setFontFamily(initialData.fontFamily);
    }
  }, [
    initialData.textSize,
    initialData.curvature,
    initialData.columnPadding,
    initialData.sectionPadding,
    initialData.fontFamily,
  ]);

  // Position legend in bottom-right corner when svgSize changes
  useEffect(() => {
    if (svgSize.width > 0 && svgSize.height > 0) {
      setLegendPosition({
        x: svgSize.width - 158, // 153px from right edge
        y: svgSize.height - 178, // 178px from bottom edge
      });
    }
  }, [svgSize.width, svgSize.height]);

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
        const columnNodeWidths = column.nodes.map((node) => node.width || 192);
        newNodeWidth = Math.max(...columnNodeWidths);
      }

      // yPosition is where the user clicked - this becomes the center Y of the node
      const newNode: Node = {
        id: generateNodeId(),
        title: 'New Node',
        text: 'Details of New Node.',
        connectionIds: [],
        connections: [],
        yPosition: yPosition, // Click position = center Y
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
              const currentWidth = node.width || 192;
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
              const currentWidth = node.width || 192;
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
              const currentWidth = node.width || 192;
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

                // Calculate current center Y position
                const defaultCenterY = nodeIndex * 180 + 30 + actualHeight / 2;
                const currentCenterY = node.yPosition ?? defaultCenterY;
                return { ...node, yPosition: currentCenterY + moveAmount };
              }
              return node;
            }),
          })),
        })),
      }));
    },
    [setDataAndNotify, nodeHeights],
  );

  const straightenEdges = useCallback(() => {
    if (!editMode) return;

    setDataAndNotify((prevData) => {
      // Collect all nodes with their actual center positions
      const allNodes: {
        node: Node;
        sectionIndex: number;
        columnIndex: number;
        nodeIndex: number;
        centerY: number;
        topY: number;
        height: number;
      }[] = [];

      prevData.sections.forEach((section, sectionIndex) => {
        section.columns.forEach((column, columnIndex) => {
          column.nodes.forEach((node, nodeIndex) => {
            // Use cached height or default
            const actualHeight = nodeHeights[node.id] || 76;

            // yPosition now represents the center Y
            const centerY = node.yPosition ?? nodeIndex * 180 + 30 + actualHeight / 2;
            const topY = centerY - actualHeight / 2;
            allNodes.push({
              node,
              sectionIndex,
              columnIndex,
              nodeIndex,
              centerY,
              topY,
              height: actualHeight,
            });
          });
        });
      });

      // Group nodes by similar center Y positions.
      const groups: (typeof allNodes)[] = [];
      const tolerance = 40;

      allNodes.forEach((nodeData) => {
        let addedToGroup = false;
        for (const group of groups) {
          const avgCenterY = group.reduce((sum, n) => sum + n.centerY, 0) / group.length;
          if (Math.abs(nodeData.centerY - avgCenterY) <= tolerance) {
            group.push(nodeData);
            addedToGroup = true;
            break;
          }
        }
        if (!addedToGroup) {
          groups.push([nodeData]);
        }
      });

      // Calculate the average center Y position for each group and update nodes
      const newData = { ...prevData };
      groups.forEach((group) => {
        if (group.length > 1) {
          // Only straighten groups with multiple nodes
          const avgCenterY = Math.round(
            group.reduce((sum, n) => sum + n.centerY, 0) / group.length,
          );

          group.forEach(({ sectionIndex, columnIndex, nodeIndex }) => {
            const node = newData.sections[sectionIndex].columns[columnIndex].nodes[nodeIndex];
            // yPosition now represents the center Y, so set it directly
            newData.sections[sectionIndex].columns[columnIndex].nodes[nodeIndex] = {
              ...node,
              yPosition: avgCenterY,
            };
          });
        }
      });

      return newData;
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
    editMode,
    layoutMode,
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
    setNodeWidth(192);
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
    setNodeWidth(192);
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
      // `target.yPosition` (node-slot only) is container-local; the
      // hook already divided by zoomScale. `pointerOffset.y` is
      // viewport-space (captured at drag-start with no zoom applied);
      // divide by zoomScale to put both in the same coord system before
      // subtracting. Other variants (over-node / new-column) fall back
      // to the slot-center default.
      let adjustedYPosition = 20;
      if (target.kind === 'node-slot') {
        const mouseLocalY = target.yPosition;
        const dragOffsetLocalY = pointerOffset.y / zoomScale;
        const nodeTopLocal = mouseLocalY - dragOffsetLocalY;
        const actualHeight = nodeHeights[draggedNodeId] || 76;
        adjustedYPosition = nodeTopLocal + actualHeight / 2;
      }

      console.log('Moving node', draggedNodeId, 'from', sourceLocation, 'to', {
        targetSectionIndex,
        targetColumnIndex,
        isNewColumn,
        yPosition: adjustedYPosition,
      });

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

        // Same-column move: in-place yPosition update only.
        if (
          !isNewColumn &&
          sourceLocation.sectionIndex === targetSectionIndex &&
          sourceLocation.columnIndex === targetColumnIndex
        ) {
          return {
            ...prevData,
            sections: prevData.sections.map((section, sIndex) =>
              sIndex === targetSectionIndex
                ? {
                    ...section,
                    columns: section.columns.map((column, cIndex) =>
                      cIndex === targetColumnIndex
                        ? {
                            ...column,
                            nodes: column.nodes.map((node) =>
                              node.id === draggedNodeId
                                ? { ...node, yPosition: adjustedYPosition }
                                : node,
                            ),
                          }
                        : column,
                    ),
                  }
                : section,
            ),
          };
        }

        // Cross-column / cross-section move: remove from source, add to target.
        const newData = { ...prevData };
        newData.sections = prevData.sections.map((section) => ({
          ...section,
          columns: section.columns.map((column) => ({
            ...column,
            nodes: column.nodes.filter((node) => node.id !== draggedNodeId),
          })),
        }));

        if (isNewColumn) {
          const targetSection = newData.sections[targetSectionIndex];
          const newColumn = { nodes: [{ ...sourceNode, yPosition: adjustedYPosition }] };
          targetSection.columns.splice(targetColumnIndex, 0, newColumn);
        } else {
          const nodeWithPosition = { ...sourceNode, yPosition: adjustedYPosition };
          newData.sections[targetSectionIndex].columns[targetColumnIndex].nodes.push(
            nodeWithPosition,
          );
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
    onDragStart: () => {
      // Notify the anchored NodeEditor to dismiss (if mounted).
      nodeEditorDragStartRef.current?.();
    },
  });

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
    containerRef: graphContainerRef,
    editMode,
    onConnect: addConnection,
  });

  // Notify parent (App) of drag-active transitions so the 30s sync
  // poll can pause while a gesture is in flight (red-team Important).
  // We OR-combine the node-drag and connection-drag flags so either
  // gesture pauses polling.
  //
  // Cleanup fires `false` if this component unmounts while a drag is
  // active — otherwise the parent's `isDragInFlightRef` stays `true`
  // for the rest of the App's lifetime (the polling effect would
  // silently skip every sync tick).
  const isAnyDragActive = isDragActive || isConnectionDragActive;
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

  return (
    <div className="flex flex-col">
      {/* Graph Title */}
      {(data.title || editMode) && (
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
              className="text-4xl font-bold text-center text-gray-800 tracking-wider w-full bg-transparent border-b-2 border-gray-400 outline-none focus:border-indigo-500"
              style={{ fontFamily: fontFamily }}
              autoFocus
            />
          ) : (
            <h1
              className={`text-4xl font-bold text-center text-gray-800 tracking-wider ${editMode ? 'cursor-pointer hover:text-indigo-600 transition-colors' : ''}`}
              style={{ fontFamily: fontFamily }}
              onClick={() => editMode && setEditingTitle(true)}
              title={editMode ? 'Click to edit title' : ''}
            >
              {data.title || (editMode ? 'Click to add title' : '')}
            </h1>
          )}
        </div>
      )}

      <div
        ref={graphContainerRef}
        className="flex relative min-w-fit overflow-visible"
        style={{
          // PR 5: add affordances (column-gutter "+ Column" and
          // section-padding "+ Section") are always rendered in edit
          // mode now (no `layoutMode` gate). They provide the
          // inter-column / inter-section spacing themselves, so the
          // parent flex `gap` collapses to 0 in edit mode. View mode
          // keeps the explicit gap (no gutter divs render).
          gap: editMode ? '0px' : `${sectionPadding}px`,
          width: svgSize.width > 0 ? `${svgSize.width}px` : 'auto',
          height: svgSize.height > 0 ? `${svgSize.height - 55}px` : '100vh', // I don't understand why I need to subtract 55, but it works
        }}
        onClick={(e) => {
          // Clear selections when clicking empty space in both view and edit mode
          if (e.target === e.currentTarget) {
            setHighlightedNodes(new Set());
            // Reset controls to default when clearing selection
            setNodeWidth(192);
            setNodeColor('#ffffff');
          }
        }}
      >
        {/* Empty state message - show when there are no nodes */}
        {Array.isArray(data.sections) &&
          data.sections.every(
            (s) => s.columns && s.columns.every((c) => !c.nodes || c.nodes.length === 0),
          ) && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="text-gray-300 text-5xl font-light" style={{ fontFamily: fontFamily }}>
                Double Click Anywhere to Add a Node
              </div>
            </div>
          )}

        {Array.isArray(data.sections) ? (
          data.sections.map((section, sectionIndex) => (
            <React.Fragment key={sectionIndex}>
              {/* PR 5 Task 5.1: always-on add-section affordance. The
                gutter is rendered in edit mode regardless of layout
                state. Default: minimal visual treatment (no background
                tint, label hidden). Hover: translucent green tint plus
                "+ Section" label. Click adds a section before this
                index. The 32px width comes from `sectionPadding`. */}
              {editMode && (
                <div
                  className="group flex items-center justify-center cursor-pointer rounded-lg transition-colors hover:bg-green-500/20"
                  style={{
                    width: `${sectionPadding}px`,
                    height: svgSize.height > 0 ? `${svgSize.height - 124}px` : '740px',
                    marginTop: '68px',
                  }}
                  onClick={() => {
                    setDataAndNotify((prevData) => {
                      const newData = { ...prevData };
                      newData.sections.splice(sectionIndex, 0, {
                        title: 'New Section',
                        columns: [{ nodes: [] }],
                      });
                      return newData;
                    });
                  }}
                  title="Click to add section"
                  data-testid="add-section-before"
                >
                  <span className="text-green-600 text-xs font-medium rotate-90 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
                    + Section
                  </span>
                </div>
              )}
              <div
                onClick={(e) => {
                  // Allow deselection by clicking section area in both view and edit mode
                  if (e.target === e.currentTarget) {
                    setHighlightedNodes(new Set());
                    setNodeWidth(192);
                    setNodeColor('#ffffff');
                  }
                }}
              >
                <div className="flex">
                  {/* Section title positioned to center over actual columns */}
                  <div
                    className={clsx(
                      'flex flex-col',
                      // PR 5 Task 5.3: `group relative` enables the
                      // child × delete button's hover-reveal anywhere
                      // inside the section.
                      editMode && 'group relative',
                    )}
                    data-section-index={sectionIndex}
                  >
                    {/* PR 5 Task 5.3: hover-× section delete.
                      Visible only when the section is hovered (via
                      the parent's `group` class). Click → React
                      confirm modal. */}
                    {editMode && (
                      <ColumnDeleteAffordance
                        nodeCount={section.columns.reduce((sum, col) => sum + col.nodes.length, 0)}
                        scope="section"
                        onDelete={() => deleteSection(sectionIndex)}
                        testIdSuffix={`${sectionIndex}`}
                      />
                    )}
                    <div
                      className="rounded py-3 mb-2 px-3"
                      style={{
                        backgroundColor: data.color || '#374151', // Default to gray-700
                        // PR 5: section title width must account for the
                        // always-on column gutters in edit mode (N+1
                        // gutters around N columns, each `columnPadding`
                        // wide). View mode renders no gutters.
                        minWidth: `${sectionWidths[sectionIndex] + (editMode ? (section.columns.length + 1) * columnPadding : 0)}px`,
                        width: 'max-content',
                      }}
                    >
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
                          className="text-3xl font-bold text-center text-white uppercase bg-transparent border-b-2 border-white/50 outline-none focus:border-white"
                          style={{ fontFamily: fontFamily }}
                          size={section.title.length || 1}
                          autoFocus
                        />
                      ) : (
                        <h2
                          className={`text-3xl font-bold text-center text-white uppercase ${editMode ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
                          style={{ fontFamily: fontFamily }}
                          onClick={() => editMode && setEditingSectionIndex(sectionIndex)}
                          title={editMode ? 'Click to edit section label' : ''}
                        >
                          {section.title}
                        </h2>
                      )}
                    </div>
                    <div
                      className="flex"
                      style={{
                        // PR 5: same `gap`-collapses-to-0 rationale as
                        // the outer section flex above. Column gutters
                        // provide spacing in edit mode; view mode falls
                        // back to the explicit gap.
                        gap: editMode ? '0px' : `${columnPadding}px`,
                        justifyContent: 'center',
                      }}
                    >
                      {section.columns.map((column, colIndex) => (
                        <React.Fragment key={`${sectionIndex}-${colIndex}`}>
                          {/* PR 5 Task 5.1: always-on add-column
                            affordance (left gutter before first
                            column). Same minimal-default / hover-
                            translucent-blue treatment as the section
                            gutter above; `+ Column` label fades in
                            on hover. */}
                          {editMode && colIndex === 0 && (
                            <div
                              className="group flex items-center justify-center cursor-pointer rounded-lg transition-colors hover:bg-blue-500/20"
                              style={{
                                width: `${columnPadding}px`,
                                height: svgSize.height > 0 ? `${svgSize.height - 124}px` : '740px',
                              }}
                              onClick={() => {
                                setDataAndNotify((prevData) => {
                                  const newData = { ...prevData };
                                  newData.sections[sectionIndex].columns.splice(0, 0, {
                                    nodes: [],
                                  });
                                  return newData;
                                });
                              }}
                              title="Click to add column"
                              data-testid={`add-column-before-${sectionIndex}-${colIndex}`}
                            >
                              <span className="text-blue-600 text-xs font-medium rotate-90 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
                                + Column
                              </span>
                            </div>
                          )}

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
                              // PR 5 Task 5.3: `group` enables the
                              // child × delete button's hover-reveal.
                              editMode && 'group',
                              // CSS-hover affordance for empty-column
                              // body: `cursor-cell` signals "click here
                              // to drop a node". Pure CSS, no JS hover
                              // tracking.
                              editMode &&
                                column.nodes.length === 0 &&
                                'cursor-cell hover:bg-gray-500/5 transition-colors rounded-lg',
                            )}
                            style={{
                              width: `${Math.max(...column.nodes.map((node) => node.width || 192), 128)}px`,
                              height: editMode
                                ? svgSize.height > 0
                                  ? `${svgSize.height - 62 - (data.title ? 80 : 0)}px`
                                  : '740px'
                                : 'auto',
                            }}
                            onClick={(e) => {
                              // Deselect nodes when clicking the
                              // column area (not a node inside it).
                              if (e.target === e.currentTarget) {
                                setHighlightedNodes(new Set());
                                setNodeWidth(192);
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
                              const nodeWidth = node.width || 192;
                              const columnWidth = Math.max(
                                ...column.nodes.map((node) => node.width || 192),
                                128,
                              );
                              const leftOffset = Math.max(0, (columnWidth - nodeWidth) / 2);

                              return (
                                <div
                                  key={node.id}
                                  className="absolute"
                                  style={{
                                    top:
                                      node.yPosition !== undefined
                                        ? `${node.yPosition - (nodeHeights[node.id] || 76) / 2}px` // Convert from center to top position using cached height (76px is typical height for "New Node")
                                        : `${nodeIndex * 180 + 30}px`, // Default spacing with more generous padding
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

                            {/* PR 5 Task 5.3: hover-× column delete.
                              Visible only on column hover via the
                              parent's `group` class. Click → React
                              confirm modal (NOT window.confirm). */}
                            {editMode && (
                              <ColumnDeleteAffordance
                                nodeCount={column.nodes.length}
                                scope="column"
                                onDelete={() => deleteColumn(sectionIndex, colIndex)}
                                testIdSuffix={`${sectionIndex}-${colIndex}`}
                              />
                            )}
                          </div>

                          {/* PR 5 Task 5.1: always-on add-column
                            affordance (right gutter after every
                            column). Same minimal-default / hover-
                            translucent-blue treatment. */}
                          {editMode && (
                            <div
                              className="group flex items-center justify-center cursor-pointer rounded-lg transition-colors hover:bg-blue-500/20"
                              style={{
                                width: `${columnPadding}px`,
                                height: svgSize.height > 0 ? `${svgSize.height - 124}px` : '740px',
                              }}
                              onClick={() => {
                                // Add new column
                                setDataAndNotify((prevData) => {
                                  const newData = { ...prevData };
                                  newData.sections[sectionIndex].columns.splice(colIndex + 1, 0, {
                                    nodes: [],
                                  });
                                  return newData;
                                });
                              }}
                              title="Click to add column"
                              data-testid={`add-column-after-${sectionIndex}-${colIndex}`}
                            >
                              <span className="text-blue-600 text-xs font-medium rotate-90 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
                                + Column
                              </span>
                            </div>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              {/* PR 5 Task 5.1: always-on add-section affordance after
                the last section. Same minimal-default / hover-
                translucent-green treatment as the before-section
                gutter above. */}
              {editMode && sectionIndex === data.sections.length - 1 && (
                <div
                  className="group flex items-center justify-center cursor-pointer rounded-lg transition-colors hover:bg-green-500/20"
                  style={{
                    width: `${sectionPadding}px`,
                    height: svgSize.height > 0 ? `${svgSize.height - 124}px` : '740px',
                    marginTop: '68px',
                  }}
                  onClick={() => {
                    setDataAndNotify((prevData) => {
                      const newData = { ...prevData };
                      newData.sections.splice(sectionIndex + 1, 0, {
                        title: 'New Section',
                        columns: [{ nodes: [] }],
                      });
                      return newData;
                    });
                  }}
                  title="Click to add section"
                  data-testid="add-section-after-last"
                >
                  <span className="text-green-600 text-xs font-medium rotate-90 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
                    + Section
                  </span>
                </div>
              )}
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
          layoutMode={layoutMode}
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

        {/* Draggable Legend */}
        <Legend
          legendPosition={legendPosition}
          setLegendPosition={setLegendPosition}
          isDraggingLegend={isDraggingLegend}
          setIsDraggingLegend={setIsDraggingLegend}
          legendDragOffset={legendDragOffset}
          setLegendDragOffset={setLegendDragOffset}
          editMode={editMode}
          fontFamily={fontFamily}
        />

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

        {/* PR 4: drop-preview ghosts. While `dragState !== null` we render
            up to two translucent silhouettes (spec § 4.5):

            1. A drop-location ghost anchored at `dragOverLocation`,
               showing the user where the dropped node will settle. Only
               rendered when the current region maps to a concrete slot
               (node-slot / over-node / new-column).
            2. A cursor-following ghost that tracks the finger / mouse
               while the gesture is in flight.

            The original node renders at half opacity via NodeComponent's
            `isDragging` prop above (`dragState?.nodeId === node.id`).
            Both ghosts sit in the same transform stack as the canvas,
            so they translate with pan/zoom. */}
        {dragState && dragState.hasMoved && graphContainerRef.current ? (
          <>
            {(() => {
              const loc = dragState.dragOverLocation;
              if (!loc || loc.kind === 'new-section') return null;
              const snap = getSnapshot();
              const rect = snap.columnRects[loc.sectionIndex]?.[loc.columnIndex];
              if (!rect) return null;
              const { width: ghostW, height: ghostH } = dragState.nodeSize;
              // Centre the silhouette within the target column. For
              // node-slot, use the cursor-derived yPosition minus half
              // the node height to mirror handleDrop's math; for
              // over-node / new-column we have no y signal, so place at
              // the top of the column (offset by 12px for visual
              // separation from the column header).
              const left = (rect.left + rect.right) / 2 - ghostW / 2;
              const top = loc.kind === 'node-slot' ? loc.yPosition - ghostH / 2 : rect.top + 12;
              return (
                <div
                  className="pointer-events-none absolute z-[55]"
                  style={{
                    left: `${left}px`,
                    top: `${top}px`,
                    width: `${ghostW}px`,
                    height: `${ghostH}px`,
                  }}
                  aria-hidden
                >
                  <div className="rounded-xl bg-indigo-50 border-2 border-dashed border-indigo-300 opacity-60 w-full h-full" />
                </div>
              );
            })()}
            {(() => {
              // Translate ghostPos (viewport coords) to container-local
              // so the absolute-positioned ghost lines up with the
              // canvas geometry. The cursor offset within the node is
              // preserved (drag handle stays under the finger / mouse).
              const containerRect = graphContainerRef.current.getBoundingClientRect();
              const localX = (dragState.ghostPos.x - containerRect.left) / zoomScale;
              const localY = (dragState.ghostPos.y - containerRect.top) / zoomScale;
              const offsetXLocal = dragState.pointerOffset.x / zoomScale;
              const offsetYLocal = dragState.pointerOffset.y / zoomScale;
              return (
                <div
                  className="pointer-events-none absolute z-[60]"
                  style={{
                    left: `${localX - offsetXLocal}px`,
                    top: `${localY - offsetYLocal}px`,
                    width: `${dragState.nodeSize.width}px`,
                    height: `${dragState.nodeSize.height}px`,
                  }}
                  aria-hidden
                >
                  <div className="rounded-xl bg-indigo-100 ring-2 ring-indigo-400 opacity-70 w-full h-full shadow-lg" />
                </div>
              );
            })()}
          </>
        ) : null}

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
