import React, { useState, useMemo, useCallback, useEffect, useRef } from "react"
import { ToCData } from "../types"
import { getConfidenceStrokeStyle } from "../utils"
import { EdgePopup } from "./EdgePopup"

interface ConnectionsComponentProps {
  data: ToCData
  setData: React.Dispatch<React.SetStateAction<ToCData>>
  nodeRefs: { [key: string]: HTMLDivElement | null }
  nodeHeights: { [key: string]: number }
  highlightedNodes: Set<string>
  connectedNodes: Set<string>
  hoveredConnections: Set<string>
  curvature: number
  editMode: boolean
  layoutMode: boolean
  sectionWidths: number[]
  columnPadding: number
  sectionPadding: number
  onSizeChange: (size: { width: number; height: number }) => void
  onDeleteConnection?: (sourceId: string, targetId: string) => void
  containerRef: React.RefObject<HTMLDivElement>
  onEdgePopupChange?: (edgePopup: any) => void
}

export function ConnectionsComponent({
  data,
  setData,
  nodeRefs,
  nodeHeights,
  highlightedNodes,
  connectedNodes,
  hoveredConnections,
  curvature,
  editMode,
  layoutMode,
  sectionWidths,
  columnPadding,
  sectionPadding,
  onSizeChange,
  onDeleteConnection,
  containerRef,
  onEdgePopupChange,
}: ConnectionsComponentProps) {
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 })
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null)
  const [edgePopup, setEdgePopupState] = useState<{
    sourceId: string
    targetId: string
    x: number
    y: number
    confidence: number
    minConfidence?: number
    maxConfidence?: number
    evidence?: string
    assumptions?: string
  } | null>(null)

  const setEdgePopup = (value: any) => {
    setEdgePopupState(value)
    onEdgePopupChange?.(value)
  }
  const [smoothUpdates, setSmoothUpdates] = useState(false)
  const [refreshCounter, setRefreshCounter] = useState(0)
  const animationFrameRef = useRef<number | null>(null)
  const smoothUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const updateSize = useCallback(() => {
    // Calculate width based on actual section widths + gaps only
    let totalWidth = 0

    // In add/remove mode, add section drop zone before first section
    if (editMode && layoutMode) {
      totalWidth += sectionPadding
    }

    // Use the actual calculated section widths
    sectionWidths.forEach((sectionWidth, sectionIndex) => {
      totalWidth += sectionWidth

      // Add extra width for add/remove mode drop zones
      if (editMode && layoutMode) {
        // Count ALL columns in this section (including empty ones)
        const columnCount = data.sections[sectionIndex].columns.length || 1

        // Drop zones: (N+1) zones × columnPadding px each (before first + after each column)
        const dropZonesWidth = (columnCount + 1) * columnPadding

        totalWidth += dropZonesWidth
      }

      // Add gap between sections (or section drop zone in add/remove mode)
      if (sectionIndex < sectionWidths.length - 1) {
        totalWidth += sectionPadding
      }
    })

    // In add/remove mode, add section drop zone after last section
    if (editMode && layoutMode) {
      totalWidth += sectionPadding
    }
    
    // Calculate height based on content positions (avoid DOM measurements that change with zoom)
    let maxHeight = 0
    
    data.sections.forEach(section => {
      section.columns.forEach(column => {
        column.nodes.forEach((node, nodeIndex) => {
          // Use cached height or default
          const nodeHeight = nodeHeights[node.id] || 150
          
          // Get node position - yPosition now represents center Y
          const nodeCenterY = node.yPosition !== undefined ? node.yPosition : (nodeIndex * 180 + 30 + nodeHeight / 2)
          const nodeTop = nodeCenterY - nodeHeight / 2
          const nodeBottom = nodeTop + nodeHeight
          maxHeight = Math.max(maxHeight, nodeBottom)
        })
      })
    })
    
    // Add header height, title height, and padding
    const headerHeight = 62 // Section header height (matches the -62px offset in columns)
    const titleHeight = data.title ? 80 : 0 // Graph title height when present (includes margin)
    const padding = 0 // No extra padding needed
    const dynamicHeight = Math.max(maxHeight + headerHeight + titleHeight + padding, 800) // Minimum 800px

    const newSize = { width: totalWidth, height: dynamicHeight }
    setSvgSize(newSize)
    onSizeChange(newSize)
  }, [sectionWidths, data.sections, layoutMode, nodeHeights, columnPadding, sectionPadding])

  useEffect(() => {
    // Immediate size calculation
    updateSize()
    
    // Also update after a short delay to ensure everything is settled
    const timeoutId = setTimeout(updateSize, 100)
    
    // Update on window resize
    const handleResize = () => {
      updateSize()
    }
    window.addEventListener("resize", handleResize)
    
    return () => {
      window.removeEventListener("resize", handleResize)
      clearTimeout(timeoutId)
    }
  }, [updateSize])
  
  // Update SVG size when section widths change
  useEffect(() => {
    updateSize()
  }, [sectionWidths, updateSize])

  // Refresh connections when column or section padding changes
  useEffect(() => {
    setRefreshCounter(prev => prev + 1)
  }, [columnPadding, sectionPadding])

  // Smooth edge updates during interactions using RAF
  useEffect(() => {
    const updateConnections = () => {
      if (smoothUpdates) {
        // Trigger re-render of connections by incrementing counter
        setRefreshCounter(prev => prev + 1)
        animationFrameRef.current = requestAnimationFrame(updateConnections)
      }
    }

    if (smoothUpdates) {
      animationFrameRef.current = requestAnimationFrame(updateConnections)
    } else if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [smoothUpdates])

  // Enable smooth updates when there are active interactions or in edit mode
  useEffect(() => {
    const hasActiveInteractions = highlightedNodes.size > 0 || hoveredConnections.size > 0
    const shouldUpdate = editMode || hasActiveInteractions
    
    // Clear any existing timeout
    if (smoothUpdateTimeoutRef.current) {
      clearTimeout(smoothUpdateTimeoutRef.current)
      smoothUpdateTimeoutRef.current = null
    }
    
    if (shouldUpdate) {
      // Enable immediately for active interactions or edit mode
      setSmoothUpdates(true)
    } else {
      // Add delay before disabling to allow smooth retraction
      smoothUpdateTimeoutRef.current = setTimeout(() => {
        setSmoothUpdates(false)
      }, 300) // 300ms delay for smooth retraction
    }
    
    return () => {
      if (smoothUpdateTimeoutRef.current) {
        clearTimeout(smoothUpdateTimeoutRef.current)
        smoothUpdateTimeoutRef.current = null
      }
    }
  }, [editMode, highlightedNodes.size, hoveredConnections.size])

  const findNodeLocation = (nodeId: string) => {
    for (let sectionIndex = 0; sectionIndex < data.sections.length; sectionIndex++) {
      for (let columnIndex = 0; columnIndex < data.sections[sectionIndex].columns.length; columnIndex++) {
        const node = data.sections[sectionIndex].columns[columnIndex].nodes.find((n) => n.id === nodeId)
        if (node) {
          return { sectionIndex, columnIndex }
        }
      }
    }
    return null
  }

  const findNodeTitle = (nodeId: string) => {
    for (let sectionIndex = 0; sectionIndex < data.sections.length; sectionIndex++) {
      for (let columnIndex = 0; columnIndex < data.sections[sectionIndex].columns.length; columnIndex++) {
        const node = data.sections[sectionIndex].columns[columnIndex].nodes.find((n) => n.id === nodeId)
        if (node) {
          return node.title
        }
      }
    }
    return nodeId // fallback to ID if not found
  }

  const findNodeColor = (nodeId: string) => {
    for (let sectionIndex = 0; sectionIndex < data.sections.length; sectionIndex++) {
      for (let columnIndex = 0; columnIndex < data.sections[sectionIndex].columns.length; columnIndex++) {
        const node = data.sections[sectionIndex].columns[columnIndex].nodes.find((n) => n.id === nodeId)
        if (node) {
          return node.color || '#6366f1' // fallback to indigo-500 if no custom color
        }
      }
    }
    return '#6366f1' // fallback to indigo-500 if not found
  }

  const connections = useMemo(() => {    
    return data.sections
    .flatMap((section, sectionIndex) =>
      section.columns.flatMap((column, columnIndex) =>
        column.nodes.flatMap((node) => {
          // Handle both old connectionIds and new connections format
          if (node.connections) {
            return node.connections.map((conn) => {
              const targetLocation = findNodeLocation(conn.targetId)
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
              }
            })
          } else {
            return node.connectionIds.map((connectionId) => {
              const targetLocation = findNodeLocation(connectionId)
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
              }
            })
          }
        }),
      ),
    )
    .filter((connection) => connection.start && connection.end)
  }, [data.sections, nodeRefs, refreshCounter, findNodeLocation]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateConfidence = (sourceId: string, targetId: string, newConfidence: number) => {
    setData((prevData: ToCData): ToCData => ({
      ...prevData,
      sections: prevData.sections.map((section) => ({
        ...section,
        columns: section.columns.map((column) => ({
          ...column,
          nodes: column.nodes.map((node) => {
            if (node.id === sourceId) {
              if (node.connections) {
                return {
                  ...node,
                  connections: node.connections.map((conn) => 
                    conn.targetId === targetId 
                      ? { ...conn, confidence: newConfidence }
                      : conn
                  )
                }
              } else {
                // Convert from old format to new format
                return {
                  ...node,
                  connections: node.connectionIds.map((connId) => ({
                    targetId: connId,
                    confidence: connId === targetId ? newConfidence : 50 // default medium confidence
                  }))
                }
              }
            }
            return node
          })
        }))
      }))
    }))
  }

  const updateConnection = (sourceId: string, targetId: string, evidence: string, assumptions: string) => {
    setData((prevData: ToCData): ToCData => ({
      ...prevData,
      sections: prevData.sections.map((section) => ({
        ...section,
        columns: section.columns.map((column) => ({
          ...column,
          nodes: column.nodes.map((node) => {
            if (node.id === sourceId) {
              if (node.connections) {
                return {
                  ...node,
                  connections: node.connections.map((conn) => 
                    conn.targetId === targetId 
                      ? { ...conn, evidence, assumptions }
                      : conn
                  )
                }
              } else {
                // Convert from old format to new format and add evidence/assumptions
                return {
                  ...node,
                  connections: node.connectionIds.map((connId) => ({
                    targetId: connId,
                    confidence: 50, // default medium confidence
                    evidence: connId === targetId ? evidence : '',
                    assumptions: connId === targetId ? assumptions : ''
                  }))
                }
              }
            }
            return node
          })
        }))
      }))
    }))
  }

  const strokeWidth = 3
  return (
    <>
    <svg
      className="absolute top-0 left-0 pointer-events-none z-0"
      width={svgSize.width}
      height={svgSize.height}
    >
      <defs>
        <marker
          id="arrowhead"
          markerWidth="5"
          markerHeight="5"
          refX="0"
          refY="3"
          orient="auto"
        >
          <polygon
            points="0 1, 5 3, 0 5"
            fill="#000000"
          />
        </marker>
      </defs>
      {connections.map((connection, index) => {
        if (!connection.start || !connection.end) return null

        // Get local positions using offsetTop/offsetLeft (immune to transforms)
        const startNode = connection.start
        const endNode = connection.end

        // Get the container element
        const container = containerRef.current || startNode.closest(".flex.relative")
        if (!container) return null

        // Calculate local positions relative to container
        const getLocalPosition = (element: HTMLElement) => {
          let x = 0, y = 0, width = element.offsetWidth, height = element.offsetHeight
          let current: HTMLElement | null = element

          // Walk up the offset parent chain until we reach the container
          while (current && current !== container) {
            x += current.offsetLeft
            y += current.offsetTop
            current = current.offsetParent as HTMLElement | null
          }

          return { x, y, width, height }
        }

        const startPos = getLocalPosition(startNode)
        const endPos = getLocalPosition(endNode)

        // Check if nodes are in the same column for vertical connections
        const isSameColumn = connection.sourceSectionIndex === connection.targetSectionIndex &&
                            connection.sourceColumnIndex === connection.targetColumnIndex

        let startX, startY, endX, endY

        if (isSameColumn) {
          // Vertical connection logic
          startX = startPos.x + startPos.width / 2
          endX = endPos.x + endPos.width / 2

          // Determine which node is higher (lower y position)
          if (startPos.y < endPos.y) {
            // Source is above target: go from bottom of source to top of target
            startY = startPos.y + startPos.height
            endY = endPos.y - 14 // Offset by arrow height
          } else {
            // Source is below target: go from top of source to bottom of target
            startY = startPos.y
            endY = endPos.y + endPos.height + 14 // Offset by arrow height
          }
        } else {
          // Horizontal connection logic
          startX = startPos.x + startPos.width
          startY = startPos.y + startPos.height / 2
          endX = endPos.x - 14 // Offset by arrow width
          endY = endPos.y + endPos.height / 2
        }

        // Calculate control points based on connection type
        let controlPointOffset
        if (isSameColumn) {
          // Straight line for vertical connections
          controlPointOffset = 0
        } else {
          // For horizontal connections, use X distance for curvature
          const baseOffset = Math.abs(endX - startX) / 2
          controlPointOffset = curvature === 0 ? 0 : baseOffset * (0.1 + curvature * 1.9)
        }

        const isHighlighted =
          highlightedNodes.has(connection.sourceId) ||
          highlightedNodes.has(connection.targetId)
        const isConnected =
          connectedNodes.has(connection.sourceId) &&
          connectedNodes.has(connection.targetId)
        const isHovered =
          hoveredConnections.has(connection.sourceId) &&
          hoveredConnections.has(connection.targetId)
        const hasHighlightedNodes = highlightedNodes.size > 0
        const isLowOpacity =
          hasHighlightedNodes &&
          (!connectedNodes.has(connection.sourceId) ||
            !connectedNodes.has(connection.targetId))

        const getStrokeStyle = () => {
          const baseStyle = getConfidenceStrokeStyle(connection.confidence)
          
          if (isHovered) {
            return { ...baseStyle, opacity: Math.min(1, baseStyle.opacity + 0.3) }
          } else if (isHighlighted) {
            return { ...baseStyle, opacity: Math.min(1, baseStyle.opacity + 0.4) }
          } else if (isConnected) {
            return { ...baseStyle, opacity: Math.min(1, baseStyle.opacity + 0.2) }
          } else {
            return { ...baseStyle, opacity: baseStyle.opacity * 0.7 }
          }
        }
        
        const strokeStyle = getStrokeStyle()
        const edgeKey = `${connection.sourceId}-${connection.targetId}`
        const isEdgeHovered = hoveredEdge === edgeKey

        return (
          <g key={index}>
            {/* Invisible thicker path for easier clicking */}
            <path
              d={isSameColumn
                ? `M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX + controlPointOffset} ${endY}, ${endX} ${endY}`
                : `M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX - controlPointOffset} ${endY}, ${endX} ${endY}`
              }
              className="fill-none cursor-pointer"
              style={{
                stroke: "transparent",
                strokeWidth: "20px", // Much thicker for easier clicking
                pointerEvents: hasHighlightedNodes && !isHighlighted ? "none" : "stroke",
              }}
              onMouseEnter={() => setHoveredEdge(edgeKey)}
              onMouseLeave={() => setHoveredEdge(null)}
              onClick={(e) => {
                e.stopPropagation()

                // Only allow clicking on highlighted edges when nodes are selected
                // Or allow all edges when no nodes are selected
                if (hasHighlightedNodes && !isHighlighted) {
                  return // Don't show popup for non-highlighted edges when nodes are selected
                }

                const midX = (startX + endX) / 2
                const midY = (startY + endY) / 2
                setEdgePopup({
                  sourceId: connection.sourceId,
                  targetId: connection.targetId,
                  x: midX,
                  y: midY,
                  confidence: connection.confidence,
                  evidence: connection.evidence,
                  assumptions: connection.assumptions,
                })
              }}
            />
            {/* Glow shadow layer */}
            <path
              d={isSameColumn
                ? `M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX + controlPointOffset} ${endY}, ${endX} ${endY}`
                : `M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX - controlPointOffset} ${endY}, ${endX} ${endY}`
              }
              className="fill-none"
              markerEnd="url(#arrowhead)"
              style={{
                stroke: 'rgba(0, 0, 0, 0.5)',
                strokeWidth: `${strokeWidth}px`,
                strokeDasharray: strokeStyle.strokeDasharray === 'none' ? undefined : strokeStyle.strokeDasharray,
                opacity: isEdgeHovered ? 1 : 0,
                pointerEvents: "none",
                filter: 'blur(3px)',
                transition: 'opacity 0.25s ease-in-out',
              }}
            />
            {/* Main visible path */}
            <path
              d={isSameColumn
                ? `M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX + controlPointOffset} ${endY}, ${endX} ${endY}`
                : `M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX - controlPointOffset} ${endY}, ${endX} ${endY}`
              }
              className="fill-none"
              markerEnd="url(#arrowhead)"
              style={{
                stroke: strokeStyle.stroke,
                strokeWidth: `${strokeWidth}px`,
                strokeDasharray: strokeStyle.strokeDasharray === 'none' ? undefined : strokeStyle.strokeDasharray,
                opacity: isLowOpacity ? 0.01 : strokeStyle.opacity,
                pointerEvents: "none", // This path doesn't handle clicks
                transition: smoothUpdates ? 'none' : 'd 0.15s ease-out, stroke 0.2s ease-out, opacity 0.2s ease-out, stroke-dasharray 0.2s ease-out',
              }}
            />
          </g>
        )
      })}

      {/* Ghost connection preview when exactly 2 nodes are selected */}
      {editMode && highlightedNodes.size === 2 && (() => {
        const nodeIds = Array.from(highlightedNodes);
        const [sourceId, targetId] = nodeIds;
        
        // Check if they're already connected
        const isAlreadyConnected = connections.some(conn => 
          (conn.sourceId === sourceId && conn.targetId === targetId) ||
          (conn.sourceId === targetId && conn.targetId === sourceId)
        );
        
        if (isAlreadyConnected) return null; // Don't show ghost if already connected
        
        const sourceRef = nodeRefs[sourceId];
        const targetRef = nodeRefs[targetId];

        if (!sourceRef || !targetRef) return null;

        // Get the container element
        const container = containerRef.current || sourceRef.closest(".flex.relative");

        if (!container) return null;

        // Use the same getLocalPosition function as normal edges
        const getLocalPosition = (element: HTMLElement) => {
          let x = 0, y = 0, width = element.offsetWidth, height = element.offsetHeight
          let current: HTMLElement | null = element

          // Walk up the offset parent chain until we reach the container
          while (current && current !== container) {
            x += current.offsetLeft
            y += current.offsetTop
            current = current.offsetParent as HTMLElement | null
          }

          return { x, y, width, height }
        }

        const startPos = getLocalPosition(sourceRef)
        const endPos = getLocalPosition(targetRef)

        // Check if nodes are in the same column for ghost connection
        const sourceLocation = findNodeLocation(sourceId);
        const targetLocation = findNodeLocation(targetId);
        const isGhostSameColumn = sourceLocation && targetLocation &&
                                 sourceLocation.sectionIndex === targetLocation.sectionIndex &&
                                 sourceLocation.columnIndex === targetLocation.columnIndex;

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
        } else {
          // Horizontal ghost connection logic (using local coordinates)
          startX = startPos.x + startPos.width;
          startY = startPos.y + startPos.height / 2;
          endX = endPos.x - 14;
          endY = endPos.y + endPos.height / 2;
        }

        // Calculate control points based on connection type
        let controlPointOffset;
        if (isGhostSameColumn) {
          // Straight line for vertical ghost connections
          controlPointOffset = 0;
        } else {
          const baseOffset = Math.abs(endX - startX) / 2;
          controlPointOffset = curvature === 0 ? 0 : baseOffset * (0.1 + curvature * 1.9);
        }
        
        // Get the style that a real connection would have (default confidence: 75)
        const ghostStrokeStyle = getConfidenceStrokeStyle(75);
        
        return (
          <g>
            {/* Ghost connection path - looks like real connection but more transparent */}
            <path
              d={isGhostSameColumn
                ? `M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX + controlPointOffset} ${endY}, ${endX} ${endY}`
                : `M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX - controlPointOffset} ${endY}, ${endX} ${endY}`
              }
              className="fill-none"
              markerEnd="url(#arrowhead)"
              style={{
                stroke: ghostStrokeStyle.stroke,
                strokeWidth: `${strokeWidth}px`, // Use same width as real connections
                strokeDasharray: ghostStrokeStyle.strokeDasharray === 'none' ? undefined : ghostStrokeStyle.strokeDasharray,
                opacity: 0.4, // Static transparency - no pulsing
                pointerEvents: "none"
              }}
            />
          </g>
        );
      })()}
    </svg>

    {/* Large center modal for edge information */}
    {edgePopup && (
      <EdgePopup
        edgePopup={edgePopup}
        setEdgePopup={setEdgePopup}
        updateConfidence={updateConfidence}
        findNodeTitle={findNodeTitle}
        findNodeColor={findNodeColor}
        svgSize={svgSize}
        editMode={editMode}
        onUpdateConnection={updateConnection}
        onDeleteConnection={onDeleteConnection}
      />
    )}
  </>
  )
}