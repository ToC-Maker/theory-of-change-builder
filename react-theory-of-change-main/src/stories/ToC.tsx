import clsx from "clsx"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"

interface Connection {
  targetId: string
  confidence: number // 0-100 scale
  evidence?: string // Evidence supporting this connection
  assumptions?: string // Key assumptions underlying this connection
}

interface Node {
  id: string
  title: string
  text: string
  connectionIds: string[]
  connections?: Connection[]
  yPosition?: number
  width?: number // Width in pixels (default 192px = w-48)
}

interface ToCData {
  sections: {
    title: string
    columns: {
      nodes: Node[]
    }[]
  }[]
}


function interpolateColor(value: number, min: number, max: number, colorStart: [number, number, number], colorEnd: [number, number, number]): [number, number, number] {
  const ratio = Math.max(0, Math.min(1, (value - min) / (max - min)))
  return [
    Math.round(colorStart[0] + ratio * (colorEnd[0] - colorStart[0])),
    Math.round(colorStart[1] + ratio * (colorEnd[1] - colorStart[1])),
    Math.round(colorStart[2] + ratio * (colorEnd[2] - colorStart[2]))
  ]
}

function getConfidenceColorRGB(confidence: number, opacity: number = 1): string {
  // Clamp confidence to 0-100 range
  const clampedConfidence = Math.max(0, Math.min(100, confidence))
  
  // Define color points: Red (0) -> Yellow (50) -> Green (100)
  const red: [number, number, number] = [239, 68, 68]    // red-500
  const yellow: [number, number, number] = [234, 179, 8] // yellow-500  
  const green: [number, number, number] = [34, 197, 94]  // green-500
  
  let color: [number, number, number]
  
  if (clampedConfidence <= 50) {
    // Interpolate from red to yellow (0-50)
    color = interpolateColor(clampedConfidence, 0, 50, red, yellow)
  } else {
    // Interpolate from yellow to green (50-100)
    color = interpolateColor(clampedConfidence, 50, 100, yellow, green)
  }
  
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${opacity})`
}

export function ToC({ 
  data: initialData, 
  onSizeChange 
}: { 
  data: ToCData
  onSizeChange?: (size: { width: number; height: number }) => void 
}) {
  const [data, setData] = useState<ToCData>(initialData)
  const [nodeRefs, setNodeRefs] = useState<{
    [key: string]: HTMLDivElement | null
  }>({})
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(
    new Set(),
  )
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [draggedNode, setDraggedNode] = useState<Node | null>(null)
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null)
  const [dragOverLocation, setDragOverLocation] = useState<{
    sectionIndex: number
    columnIndex: number
    yPosition?: number
    isNewColumn?: boolean
  } | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [columnDragMode, setColumnDragMode] = useState(false)
  const [curvature, setCurvature] = useState(0.5)
  const [textSize, setTextSize] = useState(1) // 0.5 to 2.0 scale
  const [nodeWidth, setNodeWidth] = useState(192) // Default width in pixels (w-48)
  const [nodePopup, setNodePopup] = useState<{
    id: string
    title: string
    text: string
  } | null>(null)
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 })

  const updateNodeRef = useCallback((id: string, ref: HTMLDivElement | null) => {
    setNodeRefs((prev) => ({ ...prev, [id]: ref }))
  }, [])

  const toggleHighlight = (id: string) => {
    setHighlightedNodes((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(id)) {
        newSet.delete(id)
      } else {
        newSet.add(id)
      }
      return newSet
    })
  }


  const moveNodeVertically = useCallback((nodeId: string, direction: 'up' | 'down') => {
    const moveAmount = direction === 'up' ? -20 : 20
    
    setData((prevData) => ({
      ...prevData,
      sections: prevData.sections.map((section) => ({
        ...section,
        columns: section.columns.map((column) => ({
          ...column,
          nodes: column.nodes.map((node, nodeIndex) => {
            if (node.id === nodeId) {
              // If node doesn't have a custom position, use its current visual position
              const currentY = node.yPosition ?? (nodeIndex * 180 + 30)
              return { ...node, yPosition: currentY + moveAmount }
            }
            return node
          })
        }))
      }))
    }))
  }, [setData])

  const straightenEdges = useCallback(() => {
    if (!editMode) return
    
    setData((prevData) => {
      // Collect all nodes with their actual center positions
      const allNodes: { node: Node; sectionIndex: number; columnIndex: number; nodeIndex: number; centerY: number; topY: number; height: number }[] = []
      
      prevData.sections.forEach((section, sectionIndex) => {
        section.columns.forEach((column, columnIndex) => {
          column.nodes.forEach((node, nodeIndex) => {
            const topY = node.yPosition ?? (nodeIndex * 180 + 30)
            
            // Get actual node height from DOM
            const nodeElement = nodeRefs[node.id]
            let actualHeight = 120 // Default fallback
            if (nodeElement) {
              const rect = nodeElement.getBoundingClientRect()
              actualHeight = rect.height
            }
            
            const centerY = topY + actualHeight / 2
            allNodes.push({ node, sectionIndex, columnIndex, nodeIndex, centerY, topY, height: actualHeight })
          })
        })
      })

      // Group nodes by similar center Y positions (within 60px tolerance - increased for better grouping)
      const groups: typeof allNodes[] = []
      const tolerance = 60

      allNodes.forEach((nodeData) => {
        let addedToGroup = false
        for (const group of groups) {
          const avgCenterY = group.reduce((sum, n) => sum + n.centerY, 0) / group.length
          if (Math.abs(nodeData.centerY - avgCenterY) <= tolerance) {
            group.push(nodeData)
            addedToGroup = true
            break
          }
        }
        if (!addedToGroup) {
          groups.push([nodeData])
        }
      })

      // Calculate the average center Y position for each group and update nodes
      const newData = { ...prevData }
      groups.forEach((group) => {
        if (group.length > 1) { // Only straighten groups with multiple nodes
          const avgCenterY = Math.round(group.reduce((sum, n) => sum + n.centerY, 0) / group.length)
          
          group.forEach(({ sectionIndex, columnIndex, nodeIndex, height }) => {
            const node = newData.sections[sectionIndex].columns[columnIndex].nodes[nodeIndex]
            // Calculate top position that will center this specific node at avgCenterY
            const alignedTopY = avgCenterY - height / 2
            
            newData.sections[sectionIndex].columns[columnIndex].nodes[nodeIndex] = {
              ...node,
              yPosition: alignedTopY
            }
          })
        }
      })

      return newData
    })
  }, [editMode, setData, nodeRefs])

  // Keyboard event handler for moving nodes
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only handle arrow keys when in edit mode and nodes are highlighted
      if (!editMode || highlightedNodes.size === 0) return
      
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        const direction = event.key === 'ArrowUp' ? 'up' : 'down'
        
        // Move all highlighted nodes
        highlightedNodes.forEach((nodeId) => {
          moveNodeVertically(nodeId, direction)
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editMode, highlightedNodes, moveNodeVertically])

  const handleDragStart = (node: Node, event: React.DragEvent) => {
    if (!editMode) {
      event.preventDefault()
      return
    }
    
    setDraggedNode(node)
    
    // Calculate the offset from where the user clicked to the top of the node
    const nodeElement = nodeRefs[node.id]
    if (nodeElement) {
      const rect = nodeElement.getBoundingClientRect()
      const offsetX = event.clientX - rect.left
      const offsetY = event.clientY - rect.top
      setDragOffset({ x: offsetX, y: offsetY })
    }
  }

  const handleDragEnd = () => {
    setDraggedNode(null)
    setDragOffset(null)
    setDragOverLocation(null)
  }

  const handleDragOver = (sectionIndex: number, columnIndex: number, isNewColumn: boolean = false, yPosition?: number) => {
    setDragOverLocation({ sectionIndex, columnIndex, isNewColumn, yPosition })
  }

  const findNodeLocation = useCallback((nodeId: string) => {
    for (let sectionIndex = 0; sectionIndex < data.sections.length; sectionIndex++) {
      for (let columnIndex = 0; columnIndex < data.sections[sectionIndex].columns.length; columnIndex++) {
        const node = data.sections[sectionIndex].columns[columnIndex].nodes.find((n) => n.id === nodeId)
        if (node) {
          return { sectionIndex, columnIndex, node }
        }
      }
    }
    return null
  }, [data.sections])

  // Calculate total width needed for each section (all columns + gaps)
  const sectionWidths = useMemo(() => {
    const widths = data.sections.map(section => {
      // Filter out empty columns
      const nonEmptyColumns = section.columns.filter(column => column.nodes.length > 0)
      
      if (nonEmptyColumns.length === 0) return 192 // Default width if no columns
      
      // Calculate width needed for each column (max node width in that column)
      const columnWidths = nonEmptyColumns.map(column => {
        const nodeWidths = column.nodes.map(node => node.width || 192)
        return Math.max(...nodeWidths, 192) // At least 192px per column
      })
      
      // Total width = sum of all column widths + gaps between columns
      const totalColumnWidth = columnWidths.reduce((sum, width) => sum + width, 0)
      const gaps = Math.max(0, columnWidths.length - 1) * 24 // gap-6 = 24px between columns
      
      return totalColumnWidth + gaps
    })
    console.log('sectionWidths updated:', widths, 'sections structure:', data.sections.map(s => s.columns.length))
    return widths
  }, [data.sections])

  const applyWidthToSelectedNodes = useCallback(() => {
    if (highlightedNodes.size === 0) return

    console.log('Applying width', nodeWidth, 'to nodes:', Array.from(highlightedNodes))
    setData((prevData) => ({
      ...prevData,
      sections: prevData.sections.map((section) => ({
        ...section,
        columns: section.columns.map((column) => ({
          ...column,
          nodes: column.nodes.map((node) => {
            if (highlightedNodes.has(node.id)) {
              console.log('Updating node', node.id, 'width from', node.width || 192, 'to', nodeWidth)
              return { ...node, width: nodeWidth }
            }
            return node
          })
        }))
      }))
    }))
  }, [highlightedNodes, nodeWidth, setData])

  const areNodesConnected = useCallback((sourceId: string, targetId: string) => {
    const sourceLocation = findNodeLocation(sourceId)
    if (!sourceLocation) return false
    
    const sourceNode = sourceLocation.node
    
    // Check if connection exists in either direction
    if (sourceNode.connections) {
      return sourceNode.connections.some(conn => conn.targetId === targetId)
    } else if (sourceNode.connectionIds) {
      return sourceNode.connectionIds.includes(targetId)
    }
    
    return false
  }, [findNodeLocation])

  const disconnectSelectedNodes = useCallback(() => {
    if (!editMode) return
    
    if (highlightedNodes.size !== 2) {
      return
    }

    const [sourceId, targetId] = Array.from(highlightedNodes)
    
    setData((prevData) => ({
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
                  connections: node.connections.filter(conn => conn.targetId !== targetId)
                }
              } else if (node.connectionIds) {
                return {
                  ...node,
                  connectionIds: node.connectionIds.filter(id => id !== targetId)
                }
              }
            }
            return node
          })
        }))
      }))
    }))

    // Clear selection after disconnecting
    setHighlightedNodes(new Set())
  }, [editMode, highlightedNodes, setData])

  const connectSelectedNodes = useCallback(() => {
    if (!editMode) return
    
    if (highlightedNodes.size !== 2) {
      alert('Please select exactly two nodes to connect')
      return
    }

    const [sourceId, targetId] = Array.from(highlightedNodes)
    
    // Check if nodes are already connected
    if (areNodesConnected(sourceId, targetId)) {
      // Disconnect them
      disconnectSelectedNodes()
      return
    }
    
    setData((prevData) => ({
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
                  connections: [...node.connections, { targetId, confidence: 75 }]
                }
              } else {
                return {
                  ...node,
                  connectionIds: [...node.connectionIds, targetId],
                  connections: [...(node.connectionIds.map(id => ({ targetId: id, confidence: 50 }))), { targetId, confidence: 75 }]
                }
              }
            }
            return node
          })
        }))
      }))
    }))

    // Clear selection after connecting
    setHighlightedNodes(new Set())
  }, [editMode, highlightedNodes, setData, areNodesConnected, disconnectSelectedNodes])

  const handleDrop = (targetSectionIndex: number, targetColumnIndex: number, isNewColumn: boolean = false, yPosition?: number) => {
    if (!draggedNode || !dragOffset) {
      console.log("No dragged node or drag offset")
      return
    }

    const sourceLocation = findNodeLocation(draggedNode.id)
    if (!sourceLocation) {
      console.log("Source location not found for node:", draggedNode.id)
      return
    }

    // If column dragging is disabled, only allow drops within the same column
    if (!columnDragMode && 
        (sourceLocation.sectionIndex !== targetSectionIndex || 
         sourceLocation.columnIndex !== targetColumnIndex || 
         isNewColumn)) {
      return
    }

    // Adjust yPosition by the drag offset so the node appears where the user grabbed it
    const adjustedYPosition = yPosition !== undefined ? yPosition - dragOffset.y : 20

    console.log("Moving node", draggedNode.id, "from", sourceLocation, "to", {targetSectionIndex, targetColumnIndex, isNewColumn, yPosition: adjustedYPosition})

    setData((prevData) => {
      // If we're just updating position in the same column, do it more precisely
      if (!isNewColumn && 
          sourceLocation.sectionIndex === targetSectionIndex && 
          sourceLocation.columnIndex === targetColumnIndex) {
        
        // Just update the yPosition of the specific node in place
        return {
          ...prevData,
          sections: prevData.sections.map((section, sIndex) => 
            sIndex === targetSectionIndex ? {
              ...section,
              columns: section.columns.map((column, cIndex) =>
                cIndex === targetColumnIndex ? {
                  ...column,
                  nodes: column.nodes.map((node) =>
                    node.id === draggedNode.id 
                      ? { ...node, yPosition: adjustedYPosition }
                      : node
                  )
                } : column
              )
            } : section
          )
        }
      }
      
      // For moves between different columns/sections, do the full remove and add
      const newData = { ...prevData }
      
      // Remove node from source location
      newData.sections = prevData.sections.map((section) => ({
        ...section,
        columns: section.columns.map((column) => ({
          ...column,
          nodes: column.nodes.filter((node) => node.id !== draggedNode.id),
        })),
      }))

      if (isNewColumn) {
        // Insert new column at the target position
        const targetSection = newData.sections[targetSectionIndex]
        const newColumn = { nodes: [{ ...draggedNode, yPosition: adjustedYPosition }] }
        targetSection.columns.splice(targetColumnIndex, 0, newColumn)
      } else {
        // Add node with custom yPosition to existing column
        const nodeWithPosition = { ...draggedNode, yPosition: adjustedYPosition }
        newData.sections[targetSectionIndex].columns[targetColumnIndex].nodes.push(nodeWithPosition)
      }

      return newData
    })

    setDraggedNode(null)
    setDragOffset(null)
    setDragOverLocation(null)
  }

  const connectedNodes = useMemo(() => {
    if (highlightedNodes.size === 0) {
      return new Set<string>()
    }

    const allConnectedNodes = new Set<string>()
    
    highlightedNodes.forEach((nodeId) => {
      // Add the selected node itself
      allConnectedNodes.add(nodeId)
      
      // Find the node's location and connections
      const nodeLocation = findNodeLocation(nodeId)
      if (nodeLocation) {
        const node = nodeLocation.node
        
        // Add nodes that this node connects TO (outgoing connections)
        if (node.connections) {
          node.connections.forEach(conn => allConnectedNodes.add(conn.targetId))
        } else if (node.connectionIds) {
          node.connectionIds.forEach(connId => allConnectedNodes.add(connId))
        }
      }
      
      // Find nodes that connect TO this node (incoming connections)
      data.sections.forEach(section => {
        section.columns.forEach(column => {
          column.nodes.forEach(otherNode => {
            if (otherNode.connections) {
              if (otherNode.connections.some(conn => conn.targetId === nodeId)) {
                allConnectedNodes.add(otherNode.id)
              }
            } else if (otherNode.connectionIds) {
              if (otherNode.connectionIds.includes(nodeId)) {
                allConnectedNodes.add(otherNode.id)
              }
            }
          })
        })
      })
    })

    return allConnectedNodes
  }, [highlightedNodes, data, findNodeLocation])

  const hoveredConnections = useMemo(() => {
    if (!hoveredNode) return new Set<string>()

    const connections = new Set<string>()
    connections.add(hoveredNode)

    data.sections.forEach((section) => {
      section.columns.forEach((column) => {
        column.nodes.forEach((node) => {
          if (node.id === hoveredNode) {
            // Handle both old connectionIds and new connections format
            if (node.connections) {
              node.connections.forEach((conn) => connections.add(conn.targetId))
            } else {
              node.connectionIds.forEach((id) => connections.add(id))
            }
          }
          // Check if any connection points to the hovered node
          const hasConnectionTo = node.connections 
            ? node.connections.some(conn => conn.targetId === hoveredNode)
            : node.connectionIds.includes(hoveredNode)
          if (hasConnectionTo) {
            connections.add(node.id)
          }
        })
      })
    })

    return connections
  }, [hoveredNode, data])

  return (
      
      <div 
        className="flex relative gap-8 min-w-fit overflow-visible" 
        style={{ 
          width: svgSize.width > 0 ? `${svgSize.width}px` : 'auto',
          height: svgSize.height > 0 ? `${svgSize.height}px` : '100vh'
        }}
        onClick={(e) => {
          // Only clear selections in view mode when clicking empty space
          if (!editMode && e.target === e.currentTarget) {
            setHighlightedNodes(new Set())
          }
        }}
      >
      {data.sections.map((section, sectionIndex) => (
        <div key={sectionIndex}
             onClick={(e) => {
               // Allow deselection by clicking section area in view mode
               if (!editMode && e.target === e.currentTarget) {
                 setHighlightedNodes(new Set())
               }
             }}>
          <div className={`flex ${editMode ? 'gap-6' : 'gap-4'}`}>
            {/* Section title positioned to center over actual columns */}
            <div className="flex flex-col">
              <div 
                className="bg-gray-700 rounded py-3 mb-2 px-3"
                style={{ 
                  minWidth: `${sectionWidths[sectionIndex] + (editMode && columnDragMode ? 32 : 0)}px` // Account for drop zones
                }}
              >
                <h2
                  className="text-3xl font-bold text-center text-white uppercase"
                >
                  {section.title}
                </h2>
              </div>
              <div className={`flex ${editMode && columnDragMode ? 'gap-8' : 'gap-6'}`}>
            {section.columns.filter(column => column.nodes.length > 0).map((column, colIndex) => (
              <React.Fragment key={colIndex}>
                {/* Drop zone before first column - only show when column dragging is enabled */}
                {editMode && columnDragMode && colIndex === 0 && (
                  <div 
                    className={clsx(
                      "w-4 min-h-96 rounded-lg border-2 border-dashed transition-colors flex items-center justify-center",
                      dragOverLocation?.sectionIndex === sectionIndex && 
                      dragOverLocation?.columnIndex === 0 && 
                      dragOverLocation?.isNewColumn
                        ? "border-green-400 bg-green-50"
                        : "border-transparent",
                      draggedNode ? "hover:border-green-300" : ""
                    )}
                    onDragOver={(e) => {
                      e.preventDefault()
                      handleDragOver(sectionIndex, 0, true)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      handleDrop(sectionIndex, 0, true)
                    }}
                  >
                    {dragOverLocation?.sectionIndex === sectionIndex && 
                     dragOverLocation?.columnIndex === 0 && 
                     dragOverLocation?.isNewColumn && (
                      <div className="text-green-600 text-xs font-medium rotate-90 whitespace-nowrap">
                        New Column
                      </div>
                    )}
                  </div>
                )}
                
                {/* Column with drag and keyboard positioning */}
                <div 
                  className="relative min-h-screen"
                  style={{ 
                    minWidth: `${Math.max(...column.nodes.map(node => node.width || 192), 192)}px`, 
                    width: `${Math.max(...column.nodes.map(node => node.width || 192), 192)}px` 
                  }}
                  onDragOver={editMode ? (e) => {
                    e.preventDefault()
                    const rect = e.currentTarget.getBoundingClientRect()
                    const yPosition = e.clientY - rect.top
                    handleDragOver(sectionIndex, colIndex, false, yPosition)
                  } : undefined}
                  onDrop={editMode ? (e) => {
                    e.preventDefault()
                    const rect = e.currentTarget.getBoundingClientRect()
                    const yPosition = e.clientY - rect.top
                    handleDrop(sectionIndex, colIndex, false, yPosition)
                  } : undefined}
                  onClick={(e) => {
                    // Allow deselection by clicking column area in view mode
                    if (!editMode && e.target === e.currentTarget) {
                      setHighlightedNodes(new Set())
                    }
                  }}
                >
                  {column.nodes
                    .map((node, nodeIndex) => {
                      const nodeWidth = node.width || 192
                      const columnWidth = Math.max(...column.nodes.map(node => node.width || 192), 192)
                      const leftOffset = Math.max(0, (columnWidth - nodeWidth) / 2)
                      
                      return (
                        <div
                          key={node.id}
                          className="absolute"
                          style={{
                            top: node.yPosition !== undefined 
                              ? `${node.yPosition}px` 
                              : `${nodeIndex * 180 + 30}px`, // Default spacing with more generous padding
                            left: `${leftOffset}px`,
                            width: `${nodeWidth}px`
                          }}
                        >
                          <Node
                            node={node}
                            updateNodeRef={updateNodeRef}
                            isHighlighted={highlightedNodes.has(node.id)}
                            isConnected={connectedNodes.has(node.id)}
                            isHovered={hoveredNode === node.id}
                            isDragging={draggedNode?.id === node.id}
                            toggleHighlight={toggleHighlight}
                            setHoveredNode={setHoveredNode}
                            hasHighlightedNodes={highlightedNodes.size > 0}
                            onDragStart={handleDragStart}
                            onDragEnd={handleDragEnd}
                            editMode={editMode}
                            textSize={textSize}
                            setNodePopup={setNodePopup}
                          />
                        </div>
                      )
                    })}
                </div>

                {/* Drop zone after column - only show when column dragging is enabled */}
                {editMode && columnDragMode && (
                  <div 
                    className={clsx(
                      "w-4 min-h-screen rounded-lg border-2 border-dashed transition-colors flex items-center justify-center",
                      dragOverLocation?.sectionIndex === sectionIndex && 
                      dragOverLocation?.columnIndex === colIndex + 1 && 
                      dragOverLocation?.isNewColumn
                        ? "border-green-400 bg-green-50"
                        : "border-transparent",
                      draggedNode ? "hover:border-green-300" : ""
                    )}
                    onDragOver={(e) => {
                      e.preventDefault()
                      handleDragOver(sectionIndex, colIndex + 1, true)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      handleDrop(sectionIndex, colIndex + 1, true)
                    }}
                  >
                    {dragOverLocation?.sectionIndex === sectionIndex && 
                     dragOverLocation?.columnIndex === colIndex + 1 && 
                     dragOverLocation?.isNewColumn && (
                      <div className="text-green-600 text-xs font-medium rotate-90 whitespace-nowrap">
                        New Column
                      </div>
                    )}
                  </div>
                )}
              </React.Fragment>
            ))}
              </div>
            </div>
          </div>
        </div>
      ))}
      
      {/* Edit button positioned at bottom right corner of SVG area */}
      <div 
        className="absolute z-50"
        style={{
          right: '20px',
          bottom: '20px'
        }}
      >
        <button
            onClick={() => {
              const newEditMode = !editMode
              setEditMode(newEditMode)
              if (!newEditMode) {
                // Clear selections and column drag mode when exiting edit mode
                setHighlightedNodes(new Set())
                setColumnDragMode(false)
              }
            }}
            className={`w-12 h-12 rounded-full shadow-lg transition-all duration-200 flex items-center justify-center ${
              editMode 
                ? 'bg-indigo-600 text-white' 
                : 'bg-white text-gray-600 hover:bg-gray-50 border border-gray-200'
            }`}
            title="Edit Mode"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        
        {/* Edit Tools Panel - positioned relative to the button */}
        {editMode && (
          <div className="absolute bottom-16 right-0 z-50 bg-white rounded-xl shadow-2xl border border-gray-200 p-2 min-w-32">
            <div className="flex items-center gap-1 mb-2 pb-2 border-b border-gray-100">
              <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              <h3 className="font-medium text-sm text-gray-900">Tools</h3>
            </div>
            
            <div className="grid grid-cols-2 gap-1">
              {/* Left Column */}
              <div className="space-y-1">
                {/* Straighten Edges Tool */}
                <button
                  onClick={straightenEdges}
                  className="w-full flex flex-col items-center gap-1 px-1 py-2 text-center text-gray-700 hover:bg-indigo-50 hover:text-indigo-600 rounded transition-colors"
                >
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                  <div>
                    <div className="font-medium text-xs">Straighten</div>
                    <div className="text-xs text-gray-500">Align nodes</div>
                  </div>
                </button>

                {/* Connect Nodes Tool */}
                <button
                  onClick={connectSelectedNodes}
                  disabled={highlightedNodes.size !== 2}
                  className={`w-full flex flex-col items-center gap-1 px-1 py-2 text-center rounded transition-colors ${
                    highlightedNodes.size === 2
                      ? 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-600'
                      : 'text-gray-400 cursor-not-allowed'
                  }`}
                >
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                  </svg>
                  <div>
                    <div className="font-medium text-xs">
                      {highlightedNodes.size === 2 && 
                       areNodesConnected(...Array.from(highlightedNodes)) 
                        ? 'Disconnect' 
                        : 'Connect'}
                    </div>
                    <div className="text-xs text-gray-500">
                      {highlightedNodes.size === 0 && 'Select 2'}
                      {highlightedNodes.size === 1 && 'Select 1 more'}
                      {highlightedNodes.size === 2 && (
                        areNodesConnected(...Array.from(highlightedNodes)) 
                          ? 'Remove link' 
                          : 'Create link'
                      )}
                      {highlightedNodes.size > 2 && 'Too many'}
                    </div>
                  </div>
                </button>
              </div>

              {/* Right Column */}
              <div className="space-y-1">
                {/* Column Drag Mode Toggle */}
                <button
                  onClick={() => setColumnDragMode(!columnDragMode)}
                  className={`w-full flex flex-col items-center gap-1 px-1 py-2 text-center rounded transition-colors ${
                    columnDragMode
                      ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                      : 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-600'
                  }`}
                >
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <div>
                    <div className="font-medium text-xs">Column Drag</div>
                    <div className="text-xs text-gray-500">
                      {columnDragMode ? 'Enabled' : 'Disabled'}
                    </div>
                  </div>
                </button>
              </div>
            </div>

            <div className="space-y-2 mt-2">
              {/* Curve Curvature Control */}
              <div className="px-3 py-2 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <svg className="w-4 h-4 flex-shrink-0 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  <span className="text-sm font-medium text-gray-700">Curve Shape</span>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center space-x-3">
                    <span className="text-xs text-gray-500 w-8">Flat</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={curvature}
                      onChange={(e) => setCurvature(parseFloat(e.target.value))}
                      className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-blue-200 to-indigo-400"
                    />
                    <span className="text-xs text-gray-500 w-10">Curved</span>
                  </div>
                  <div className="text-xs text-gray-500 text-center">
                    Adjust bezier curve intensity
                  </div>
                </div>
              </div>

              {/* Text Size Control */}
              <div className="px-3 py-2 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <svg className="w-4 h-4 flex-shrink-0 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="text-sm font-medium text-gray-700">Text Size</span>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center space-x-3">
                    <span className="text-xs text-gray-500 w-8">Small</span>
                    <input
                      type="range"
                      min="0.5"
                      max="2"
                      step="0.1"
                      value={textSize}
                      onChange={(e) => setTextSize(parseFloat(e.target.value))}
                      className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-gray-300 to-gray-600"
                    />
                    <span className="text-xs text-gray-500 w-8">Large</span>
                  </div>
                  <div className="text-xs text-gray-500 text-center">
                    Adjust node text size (Current: {Math.round(textSize * 100)}%)
                  </div>
                </div>
              </div>

              {/* Node Width Control */}
              <div className="px-3 py-2 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-3 mb-2">
                  <svg className="w-4 h-4 flex-shrink-0 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                  </svg>
                  <span className="text-sm font-medium text-gray-700">Node Width</span>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center space-x-3">
                    <span className="text-xs text-gray-500 w-10">Narrow</span>
                    <input
                      type="range"
                      min="128"
                      max="320"
                      step="16"
                      value={nodeWidth}
                      onChange={(e) => setNodeWidth(parseInt(e.target.value))}
                      className="flex-1 h-2 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-orange-300 to-orange-600"
                    />
                    <span className="text-xs text-gray-500 w-8">Wide</span>
                  </div>
                  <div className="text-xs text-gray-500 text-center">
                    Width: {nodeWidth}px - Apply to selected nodes
                  </div>
                  <button
                    onClick={applyWidthToSelectedNodes}
                    disabled={highlightedNodes.size === 0}
                    className={`w-full px-3 py-1 text-xs rounded transition-colors ${
                      highlightedNodes.size > 0
                        ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                        : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    }`}
                  >
                    {highlightedNodes.size === 0 
                      ? 'Select nodes to resize' 
                      : `Apply to ${highlightedNodes.size} selected node${highlightedNodes.size === 1 ? '' : 's'}`
                    }
                  </button>
                </div>
              </div>

              {/* Drag Info */}
              <div className="px-3 py-2 bg-gray-50 rounded-lg">
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16l-4-4m0 0l4-4m-4 4h18" />
                  </svg>
                  <span>Drag nodes to reposition</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-gray-600 mt-1">
                  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                  </svg>
                  <span>Use ↑↓ arrows to fine-tune</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      
      <Connections
        data={data}
        setData={setData}
        nodeRefs={nodeRefs}
        highlightedNodes={highlightedNodes}
        connectedNodes={connectedNodes}
        hoveredConnections={hoveredConnections}
        curvature={curvature}
        editMode={editMode}
        columnDragMode={columnDragMode}
        sectionWidths={sectionWidths}
        onSizeChange={(size) => {
          setSvgSize(size)
          onSizeChange?.(size)
        }}
      />
      
      {/* Node Details Modal */}
      {nodePopup && (
        <div 
          className="fixed z-50 flex items-center justify-center transition-all duration-150 ease-out"
          style={{
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            animation: 'fadeIn 0.15s ease-out'
          }}
        >
          {/* Backdrop with blur */}
          <div 
            className="absolute bg-black bg-opacity-50 backdrop-blur-sm"
            style={{
              top: 0,
              left: 0,
              width: '100vw',
              height: '100vh'
            }}
            onClick={() => setNodePopup(null)}
          />
          
          {/* Modal content */}
          <div 
            className="relative bg-white rounded-xl shadow-2xl p-8 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto transform transition-all duration-150 ease-out"
            style={{
              animation: 'scaleIn 0.15s ease-out'
            }}
          >
            {/* Close button */}
            <button
              className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-2xl leading-none"
              onClick={() => setNodePopup(null)}
            >
              ×
            </button>
            
            {/* Header */}
            <div className="mb-6">
              <h2 className="text-4xl font-bold text-gray-900 mb-2">
                {nodePopup.title}
              </h2>
            </div>
            
            {/* Content */}
            <div className="space-y-6">
              <div>
                <h3 className="text-2xl font-semibold text-gray-800 mb-3">
                  Details
                </h3>
                <p className="text-gray-600 leading-relaxed text-lg">
                  {nodePopup.text}
                </p>
              </div>
            </div>
            
            {/* Footer */}
            <div className="mt-8 pt-6 border-t border-gray-200 flex justify-end">
              <button
                onClick={() => setNodePopup(null)}
                className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Connections({
  data,
  setData,
  nodeRefs,
  highlightedNodes,
  connectedNodes,
  hoveredConnections,
  curvature,
  editMode,
  columnDragMode,
  sectionWidths,
  onSizeChange,
}: {
  data: ToCData
  setData: React.Dispatch<React.SetStateAction<ToCData>>
  nodeRefs: { [key: string]: HTMLDivElement | null }
  highlightedNodes: Set<string>
  connectedNodes: Set<string>
  hoveredConnections: Set<string>
  curvature: number
  editMode: boolean
  columnDragMode: boolean
  sectionWidths: number[]
  onSizeChange: (size: { width: number; height: number }) => void
}) {
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 })
  const [edgePopup, setEdgePopup] = useState<{
    sourceId: string
    targetId: string
    x: number
    y: number
    confidence: number
    evidence?: string
    assumptions?: string
  } | null>(null)
  const [smoothUpdates, setSmoothUpdates] = useState(false)
  const [refreshCounter, setRefreshCounter] = useState(0)
  const animationFrameRef = useRef<number | null>(null)
  const smoothUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const updateSize = useCallback(() => {
    // Calculate width based on actual section widths + gaps only
    let totalWidth = 0
    
    // Use the actual calculated section widths
    sectionWidths.forEach((sectionWidth, sectionIndex) => {
      totalWidth += sectionWidth
      
      // Add extra width for column drag mode drop zones
      if (editMode && columnDragMode) {
        // Count columns in this section
        const columnCount = data.sections[sectionIndex].columns.filter(column => column.nodes.length > 0).length
        
        // Drop zones: N+1 zones × 16px each
        const dropZonesWidth = (columnCount + 1) * 16
        
        // Gap calculation:
        // Normal mode: (N-1) gaps × 24px
        // Drag mode: 2N gaps × 32px (between dropzones and columns)
        // Extra gap width = 2N × 32 - (N-1) × 24 = 64N - 24N + 24 = 40N + 24
        const normalGapWidth = Math.max(0, columnCount - 1) * 24
        const dragGapWidth = 2 * columnCount * 32
        const extraGapWidth = dragGapWidth - normalGapWidth
        
        totalWidth += dropZonesWidth + extraGapWidth
      }
      
      // Add gap between sections (gap-8 = 32px) - only between sections, not on edges
      if (sectionIndex < sectionWidths.length - 1) {
        totalWidth += 32
      }
    })
    
    // Calculate height based on content positions (avoid DOM measurements that change with zoom)
    let maxHeight = 0
    
    data.sections.forEach(section => {
      section.columns.forEach(column => {
        column.nodes.forEach((node, nodeIndex) => {
          // Get node position (either custom yPosition or calculated position)
          const nodeTop = node.yPosition !== undefined ? node.yPosition : (nodeIndex * 180 + 30)
          
          // Use fixed node height instead of DOM measurement to avoid zoom effects
          const nodeHeight = 150 // Fixed height
          
          const nodeBottom = nodeTop + nodeHeight
          maxHeight = Math.max(maxHeight, nodeBottom)
        })
      })
    })
    
    // Add header height and padding
    const headerHeight = 80 // Approximate header height
    const padding = 100 // Extra padding for safety
    const dynamicHeight = Math.max(maxHeight + headerHeight + padding, 800) // Minimum 800px
    
    console.log('SVG updateSize called with sectionWidths:', sectionWidths, 'totalWidth:', totalWidth, 'dynamicHeight:', dynamicHeight)
    const newSize = { width: totalWidth, height: dynamicHeight }
    setSvgSize(newSize)
    onSizeChange(newSize)
  }, [sectionWidths, data.sections, editMode, columnDragMode])

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

  const strokeWidth = 12
  return (
    <>
    <svg
      className="absolute top-0 left-0 pointer-events-none"
      width={svgSize.width}
      height={svgSize.height}
    >
      {connections.map((connection, index) => {
        if (!connection.start || !connection.end) return null

        const startRect = connection.start.getBoundingClientRect()
        const endRect = connection.end.getBoundingClientRect()
        const containerRect = connection.start
          .closest(".flex.relative")
          ?.getBoundingClientRect()

        if (!containerRect) return null

        const startX = startRect.right - containerRect.left
        const startY = startRect.top + startRect.height / 2 - containerRect.top
        const endX = endRect.left - containerRect.left
        const endY = endRect.top + endRect.height / 2 - containerRect.top

        const baseOffset = Math.abs(endX - startX) / 2
        const controlPointOffset = curvature === 0 ? 0 : baseOffset * (0.1 + curvature * 1.9)

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

        const getStrokeColor = () => {
          if (isHovered) {
            return getConfidenceColorRGB(connection.confidence, 0.8)
          } else if (isHighlighted) {
            return getConfidenceColorRGB(connection.confidence, 1)
          } else if (isConnected) {
            return getConfidenceColorRGB(connection.confidence, 0.6)
          } else {
            return getConfidenceColorRGB(connection.confidence, 0.3)
          }
        }
        
        return (
          <path
            key={index}
            d={`M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX - controlPointOffset} ${endY}, ${endX} ${endY}`}
            className="fill-none cursor-pointer"
            style={{
              stroke: getStrokeColor(),
              strokeWidth: `${strokeWidth}px`,
              opacity: isLowOpacity ? 0.01 : 1,
              pointerEvents: "stroke",
              transition: smoothUpdates ? 'none' : 'd 0.15s ease-out, stroke 0.2s ease-out, opacity 0.2s ease-out',
            }}
            onClick={(e) => {
              e.stopPropagation()
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
        )
      })}
    </svg>
    
    {/* Large center modal for edge information */}
    {edgePopup && (
      <div 
        className="fixed z-50 flex items-center justify-center transition-all duration-150 ease-out"
        style={{
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          animation: 'fadeIn 0.15s ease-out'
        }}
      >
        {/* Backdrop with blur */}
        <div 
          className="absolute bg-black bg-opacity-50 backdrop-blur-sm"
          style={{
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh'
          }}
          onClick={() => setEdgePopup(null)}
        />
        
        {/* Modal content */}
        <div 
          className="relative bg-white rounded-xl shadow-2xl p-8 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto transform transition-all duration-150 ease-out"
          style={{
            animation: 'scaleIn 0.15s ease-out'
          }}
        >
          {/* Close button */}
          <button
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-2xl leading-none"
            onClick={() => setEdgePopup(null)}
          >
            ×
          </button>
          
          {/* Header */}
          <div className="mb-6">
            <h2 className="text-4xl font-bold text-gray-900 mb-2">
              Connection Details
            </h2>
            <div className="bg-gray-50 rounded-lg p-4 border-l-4 border-indigo-500">
              <div className="text-sm text-gray-600 uppercase tracking-wide font-semibold mb-2">
                Connection
              </div>
              <div className="flex items-center gap-4">
                <div className="flex-1 bg-white rounded p-3 border border-gray-200 shadow-sm">
                  <div className="text-sm text-gray-500 mb-1">From</div>
                  <div className="text-lg font-medium text-gray-900">{findNodeTitle(edgePopup.sourceId)}</div>
                </div>
                <div className="flex flex-col items-center">
                  <div className="w-8 h-8 bg-indigo-500 rounded-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5-5 5M6 12h12" />
                    </svg>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">leads to</div>
                </div>
                <div className="flex-1 bg-white rounded p-3 border border-gray-200 shadow-sm">
                  <div className="text-sm text-gray-500 mb-1">To</div>
                  <div className="text-lg font-medium text-gray-900">{findNodeTitle(edgePopup.targetId)}</div>
                </div>
              </div>
            </div>
          </div>
          
          {/* Content */}
          <div className="space-y-6">
            <div>
              <h3 className="text-2xl font-semibold text-gray-800 mb-3">
                Confidence Level
              </h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-700">Current confidence:</span>
                  <div className="flex items-center space-x-2">
                    <span className="text-2xl font-bold" style={{ color: getConfidenceColorRGB(edgePopup.confidence) }}>
                      {Math.round(edgePopup.confidence)}%
                    </span>
                    <span className="text-sm text-gray-500">
                      ({edgePopup.confidence <= 33 ? 'Low' : edgePopup.confidence <= 66 ? 'Medium' : 'High'})
                    </span>
                  </div>
                </div>
                
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Adjust confidence level:
                  </label>
                  <div className="space-y-3">
                    <div className="flex items-center space-x-4">
                      <span className="text-xs text-red-600 font-medium">0%</span>
                      <div className="flex-1 relative">
                        <input
                          type="range"
                          min="0"
                          max="100"
                          step="1"
                          value={edgePopup.confidence}
                          onChange={(e) => {
                            const newConfidence = parseInt(e.target.value)
                            updateConfidence(edgePopup.sourceId, edgePopup.targetId, newConfidence)
                            setEdgePopup({ ...edgePopup, confidence: newConfidence })
                          }}
                          className="w-full h-2 rounded-lg appearance-none cursor-pointer"
                          style={{
                            background: 'linear-gradient(to right, #ef4444 0%, #eab308 50%, #22c55e 100%)',
                          }}
                        />
                      </div>
                      <span className="text-xs text-green-600 font-medium">100%</span>
                    </div>
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>No confidence</span>
                      <span className="text-red-500">Low</span>
                      <span className="text-yellow-500">Medium</span>
                      <span className="text-green-500">High</span>
                      <span>Total confidence</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <div>
              <h3 className="text-2xl font-semibold text-gray-800 mb-3">
                Why this connection exists
              </h3>
              <p className="text-gray-600 leading-relaxed">
                This connection represents the causal relationship between these two elements in the theory of change. 
                The source element directly contributes to or enables the target element.
              </p>
            </div>
            
            <div>
              <h3 className="text-2xl font-semibold text-gray-800 mb-3">
                Assumptions & Evidence
              </h3>
              {edgePopup.evidence || edgePopup.assumptions ? (
                <div className="space-y-4">
                  {edgePopup.assumptions && (
                    <div>
                      <h4 className="font-medium text-gray-800 mb-2">Key Assumptions:</h4>
                      <p className="text-gray-600 leading-relaxed">{edgePopup.assumptions}</p>
                    </div>
                  )}
                  {edgePopup.evidence && (
                    <div>
                      <h4 className="font-medium text-gray-800 mb-2">Evidence:</h4>
                      <p className="text-gray-600 leading-relaxed">{edgePopup.evidence}</p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-gray-500 italic">
                  No assumptions or evidence have been documented for this connection yet.
                </p>
              )}
            </div>
            
            <div className={`p-4 rounded-lg ${
              edgePopup.confidence >= 67 ? 'bg-green-50' :
              edgePopup.confidence >= 34 ? 'bg-yellow-50' :
              'bg-red-50'
            }`}>
              <h4 className={`font-medium mb-2 ${
                edgePopup.confidence >= 67 ? 'text-green-900' :
                edgePopup.confidence >= 34 ? 'text-yellow-900' :
                'text-red-900'
              }`}>
                Confidence Insight
              </h4>
              <p className={`text-sm ${
                edgePopup.confidence >= 67 ? 'text-green-700' :
                edgePopup.confidence >= 34 ? 'text-yellow-700' :
                'text-red-700'
              }`}>
                {edgePopup.confidence >= 80
                  ? `Very strong confidence (${Math.round(edgePopup.confidence)}%). This connection has robust evidence and high certainty.`
                  : edgePopup.confidence >= 60
                  ? `Good confidence (${Math.round(edgePopup.confidence)}%). This connection has solid evidence with some certainty.`
                  : edgePopup.confidence >= 40
                  ? `Moderate confidence (${Math.round(edgePopup.confidence)}%). This connection has reasonable evidence but uncertainty remains.`
                  : edgePopup.confidence >= 20
                  ? `Low confidence (${Math.round(edgePopup.confidence)}%). This connection has limited evidence and significant uncertainty.`
                  : `Very low confidence (${Math.round(edgePopup.confidence)}%). This connection is speculative with minimal supporting evidence.`}
              </p>
            </div>
          </div>
          
          {/* Footer */}
          <div className="mt-8 pt-6 border-t border-gray-200 flex justify-end">
            <button
              onClick={() => setEdgePopup(null)}
              className="px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    )}
  </>
  )
}

function Node({
  node,
  updateNodeRef,
  isHighlighted,
  isConnected,
  isHovered,
  isDragging,
  toggleHighlight,
  setHoveredNode,
  hasHighlightedNodes,
  onDragStart,
  onDragEnd,
  editMode,
  textSize,
  setNodePopup,
}: {
  node: Node
  updateNodeRef: (id: string, ref: HTMLDivElement | null) => void
  isHighlighted: boolean
  isConnected: boolean
  isHovered: boolean
  isDragging: boolean
  toggleHighlight: (id: string) => void
  setHoveredNode: (id: string | null) => void
  hasHighlightedNodes: boolean
  onDragStart: (node: Node, event: React.DragEvent) => void
  onDragEnd: () => void
  editMode: boolean
  textSize: number
  setNodePopup: React.Dispatch<React.SetStateAction<{ id: string; title: string; text: string } | null>>
}) {
  const nodeRef = useRef<HTMLDivElement>(null)
  const [showHint, setShowHint] = useState(false)
  const [canViewDetails, setCanViewDetails] = useState(false)
  const hoverTimer = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    updateNodeRef(node.id, nodeRef.current)
  }, [node.id, updateNodeRef])

  const handleClick = () => {
    if (node.text && canViewDetails && showHint) {
      setNodePopup({
        id: node.id,
        title: node.title,
        text: node.text
      })
    } else {
      toggleHighlight(node.id)
    }
  }

  const handleMouseEnter = () => {
    setHoveredNode(node.id)
    
    if (node.text) {
      // Start timer for hint
      hoverTimer.current = setTimeout(() => {
        setShowHint(true)
        setCanViewDetails(true)
      }, 1000) // 1 second delay
    }
  }

  const handleMouseLeave = () => {
    setHoveredNode(null)
    setShowHint(false)
    setCanViewDetails(false)
    
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const handleDoubleClick = () => {
    toggleHighlight(node.id)
  }

  return (
    <div className="relative">
      <div
        ref={nodeRef}
        draggable={editMode}
        onDragStart={editMode ? (e) => {
          onDragStart(node, e)
          e.dataTransfer.effectAllowed = "move"
        } : undefined}
        onDragEnd={editMode ? onDragEnd : undefined}
        className={clsx(
          "flex flex-col border-0 rounded-xl cursor-pointer transition-all duration-500 ease-in-out bg-gradient-to-br from-white to-gray-50 shadow-lg hover:shadow-xl transform hover:scale-105 pt-3 px-3 pb-6",
          isHighlighted
            ? "ring-4 ring-indigo-400 bg-gradient-to-br from-indigo-50 to-indigo-100"
            : isHovered
              ? "ring-2 ring-indigo-300 bg-gradient-to-br from-indigo-25 to-indigo-50"
              : "hover:shadow-2xl",
          hasHighlightedNodes && !isConnected && "opacity-30",
          isDragging && "opacity-50 scale-95 shadow-lg"
        )}
        style={{
          width: `${node.width || 192}px`
        }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex flex-col justify-center relative py-2">
          <div 
            className="font-medium text-center leading-tight px-2 break-words"
            style={{ fontSize: `${textSize * 1.125}rem` }} // 1.125rem is text-lg base size
          >
            {node.title}
          </div>
          
          {/* Subtle visual cue for nodes with details */}
          {node.text && !showHint && (
            <div className="absolute bottom-2 right-2 w-1.5 h-1.5 rounded-full bg-indigo-400 opacity-30"></div>
          )}
        </div>
      </div>
      
      {/* Hover hint for nodes with details */}
      {node.text && showHint && (
        <div className="absolute bottom-2 left-1/2 transform -translate-x-1/2 text-sm text-gray-500 text-center animate-fade-in-up whitespace-nowrap pointer-events-none z-10">
          click to view details
        </div>
      )}
    </div>
  )
}
