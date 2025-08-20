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

export function ToC({ data: initialData }: { data: ToCData }) {
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

  const updateNodeRef = (id: string, ref: HTMLDivElement | null) => {
    setNodeRefs((prev) => ({ ...prev, [id]: ref }))
  }

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

  // Keyboard event handler for moving nodes
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Only handle arrow keys when nodes are highlighted
      if (highlightedNodes.size === 0) return
      
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
  }, [highlightedNodes, moveNodeVertically])

  const handleDragStart = (node: Node, event: React.DragEvent) => {
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

    const getShortestPaths = (clickedNodeId: string): Set<string> => {
      const pathNodes = new Set<string>()
      
      // Find all input nodes (first section)
      const inputNodes = data.sections[0]?.columns.flatMap(col => col.nodes.map(n => n.id)) || []
      
      // Find all goal nodes (last section)
      const goalNodes = data.sections[data.sections.length - 1]?.columns.flatMap(col => col.nodes.map(n => n.id)) || []
      
      // Function to find shortest path from start to target using BFS
      const findShortestPath = (startId: string, targetId: string): string[] | null => {
        const queue: {nodeId: string, path: string[]}[] = [{nodeId: startId, path: [startId]}]
        const visited = new Set<string>()
        
        while (queue.length > 0) {
          const {nodeId, path} = queue.shift()!
          
          if (nodeId === targetId) {
            return path
          }
          
          if (visited.has(nodeId)) continue
          visited.add(nodeId)
          
          const nodeLocation = findNodeLocation(nodeId)
          if (nodeLocation) {
            // Handle both old connectionIds and new connections format
            if (nodeLocation.node.connections) {
              nodeLocation.node.connections.forEach(conn => {
                if (!visited.has(conn.targetId)) {
                  queue.push({nodeId: conn.targetId, path: [...path, conn.targetId]})
                }
              })
            } else {
              nodeLocation.node.connectionIds.forEach(connectedId => {
                if (!visited.has(connectedId)) {
                  queue.push({nodeId: connectedId, path: [...path, connectedId]})
                }
              })
            }
          }
        }
        
        return null
      }
      
      // Find paths from input nodes to clicked node
      const pathsToClicked: string[][] = []
      inputNodes.forEach(inputId => {
        const path = findShortestPath(inputId, clickedNodeId)
        if (path) {
          pathsToClicked.push(path)
        }
      })
      
      // Find paths from clicked node to goal nodes
      const pathsFromClicked: string[][] = []
      goalNodes.forEach(goalId => {
        const path = findShortestPath(clickedNodeId, goalId)
        if (path) {
          pathsFromClicked.push(path)
        }
      })
      
      // If clicked node is an input node, just find paths to goals
      if (inputNodes.includes(clickedNodeId)) {
        pathsFromClicked.forEach(path => {
          path.forEach(nodeId => pathNodes.add(nodeId))
        })
      }
      // If clicked node is a goal node, just find paths from inputs
      else if (goalNodes.includes(clickedNodeId)) {
        pathsToClicked.forEach(path => {
          path.forEach(nodeId => pathNodes.add(nodeId))
        })
      }
      // For middle nodes, combine shortest paths through the clicked node
      else {
        pathsToClicked.forEach(pathToClicked => {
          pathsFromClicked.forEach(pathFromClicked => {
            // Combine paths, removing duplicate clicked node
            const fullPath = [...pathToClicked, ...pathFromClicked.slice(1)]
            fullPath.forEach(nodeId => pathNodes.add(nodeId))
          })
        })
      }
      
      return pathNodes
    }

    const allConnectedNodes = new Set<string>()
    highlightedNodes.forEach((nodeId) => {
      const pathNodes = getShortestPaths(nodeId)
      pathNodes.forEach(id => allConnectedNodes.add(id))
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
      style={{ minHeight: '100vh' }}
    >
      {data.sections.map((section, sectionIndex) => (
        <div key={sectionIndex}>
          <div className="flex gap-6">
            {/* Section title positioned to center over actual columns */}
            <div className="flex flex-col">
              <div className="bg-gray-700 rounded py-3 mb-2 px-3">
                <h2
                  className="text-3xl font-bold text-center text-white uppercase"
                >
                  {section.title}
                </h2>
              </div>
              <div className="flex gap-6">
            {section.columns.filter(column => column.nodes.length > 0).map((column, colIndex) => (
              <React.Fragment key={colIndex}>
                {/* Drop zone before first column */}
                {colIndex === 0 && (
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
                  className="relative w-48 min-h-screen"
                  onDragOver={(e) => {
                    e.preventDefault()
                    const rect = e.currentTarget.getBoundingClientRect()
                    const yPosition = e.clientY - rect.top
                    handleDragOver(sectionIndex, colIndex, false, yPosition)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    const rect = e.currentTarget.getBoundingClientRect()
                    const yPosition = e.clientY - rect.top
                    handleDrop(sectionIndex, colIndex, false, yPosition)
                  }}
                >
                  {column.nodes
                    .map((node, nodeIndex) => (
                      <div
                        key={node.id}
                        className="absolute w-full"
                        style={{
                          top: node.yPosition !== undefined 
                            ? `${node.yPosition}px` 
                            : `${nodeIndex * 180 + 30}px`, // Default spacing with more generous padding
                          left: 0
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
                        />
                      </div>
                    ))}
                </div>

                {/* Drop zone after column */}
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
              </React.Fragment>
            ))}
              </div>
            </div>
          </div>
        </div>
      ))}
      <Connections
        data={data}
        setData={setData}
        nodeRefs={nodeRefs}
        highlightedNodes={highlightedNodes}
        connectedNodes={connectedNodes}
        hoveredConnections={hoveredConnections}
      />
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
}: {
  data: ToCData
  setData: React.Dispatch<React.SetStateAction<ToCData>>
  nodeRefs: { [key: string]: HTMLDivElement | null }
  highlightedNodes: Set<string>
  connectedNodes: Set<string>
  hoveredConnections: Set<string>
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

  useEffect(() => {
    const updateSize = () => {
      // Calculate dimensions based on estimated layout
      const numSections = data.sections.length
      const maxNodesPerSection = Math.max(...data.sections.map(section => 
        Math.max(...section.columns.map(col => col.nodes.length), 1)
      ))
      
      // Calculate maximum columns per section
      const maxColumnsPerSection = Math.max(...data.sections.map(section => section.columns.length))
      
      // Estimate dimensions more reliably with moderate padding
      const nodeWidth = 192 // w-48 = 12rem = 192px
      const nodeHeight = 256 // h-64 = 16rem = 256px
      const sectionGap = 32 // gap-8 = 2rem = 32px
      const columnGap = 24 // gap-6 = 1.5rem = 24px
      const nodeGap = 8 // gap-2 = 0.5rem = 8px
      
      // More conservative width calculation
      const estimatedWidth = numSections * (nodeWidth * maxColumnsPerSection + columnGap * (maxColumnsPerSection + 1)) + (numSections - 1) * sectionGap
      const estimatedHeight = maxNodesPerSection * (nodeHeight + nodeGap) + 200 // extra for headers
      
      // Safe dimensions to ensure edges never get cut off
      const svgWidth = Math.max(estimatedWidth + 400, window.innerWidth * 1.2)
      const svgHeight = Math.max(estimatedHeight + 300, window.innerHeight * 1.2)
      
      setSvgSize({ width: svgWidth, height: svgHeight })
    }
    
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
  }, [data])

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

  const connections = data.sections
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

        const controlPointOffset = Math.abs(endX - startX) / 2

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
                Evidence & Assumptions
              </h3>
              {edgePopup.evidence || edgePopup.assumptions ? (
                <div className="space-y-4">
                  {edgePopup.evidence && (
                    <div>
                      <h4 className="font-medium text-gray-800 mb-2">Evidence:</h4>
                      <p className="text-gray-600 leading-relaxed">{edgePopup.evidence}</p>
                    </div>
                  )}
                  {edgePopup.assumptions && (
                    <div>
                      <h4 className="font-medium text-gray-800 mb-2">Key Assumptions:</h4>
                      <p className="text-gray-600 leading-relaxed">{edgePopup.assumptions}</p>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-gray-500 italic">
                  No evidence or assumptions have been documented for this connection yet.
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
}) {
  const [showPopup, setShowPopup] = useState(false)
  const nodeRef = useRef<HTMLDivElement>(null)
  const [showHint, setShowHint] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const hoverTimer = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    updateNodeRef(node.id, nodeRef.current)
  }, [node.id, updateNodeRef])

  const handleClick = () => {
    if (canExpand && node.text && !showPopup) {
      setShowPopup(true)
      setCanExpand(false)
      setShowHint(false)
    } else if (showPopup) {
      // Allow closing if already expanded
      setShowPopup(false)
    } else {
      toggleHighlight(node.id)
    }
  }

  const handleMouseEnter = () => {
    setHoveredNode(node.id)
    
    if (node.text && !showPopup) {
      // Start timer for hint
      hoverTimer.current = setTimeout(() => {
        setShowHint(true)
        setCanExpand(true)
      }, 1000) // 1 second delay
    }
  }

  const handleMouseLeave = () => {
    setHoveredNode(null)
    setShowHint(false)
    setCanExpand(false)
    
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
        draggable
        onDragStart={(e) => {
          onDragStart(node, e)
          e.dataTransfer.effectAllowed = "move"
        }}
        onDragEnd={onDragEnd}
        className={clsx(
          "flex flex-col border-0 rounded-xl cursor-pointer transition-all duration-500 ease-in-out bg-gradient-to-br from-white to-gray-50 shadow-lg hover:shadow-xl transform",
          showPopup ? "w-[32rem] h-auto min-h-80 p-6" : "w-48 hover:scale-105 pt-3 px-3 pb-6",
          isHighlighted
            ? "ring-4 ring-indigo-400 bg-gradient-to-br from-indigo-50 to-indigo-100"
            : isHovered
              ? "ring-2 ring-indigo-300 bg-gradient-to-br from-indigo-25 to-indigo-50"
              : "hover:shadow-2xl",
          hasHighlightedNodes && !isConnected && "opacity-30",
          isDragging && "opacity-50 scale-95 shadow-lg"
        )}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {showPopup ? (
          <div className="flex flex-col h-full relative">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-gray-200">
              <div className="text-xl font-bold text-indigo-700 flex-1 text-center">
                {node.title}
              </div>
              <button
                className="ml-2 p-1 rounded-full hover:bg-gray-200 text-gray-500 hover:text-gray-700 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowPopup(false)
                }}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="text-lg leading-relaxed text-gray-700 overflow-y-auto flex-1">
              {node.text}
            </div>
          </div>
        ) : (
          <div className="flex flex-col justify-center relative py-2">
            <div className="text-lg font-medium text-center leading-tight px-2 break-words">
              {node.title}
            </div>
            
            {/* Subtle visual cue for nodes with details */}
            {node.text && !showPopup && !showHint && (
              <div className="absolute bottom-2 right-2 w-1.5 h-1.5 rounded-full bg-indigo-400 opacity-30"></div>
            )}
          </div>
        )}
      </div>
      
      {/* Independent hint positioned relative to this specific node */}
      {node.text && showHint && canExpand && !showPopup && (
        <div className="absolute bottom-2 left-1/2 transform -translate-x-1/2 text-sm text-gray-500 text-center animate-fade-in-up whitespace-nowrap pointer-events-none z-10">
          click to view details
        </div>
      )}
    </div>
  )
}
