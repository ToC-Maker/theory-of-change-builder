import React, { useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { ToCData } from '../types';
import { getConfidenceStrokeStyle } from '../utils';
import { getLocalPosition } from '../hooks/useGraphLayout';
import { computePathWithWaypoints, computeSegmentMidpoints } from '../utils/connectionPath';
import { EdgeEditor } from './edge-editor/EdgeEditor';
import { buildConnectionPath } from './canvas/connectionPath';
import type { WaypointDragState } from '../hooks/useWaypointDrag';
import { MOVE_THRESHOLD_PX } from '../hooks/usePointerDrag';
import { ConnectionWaypointHandles } from './canvas/ConnectionWaypointHandles';

// PR 3: `EdgePopupState` was the modal's full state copy (with x/y for
// positioning, plus full confidence/evidence/assumptions). The new
// anchored EdgeEditor reads property values from `data` directly, so we
// only need the source/target pair plus the midpoint for anchor
// placement.
interface SelectedEdge {
  sourceId: string;
  targetId: string;
  /** Connection midpoint in container-local coordinates (px). */
  midX: number;
  midY: number;
}

interface ConnectionsComponentProps {
  data: ToCData;
  /**
   * PR 3: `useGraphMutation` triad threaded down so the embedded
   * EdgeEditor can write confidence (streaming) and evidence /
   * assumptions (buffered) through the same primitive everything
   * else uses. `setData` (the direct setter) was previously used for
   * updateConfidence/updateConnection in this file — both retired.
   */
  mutate?: (updater: ToCData | ((prev: ToCData) => ToCData)) => void;
  mutateDebounced?: (updater: ToCData | ((prev: ToCData) => ToCData), key: string) => void;
  commit?: (key?: string) => void;
  nodeRefs: { [key: string]: HTMLDivElement | null };
  nodeHeights: { [key: string]: number };
  highlightedNodes: Set<string>;
  connectedNodes: Set<string>;
  hoveredConnections: Set<string>;
  curvature: number;
  editMode: boolean;
  sectionWidths: number[];
  columnPadding: number;
  sectionPadding: number;
  onSizeChange: (size: { width: number; height: number }) => void;
  /**
   * PR 3: `onDeleteConnection` was used by the EdgePopup's delete
   * button. The anchored EdgeEditor calls its own
   * `useEdgeProperties.deleteConnection` (atomic write through the
   * mutate triad), so the parent doesn't need to plumb a separate
   * callback. The prop is intentionally removed; the
   * `disconnectSelectedNodes` path in TheoryOfChangeGraph still owns
   * the 2-node-selected disconnect button.
   */
  containerRef: React.RefObject<HTMLDivElement | null>;
  camera?: { x: number; y: number; z: number };
  fontFamily?: string;
  // PR 3: `viewportOffset` / `zoomScale` were only consumed by EdgePopup
  // (modal sizing math). The anchored EdgeEditor reads viewport
  // positioning via `useAnchorPosition` directly, so these are no
  // longer needed.
  // PR 7: waypoint-drag binders + state come from the parent
  // (`TheoryOfChangeGraph` owns the hook so its `isActive` can OR into
  // `isAnyDragActive` for the polling-pause channel). `waypointDragState`
  // is consumed locally for the "keep handles visible mid-drag"
  // affordance — see `handlesVisible` below.
  bindWaypoint?: (
    sourceNodeId: string,
    targetNodeId: string,
    waypointIndex: number,
  ) => {
    onPointerDown: (e: ReactPointerEvent) => void;
    onDoubleClick: (e: ReactMouseEvent) => void;
  };
  bindMidpoint?: (
    sourceNodeId: string,
    targetNodeId: string,
    segmentIndex: number,
  ) => { onPointerDown: (e: ReactPointerEvent) => void };
  waypointDragState?: WaypointDragState | null;
}

export function ConnectionsComponent({
  data,
  mutate,
  mutateDebounced,
  commit,
  nodeRefs,
  nodeHeights,
  highlightedNodes,
  connectedNodes,
  hoveredConnections,
  curvature,
  editMode,
  sectionWidths,
  columnPadding,
  sectionPadding,
  onSizeChange,
  containerRef,
  camera,
  fontFamily,
  bindWaypoint,
  bindMidpoint,
  waypointDragState,
}: ConnectionsComponentProps) {
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  // K7: pointerdown position on a connection's fat hit-path, consumed
  // by that path's click handler to tell taps from drags. Browsers
  // fire `click` after a drag whenever mousedown/mouseup share a
  // target — and during a canvas pan the content used to move WITH
  // the cursor, so the path always stayed under it and every pan
  // ending on a connection popped the EdgeEditor. One shared ref (not
  // per-connection): a click on path P implies both down and up hit P,
  // so the most recent pointerdown is necessarily this gesture's.
  // Cleared on consume so an abandoned press (down on path, up
  // elsewhere → no click) can suppress at most nothing.
  const hitPathPointerDownRef = useRef<{ x: number; y: number } | null>(null);
  // PR 3: `edgePopup` (full EdgePopupState modal copy) collapsed to
  // `selectedEdge` (source+target pair + midpoint anchor). The anchored
  // EdgeEditor reads property values from `data` directly.
  const [selectedEdge, setSelectedEdge] = useState<SelectedEdge | null>(null);

  // Feedback 49: NodeEditor and EdgeEditor are mutually exclusive —
  // opening one must close the other. Mouse flows already satisfy this
  // emergently (both editors dismiss on document `mousedown` via
  // `useDismissOnOutsideEvent`, and every mouse path that changes one
  // selection starts with a mousedown outside the other editor). The
  // hole is node-selection paths with NO mousedown: keyboard select-all
  // (Ctrl/Cmd+A) and Tab node-navigation in `useKeyboardShortcuts`
  // would mount the NodeEditor while `selectedEdge` was still set.
  // Enforce the invariant at the state level instead of per-gesture:
  // whenever node selection is (or becomes) non-empty, drop the edge
  // selection. Layout effect (not passive) so the dual state never
  // paints. The `size > 0` guard keeps empty-set identity churn from
  // closing a just-opened editor, and `setSelectedEdge(null)` on an
  // already-null state is a React no-op, so this doesn't loop.
  //
  // Note the deliberate asymmetry: edge selection only ever arrives via
  // a path click (mousedown first), so the NodeEditor side is already
  // covered by its dismissal hook; node selection can arrive silently,
  // so the EdgeEditor side needs this state-level rule.
  useLayoutEffect(() => {
    if (highlightedNodes.size > 0) setSelectedEdge(null);
  }, [highlightedNodes]);

  // Stash `onSizeChange` in a ref so `updateSize` doesn't need it as a dep —
  // the parent passes a fresh inline arrow every render, which would otherwise
  // re-create `updateSize` on every parent render.
  const onSizeChangeRef = useRef(onSizeChange);
  useEffect(() => {
    onSizeChangeRef.current = onSizeChange;
  }, [onSizeChange]);
  const [smoothUpdates, setSmoothUpdates] = useState(false);
  // `refreshCounter` is a re-render kick: nothing reads the value, but calling
  // `setRefreshCounter` forces this component to re-render so the `connections.map`
  // block below re-reads live DOM offsets (used by the RAF smooth-update loop and
  // by padding changes). The value itself is deliberately unused.
  const [, setRefreshCounter] = useState(0);
  const animationFrameRef = useRef<number | null>(null);
  const smoothUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateSize = useCallback(() => {
    // Calculate width based on actual section widths + gaps only.
    //
    // PR 5: edit mode always renders the column-gutter and section-
    // padding affordances (`Task 5.1`). The width math accounts for
    // those gutters whenever `editMode` is true (no `layoutMode`
    // dependency). View mode still uses the bare section gaps.
    let totalWidth = 0;

    if (editMode) {
      // Section drop zone before first section.
      totalWidth += sectionPadding;
    }

    // Use the actual calculated section widths, but account for title width too
    sectionWidths.forEach((sectionWidth, sectionIndex) => {
      // Measure actual rendered section title width from DOM
      const sectionTitleElement = containerRef.current?.querySelector(
        `[data-section-index="${sectionIndex}"] > div:first-child`,
      ) as HTMLElement;

      // Use measured width if available, otherwise fall back to sectionWidth
      // The title uses minWidth of sectionWidth and width: max-content, so it will always be at least sectionWidth
      const titleWidth = sectionTitleElement?.offsetWidth || sectionWidth;

      // Use the wider of section width or measured title width
      const effectiveSectionWidth = Math.max(sectionWidth, titleWidth);
      totalWidth += effectiveSectionWidth;

      // Add extra width for the always-on column-gutter affordances in
      // edit mode. (N+1) zones × columnPadding px each (before first
      // + after each column).
      if (editMode) {
        // Count ALL columns in this section (including empty ones)
        const columnCount = data.sections[sectionIndex].columns.length || 1;

        const dropZonesWidth = (columnCount + 1) * columnPadding;

        // Only add drop zones width if it's not already accounted for in the effective section width
        // The effectiveSectionWidth might already be wider due to title
        const sectionWithDropZones = sectionWidth + dropZonesWidth;
        const additionalWidth = Math.max(0, sectionWithDropZones - effectiveSectionWidth);

        totalWidth += additionalWidth;
      }

      // Section gap. In edit mode the section-padding gutter sits between
      // sections (rendered by TheoryOfChangeGraph as the "before-section"
      // affordance for sectionIndex+1); in view mode it's a bare gap.
      if (sectionIndex < sectionWidths.length - 1) {
        totalWidth += sectionPadding;
      }
    });

    if (editMode) {
      // Section drop zone after last section.
      totalWidth += sectionPadding;
    }

    // Calculate height based on content positions (avoid DOM measurements that change with zoom)
    let maxHeight = 0;

    data.sections.forEach((section) => {
      section.columns.forEach((column) => {
        column.nodes.forEach((node, nodeIndex) => {
          // Use cached height or default
          const nodeHeight = nodeHeights[node.id] || 150;

          // Get node position - yPosition now represents center Y
          const nodeCenterY =
            node.yPosition !== undefined ? node.yPosition : nodeIndex * 180 + 30 + nodeHeight / 2;
          const nodeTop = nodeCenterY - nodeHeight / 2;
          const nodeBottom = nodeTop + nodeHeight;
          maxHeight = Math.max(maxHeight, nodeBottom);
        });
      });
    });

    // Add header height, title height, and padding
    const headerHeight = 62; // Section header height (matches the -62px offset in columns)
    // Graph title block height (includes margin). PR #34 fb4 issue 64:
    // edit mode renders the title block even when `data.title` is empty
    // (the "Click to add title" placeholder), so the budget must count
    // it then too — otherwise the canvas card comes out 80px shorter
    // than the rendered content and the column bodies / add affordances
    // spill below it. Mirrors the unconditional 80 in the edit-mode
    // column body height (TheoryOfChangeGraph).
    const titleHeight = data.title || editMode ? 80 : 0;
    const padding = 0; // No extra padding needed
    const dynamicHeight = Math.max(maxHeight + headerHeight + titleHeight + padding, 800); // Minimum 800px

    const newSize = { width: totalWidth, height: dynamicHeight };
    setSvgSize(newSize);
    onSizeChangeRef.current(newSize);
  }, [
    sectionWidths,
    data.sections,
    data.title,
    editMode,
    nodeHeights,
    columnPadding,
    sectionPadding,
    containerRef,
  ]);

  useEffect(() => {
    // Immediate size calculation
    updateSize();

    // Also update after a short delay to ensure everything is settled
    const timeoutId = setTimeout(updateSize, 100);

    // Update on window resize
    const handleResize = () => {
      updateSize();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timeoutId);
    };
  }, [updateSize]);

  // Update SVG size when section widths change
  useEffect(() => {
    updateSize();
  }, [sectionWidths, updateSize]);

  // Refresh connections when column or section padding changes
  useEffect(() => {
    setRefreshCounter((prev) => prev + 1);
  }, [columnPadding, sectionPadding]);

  // Smooth edge updates during interactions using RAF
  useEffect(() => {
    const updateConnections = () => {
      if (smoothUpdates) {
        // Trigger re-render of connections by incrementing counter
        setRefreshCounter((prev) => prev + 1);
        animationFrameRef.current = requestAnimationFrame(updateConnections);
      }
    };

    if (smoothUpdates) {
      animationFrameRef.current = requestAnimationFrame(updateConnections);
    } else if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [smoothUpdates]);

  // Enable smooth updates when there are active interactions or in edit mode
  useEffect(() => {
    const hasActiveInteractions = highlightedNodes.size > 0 || hoveredConnections.size > 0;
    const shouldUpdate = editMode || hasActiveInteractions;

    // Clear any existing timeout
    if (smoothUpdateTimeoutRef.current) {
      clearTimeout(smoothUpdateTimeoutRef.current);
      smoothUpdateTimeoutRef.current = null;
    }

    if (shouldUpdate) {
      // Enable immediately for active interactions or edit mode
      setSmoothUpdates(true);
    } else {
      // Add delay before disabling to allow smooth retraction
      smoothUpdateTimeoutRef.current = setTimeout(() => {
        setSmoothUpdates(false);
      }, 300); // 300ms delay for smooth retraction
    }

    return () => {
      if (smoothUpdateTimeoutRef.current) {
        clearTimeout(smoothUpdateTimeoutRef.current);
        smoothUpdateTimeoutRef.current = null;
      }
    };
  }, [editMode, highlightedNodes.size, hoveredConnections.size]);

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
            return { sectionIndex, columnIndex };
          }
        }
      }
      return null;
    },
    [data.sections],
  );

  // PR 3: `findNodeTitle` / `findNodeColor` helpers retired — they fed
  // the EdgePopup modal's "From: [title]" / "To: [title]" header. The
  // anchored EdgeEditor doesn't render the endpoint titles; the user
  // already sees the connected nodes visually on the canvas.

  const connections = useMemo(() => {
    return data.sections
      .flatMap((section, sectionIndex) =>
        section.columns.flatMap((column, columnIndex) =>
          column.nodes.flatMap((node) => {
            // Handle both old connectionIds and new connections format
            if (node.connections) {
              return node.connections.map((conn) => {
                const targetLocation = findNodeLocation(conn.targetId);
                return {
                  start: nodeRefs[node.id],
                  end: nodeRefs[conn.targetId],
                  sourceSectionIndex: sectionIndex,
                  sourceColumnIndex: columnIndex,
                  targetSectionIndex: targetLocation?.sectionIndex ?? -1,
                  targetColumnIndex: targetLocation?.columnIndex ?? -1,
                  sourceId: node.id,
                  targetId: conn.targetId,
                  confidence: conn.confidence,
                  evidence: conn.evidence,
                  assumptions: conn.assumptions,
                  // PR 7: forward optional waypoints. Empty/undefined =
                  // falls back to auto-bezier (byte-identical to
                  // pre-PR-7 rendering, see
                  // `tests/frontend/connectionPath.waypoints.test.ts`).
                  waypoints: conn.waypoints,
                };
              });
            } else {
              return node.connectionIds.map((connectionId) => {
                const targetLocation = findNodeLocation(connectionId);
                return {
                  start: nodeRefs[node.id],
                  end: nodeRefs[connectionId],
                  sourceSectionIndex: sectionIndex,
                  sourceColumnIndex: columnIndex,
                  targetSectionIndex: targetLocation?.sectionIndex ?? -1,
                  targetColumnIndex: targetLocation?.columnIndex ?? -1,
                  sourceId: node.id,
                  targetId: connectionId,
                  confidence: 50, // default confidence (medium)
                  evidence: undefined,
                  assumptions: undefined,
                  waypoints: undefined,
                };
              });
            }
          }),
        ),
      )
      .filter((connection) => connection.start && connection.end);
  }, [data.sections, nodeRefs, findNodeLocation]);

  // PR 3: `updateConfidence` / `updateConnection` setters retired —
  // those mutations now flow through `useEdgeProperties.patchConnection`
  // inside the EdgeEditor (which streams via `mutateDebounced` so the
  // confidence slider produces ONE undo entry per drag, like the
  // node-width slider).

  // PR 7: waypoint-drag binders + drag-state come from the parent
  // (`TheoryOfChangeGraph`). See `bindWaypoint`/`bindMidpoint`/
  // `waypointDragState` props on this component for context.

  const strokeWidth = 3;
  // K8 + fb4 63: the connection whose handles must win overlapping hit
  // tests. Hover is the most immediate intent signal; with no hover, a
  // SELECTED connection (EdgeEditor open) keeps priority — its handles
  // are visible without hover, and a press on them must not fall on an
  // overlapping sibling's fat band.
  const selectedEdgeKey = selectedEdge ? `${selectedEdge.sourceId}-${selectedEdge.targetId}` : null;
  const activeEdgeKey = hoveredEdge ?? selectedEdgeKey;
  return (
    <>
      <svg
        className="absolute top-0 left-0 pointer-events-none z-0"
        width={svgSize.width}
        height={svgSize.height}
      >
        <defs>
          <marker id="arrowhead" markerWidth="5" markerHeight="5" refX="0" refY="3" orient="auto">
            <polygon points="0 1, 5 3, 0 5" fill="#000000" />
          </marker>
        </defs>
        {connections.map((connection, index) => {
          if (!connection.start || !connection.end) return null;

          // Get local positions using offsetTop/offsetLeft (immune to transforms)
          const startNode = connection.start;
          const endNode = connection.end;

          // Get the container element
          const container = containerRef.current || startNode.closest('.flex.relative');
          if (!container) return null;

          const startPos = getLocalPosition(startNode, container as HTMLElement);
          const endPos = getLocalPosition(endNode, container as HTMLElement);

          // Check if nodes are in the same column for vertical connections
          const isSameColumn =
            connection.sourceSectionIndex === connection.targetSectionIndex &&
            connection.sourceColumnIndex === connection.targetColumnIndex;

          // Check if this is a backward connection (right to left)
          const isBackwardConnection =
            !isSameColumn &&
            (connection.targetSectionIndex < connection.sourceSectionIndex ||
              (connection.targetSectionIndex === connection.sourceSectionIndex &&
                connection.targetColumnIndex < connection.sourceColumnIndex));

          let startX, startY, endX, endY;

          if (isSameColumn) {
            // Vertical connection logic
            startX = startPos.x + startPos.width / 2;
            endX = endPos.x + endPos.width / 2;

            // Determine which node is higher (lower y position)
            if (startPos.y < endPos.y) {
              // Source is above target: go from bottom of source to top of target
              startY = startPos.y + startPos.height;
              endY = endPos.y - 14; // Offset by arrow height
            } else {
              // Source is below target: go from top of source to bottom of target
              startY = startPos.y;
              endY = endPos.y + endPos.height + 14; // Offset by arrow height
            }
          } else if (isBackwardConnection) {
            // Backward connection logic (right to left)
            startX = startPos.x; // Start from left side of source node
            startY = startPos.y + startPos.height / 2;
            endX = endPos.x + endPos.width + 14; // End at right side of target node with arrow offset
            endY = endPos.y + endPos.height / 2;
          } else {
            // Forward connection logic (left to right)
            startX = startPos.x + startPos.width;
            startY = startPos.y + startPos.height / 2;
            endX = endPos.x - 14; // Offset by arrow width
            endY = endPos.y + endPos.height / 2;
          }

          // PR 7: factor path math into `computePathWithWaypoints`. With
          // an empty waypoints array the output is BYTE-IDENTICAL to
          // the previous inline auto-bezier string (validated by
          // `tests/frontend/connectionPath.waypoints.test.ts`). When
          // waypoints are present we get a single multi-segment cubic
          // bezier (one `<path>` element) so dashed/dotted strokes stay
          // continuous through corners.
          const pathDirection: 'forward' | 'backward' | 'vertical' = isSameColumn
            ? 'vertical'
            : isBackwardConnection
              ? 'backward'
              : 'forward';
          const pathD = computePathWithWaypoints({
            source: { x: startX, y: startY },
            target: { x: endX, y: endY },
            waypoints: connection.waypoints ?? [],
            curvature,
            direction: pathDirection,
          });

          const isHighlighted =
            highlightedNodes.has(connection.sourceId) || highlightedNodes.has(connection.targetId);
          const isConnected =
            connectedNodes.has(connection.sourceId) && connectedNodes.has(connection.targetId);
          const isHovered =
            hoveredConnections.has(connection.sourceId) &&
            hoveredConnections.has(connection.targetId);
          const hasHighlightedNodes = highlightedNodes.size > 0;
          const isLowOpacity =
            hasHighlightedNodes &&
            (!connectedNodes.has(connection.sourceId) || !connectedNodes.has(connection.targetId));

          const getStrokeStyle = () => {
            const baseStyle = getConfidenceStrokeStyle(connection.confidence);

            if (isHovered) {
              return { ...baseStyle, opacity: Math.min(1, baseStyle.opacity + 0.3) };
            } else if (isHighlighted) {
              return { ...baseStyle, opacity: Math.min(1, baseStyle.opacity + 0.4) };
            } else if (isConnected) {
              return { ...baseStyle, opacity: Math.min(1, baseStyle.opacity + 0.2) };
            } else {
              return { ...baseStyle, opacity: baseStyle.opacity * 0.7 };
            }
          };

          const strokeStyle = getStrokeStyle();
          const edgeKey = `${connection.sourceId}-${connection.targetId}`;
          const isEdgeHovered = hoveredEdge === edgeKey;
          const isEdgeSelected =
            selectedEdge?.sourceId === connection.sourceId &&
            selectedEdge?.targetId === connection.targetId;
          // PR 7: handles visible on hover OR select, edit-mode only.
          // While the user is actively dragging a waypoint we keep
          // handles visible regardless of hover (mouse may have left
          // the path during the drag motion); the parent-owned
          // `waypointDragState` tells us this.
          const isThisConnectionBeingDragged =
            waypointDragState?.sourceNodeId === connection.sourceId &&
            waypointDragState?.targetNodeId === connection.targetId;
          const handlesVisible =
            editMode &&
            !!bindWaypoint &&
            !!bindMidpoint &&
            (isEdgeHovered || isEdgeSelected || isThisConnectionBeingDragged);
          const waypointAnchors = [
            { x: startX, y: startY },
            ...(connection.waypoints ?? []),
            { x: endX, y: endY },
          ];
          const waypointCount = connection.waypoints?.length ?? 0;
          // PR 7 feedback (A): midpoint affordances must sit ON the
          // rendered curve, not on the straight chord between anchors.
          // `computeSegmentMidpoints` shares the exact same control-
          // point math as the path renderer and evaluates each segment
          // at t=0.5 → handle dots line up with the visible curve
          // regardless of waypoint position, curvature, or zoom.
          const segmentMidpoints = computeSegmentMidpoints({
            source: { x: startX, y: startY },
            target: { x: endX, y: endY },
            waypoints: connection.waypoints ?? [],
            curvature,
            direction: pathDirection,
          });

          return (
            // Hover state lives on the GROUP, not the invisible hit
            // path: the waypoint/midpoint handles are siblings of the
            // path inside this <g>, so path ↔ handle transitions stay
            // internal and fire no leave. With the handlers on the
            // path (previous design), reaching a handle fired the
            // path's mouseleave → hoveredEdge=null → the handle under
            // the pointer UNMOUNTED → the user's press fell through to
            // the canvas and panned it (PR #34 feedback 50, leak path
            // 2; regression test in ConnectionsComponent.hover-
            // handles.test.tsx).
            <g
              key={index}
              onMouseEnter={() => setHoveredEdge(edgeKey)}
              onMouseLeave={() => setHoveredEdge(null)}
            >
              {/* Invisible thicker path for easier clicking */}
              <path
                d={pathD}
                className="fill-none cursor-pointer"
                // K7: matched by App.tsx's `excludeFromPan` so a press
                // that starts on a connection can never start a canvas
                // pan (same mechanism as the waypoint handles, PR 7
                // feedback 18). Dragging from a connection does
                // nothing; only a true click (sub-threshold movement,
                // see onClick) opens the EdgeEditor.
                data-tocb-connection-hitpath=""
                style={{
                  stroke: 'transparent',
                  strokeWidth: '20px', // Much thicker for easier clicking
                  // K8: hover priority for overlapping fat bands. SVG
                  // hit-testing gives overlap to the LAST connection in
                  // document order, so on crossing layouts the topmost
                  // band stole hover mid-glide — the lower connection's
                  // group fired mouseleave while the cursor was still
                  // on its visible curve, unmounting the very handles
                  // the user was approaching (reproduced live: hover
                  // log flipped to the upper band at t=0.35 of the
                  // lower curve; its midpoint handle never mounted).
                  // While ANY connection is hovered, every other
                  // connection's hit path goes inert: acquisition is
                  // unchanged (first contact happens on a
                  // non-overlapped stretch), but once acquired, hover
                  // sticks until the pointer truly leaves the hovered
                  // band — and the hovered connection's handles win
                  // the hit test inside the overlap, so they're
                  // reachable. Release (group mouseleave → hoveredEdge
                  // null) re-arms all bands; the next pointer move
                  // re-acquires whatever is under the cursor.
                  //
                  // fb4 63 (K8 residual): the same muting applies while
                  // a connection is SELECTED (EdgeEditor open) — its
                  // handles are visible without hover, and a press on
                  // them used to fall on an overlapping sibling's band
                  // (reproduced live: with a→d selected and the pointer
                  // away, elementFromPoint at a→d's own midpoint handle
                  // returned b→c's hit path). `activeEdgeKey` is
                  // `hoveredEdge ?? selectedEdge`: hover, when present,
                  // takes precedence. While an editor is open, a click
                  // on a sibling band therefore first dismisses the
                  // editor (document-mousedown), which re-arms all
                  // bands; the sibling is selectable with the next
                  // click — standard popover dismissal semantics.
                  pointerEvents:
                    (hasHighlightedNodes && !isHighlighted) ||
                    (activeEdgeKey !== null && edgeKey !== activeEdgeKey)
                      ? 'none'
                      : 'stroke',
                }}
                onPointerDown={(e) => {
                  // K7: record where the press started; the click
                  // handler measures movement against this. No mutex
                  // claim and no stopPropagation — a press on the path
                  // is not (yet) a gesture.
                  hitPathPointerDownRef.current = { x: e.clientX, y: e.clientY };
                }}
                onClick={(e) => {
                  e.stopPropagation();

                  // K7: tap-vs-drag dead-zone, mirroring
                  // `usePointerDrag.hasMoved` (PR #34 fb 45). A click
                  // event lands here after ANY down+up pair on this
                  // path, however far apart; only open the editor when
                  // the gesture stayed within the tap threshold.
                  // Clicks with no recorded pointerdown (programmatic
                  // / synthesized) open unconditionally.
                  const downPos = hitPathPointerDownRef.current;
                  hitPathPointerDownRef.current = null;
                  if (
                    downPos &&
                    (Math.abs(e.clientX - downPos.x) > MOVE_THRESHOLD_PX ||
                      Math.abs(e.clientY - downPos.y) > MOVE_THRESHOLD_PX)
                  ) {
                    return; // Drag, not a click — no editor.
                  }

                  // Only allow clicking on highlighted edges when nodes are selected
                  // Or allow all edges when no nodes are selected
                  if (hasHighlightedNodes && !isHighlighted) {
                    return; // Don't show popup for non-highlighted edges when nodes are selected
                  }

                  const midX = (startX + endX) / 2;
                  const midY = (startY + endY) / 2;
                  setSelectedEdge({
                    sourceId: connection.sourceId,
                    targetId: connection.targetId,
                    midX,
                    midY,
                  });
                }}
              />
              {/* Glow shadow layer */}
              <path
                d={pathD}
                className="fill-none"
                markerEnd="url(#arrowhead)"
                style={{
                  stroke: 'rgba(0, 0, 0, 0.5)',
                  strokeWidth: `${strokeWidth}px`,
                  strokeDasharray:
                    strokeStyle.strokeDasharray === 'none'
                      ? undefined
                      : strokeStyle.strokeDasharray,
                  opacity: isEdgeHovered ? 1 : 0,
                  pointerEvents: 'none',
                  filter: 'blur(3px)',
                  transition: 'opacity 0.25s ease-in-out',
                }}
              />
              {/* Main visible path */}
              <path
                d={pathD}
                className="fill-none"
                markerEnd="url(#arrowhead)"
                style={{
                  stroke: strokeStyle.stroke,
                  strokeWidth: `${strokeWidth}px`,
                  strokeDasharray:
                    strokeStyle.strokeDasharray === 'none'
                      ? undefined
                      : strokeStyle.strokeDasharray,
                  opacity: isLowOpacity ? 0.01 : strokeStyle.opacity,
                  pointerEvents: 'none', // This path doesn't handle clicks
                  transition: smoothUpdates
                    ? 'none'
                    : 'd 0.15s ease-out, stroke 0.2s ease-out, opacity 0.2s ease-out, stroke-dasharray 0.2s ease-out',
                }}
              />
              {/* PR 7: waypoint + midpoint handles for direct
                  manipulation. Rendered above the visible path so the
                  handles always sit on top; visibility = hovered OR
                  selected OR currently being dragged.
                  `dragInProgress` mirrors `isThisConnectionBeingDragged`
                  (the parent-owned waypointDragState) so midpoint
                  handles disappear while the user drags a waypoint —
                  PR 7 feedback item 17. */}
              {bindWaypoint && bindMidpoint && (
                <ConnectionWaypointHandles
                  sourceNodeId={connection.sourceId}
                  targetNodeId={connection.targetId}
                  anchors={waypointAnchors}
                  segmentMidpoints={segmentMidpoints}
                  waypointCount={waypointCount}
                  visible={handlesVisible}
                  dragInProgress={isThisConnectionBeingDragged}
                  bindWaypoint={bindWaypoint}
                  bindMidpoint={bindMidpoint}
                />
              )}
            </g>
          );
        })}

        {/* Ghost connection preview when exactly 2 nodes are selected */}
        {editMode &&
          highlightedNodes.size === 2 &&
          (() => {
            const nodeIds = Array.from(highlightedNodes);
            const [sourceId, targetId] = nodeIds;

            // Check if they're already connected
            const isAlreadyConnected = connections.some(
              (conn) =>
                (conn.sourceId === sourceId && conn.targetId === targetId) ||
                (conn.sourceId === targetId && conn.targetId === sourceId),
            );

            if (isAlreadyConnected) return null; // Don't show ghost if already connected

            const sourceRef = nodeRefs[sourceId];
            const targetRef = nodeRefs[targetId];

            if (!sourceRef || !targetRef) return null;

            // Get the container element
            const container = containerRef.current || sourceRef.closest('.flex.relative');

            if (!container) return null;

            const startPos = getLocalPosition(sourceRef, container as HTMLElement);
            const endPos = getLocalPosition(targetRef, container as HTMLElement);

            // Check if nodes are in the same column for ghost connection
            const sourceLocation = findNodeLocation(sourceId);
            const targetLocation = findNodeLocation(targetId);
            const isGhostSameColumn =
              sourceLocation &&
              targetLocation &&
              sourceLocation.sectionIndex === targetLocation.sectionIndex &&
              sourceLocation.columnIndex === targetLocation.columnIndex;

            // Check if this is a backward ghost connection (right to left)
            const isGhostBackwardConnection =
              !isGhostSameColumn &&
              sourceLocation &&
              targetLocation &&
              (targetLocation.sectionIndex < sourceLocation.sectionIndex ||
                (targetLocation.sectionIndex === sourceLocation.sectionIndex &&
                  targetLocation.columnIndex < sourceLocation.columnIndex));

            let startX, startY, endX, endY;

            if (isGhostSameColumn) {
              // Vertical ghost connection logic (using local coordinates)
              startX = startPos.x + startPos.width / 2;
              endX = endPos.x + endPos.width / 2;

              if (startPos.y < endPos.y) {
                startY = startPos.y + startPos.height;
                endY = endPos.y - 14;
              } else {
                startY = startPos.y;
                endY = endPos.y + endPos.height + 14;
              }
            } else if (isGhostBackwardConnection) {
              // Backward ghost connection logic (right to left)
              startX = startPos.x; // Start from left side of source node
              startY = startPos.y + startPos.height / 2;
              endX = endPos.x + endPos.width + 14; // End at right side of target node with arrow offset
              endY = endPos.y + endPos.height / 2;
            } else {
              // Forward ghost connection logic (left to right)
              startX = startPos.x + startPos.width;
              startY = startPos.y + startPos.height / 2;
              endX = endPos.x - 14;
              endY = endPos.y + endPos.height / 2;
            }

            // PR 5 Task 5.2: path math factored into
            // `./canvas/connectionPath.ts` so the drag-to-connect
            // gesture's in-flight ghost (rendered by the parent) can
            // share the exact same shape as this select-2 preview.
            const direction = isGhostSameColumn
              ? 'vertical'
              : isGhostBackwardConnection
                ? 'backward'
                : 'forward';
            const ghostPathD = buildConnectionPath({
              startX,
              startY,
              endX,
              endY,
              curvature,
              direction,
            });

            // Get the style that a real connection would have (default confidence: 75)
            const ghostStrokeStyle = getConfidenceStrokeStyle(75);

            return (
              <g>
                {/* Ghost connection path - looks like real connection but more transparent */}
                <path
                  d={ghostPathD}
                  className="fill-none"
                  markerEnd="url(#arrowhead)"
                  style={{
                    stroke: ghostStrokeStyle.stroke,
                    strokeWidth: `${strokeWidth}px`, // Use same width as real connections
                    strokeDasharray:
                      ghostStrokeStyle.strokeDasharray === 'none'
                        ? undefined
                        : ghostStrokeStyle.strokeDasharray,
                    opacity: 0.4, // Static transparency - no pulsing
                    pointerEvents: 'none',
                  }}
                />
              </g>
            );
          })()}
      </svg>

      {/* PR 3: anchored EdgeEditor replaces the EdgePopup modal. The
        anchor is a 1x1 invisible div positioned at the connection
        midpoint (container-local coords), inside the same container
        the connections SVG paints into so it inherits the same pan/
        zoom transform. `useAnchorPosition` re-reads its rect on
        camera change. */}
      {selectedEdge && mutate && mutateDebounced && commit && (
        <EdgeAnchorMount
          selectedEdge={selectedEdge}
          data={data}
          mutate={mutate}
          mutateDebounced={mutateDebounced}
          commit={commit}
          camera={camera ?? { x: 0, y: 0, z: 1 }}
          containerRef={containerRef}
          fontFamily={fontFamily}
          onRequestClose={() => setSelectedEdge(null)}
        />
      )}
    </>
  );
}

/**
 * Renders an invisible 1x1 anchor at the connection midpoint, then
 * mounts the EdgeEditor against it. The anchor lives inside the
 * connections container (sibling to the SVG), so it inherits the
 * same CSS transforms. Pan/zoom updates the camera, which feeds
 * `useAnchorPosition` and re-reads the rect.
 */
function EdgeAnchorMount({
  selectedEdge,
  data,
  mutate,
  mutateDebounced,
  commit,
  camera,
  containerRef,
  fontFamily,
  onRequestClose,
}: {
  selectedEdge: SelectedEdge;
  data: ToCData;
  mutate: (updater: ToCData | ((prev: ToCData) => ToCData)) => void;
  mutateDebounced: (updater: ToCData | ((prev: ToCData) => ToCData), key: string) => void;
  commit: (key?: string) => void;
  camera: { x: number; y: number; z: number };
  containerRef: React.RefObject<HTMLDivElement | null>;
  fontFamily?: string;
  onRequestClose: () => void;
}) {
  const anchorRef = useRef<HTMLDivElement>(null);
  // The container is the canvas; appending a child to it places the
  // anchor in the same coordinate space as the nodes. Note we render
  // the anchor inside `containerRef.current` indirectly: this component
  // returns the anchor JSX, and React mounts it as a sibling to the
  // SVG inside the connections container. The midpoint is in
  // container-local coordinates so we set absolute position + left/top.
  if (!containerRef.current) return null;
  return (
    <>
      <div
        ref={anchorRef}
        className="absolute pointer-events-none"
        style={{
          left: selectedEdge.midX,
          top: selectedEdge.midY,
          width: 1,
          height: 1,
        }}
      />
      <EdgeEditor
        sourceId={selectedEdge.sourceId}
        targetId={selectedEdge.targetId}
        data={data}
        mutate={mutate}
        mutateDebounced={mutateDebounced}
        commit={commit}
        anchorRef={anchorRef}
        camera={camera}
        onRequestClose={onRequestClose}
        fontFamily={fontFamily}
      />
    </>
  );
}
