import { InformationCircleIcon } from "@heroicons/react/16/solid"
import clsx from "clsx"
import React, { useEffect, useMemo, useRef, useState } from "react"

interface Node {
  id: string
  title: string
  text: string
  connectionIds: string[]
}

interface ToCData {
  sections: {
    title: string
    columns: {
      nodes: Node[]
    }[]
  }[]
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
  const [dragOverLocation, setDragOverLocation] = useState<{
    sectionIndex: number
    columnIndex: number
    nodeIndex?: number
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

  const handleDragStart = (node: Node) => {
    setDraggedNode(node)
  }

  const handleDragEnd = () => {
    setDraggedNode(null)
    setDragOverLocation(null)
  }

  const handleDragOver = (sectionIndex: number, columnIndex: number, isNewColumn: boolean = false, nodeIndex?: number) => {
    setDragOverLocation({ sectionIndex, columnIndex, isNewColumn, nodeIndex })
  }

  const findNodeLocation = (nodeId: string) => {
    for (let sectionIndex = 0; sectionIndex < data.sections.length; sectionIndex++) {
      for (let columnIndex = 0; columnIndex < data.sections[sectionIndex].columns.length; columnIndex++) {
        const node = data.sections[sectionIndex].columns[columnIndex].nodes.find((n) => n.id === nodeId)
        if (node) {
          return { sectionIndex, columnIndex, node }
        }
      }
    }
    return null
  }

  const handleDrop = (targetSectionIndex: number, targetColumnIndex: number, isNewColumn: boolean = false, nodeIndex?: number) => {
    if (!draggedNode) {
      console.log("No dragged node")
      return
    }

    const sourceLocation = findNodeLocation(draggedNode.id)
    if (!sourceLocation) {
      console.log("Source location not found for node:", draggedNode.id)
      return
    }

    if (
      !isNewColumn &&
      nodeIndex === undefined &&
      sourceLocation.sectionIndex === targetSectionIndex &&
      sourceLocation.columnIndex === targetColumnIndex
    ) {
      console.log("Same location, not moving")
      return
    }

    console.log("Moving node", draggedNode.id, "from", sourceLocation, "to", {targetSectionIndex, targetColumnIndex, isNewColumn, nodeIndex})

    setData((prevData) => {
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
        const newColumn = { nodes: [draggedNode] }
        targetSection.columns.splice(targetColumnIndex, 0, newColumn)
      } else if (nodeIndex !== undefined) {
        // Insert at specific position within column
        newData.sections[targetSectionIndex].columns[targetColumnIndex].nodes.splice(nodeIndex, 0, draggedNode)
      } else {
        // Add to end of existing column
        newData.sections[targetSectionIndex].columns[targetColumnIndex].nodes.push(draggedNode)
      }

      return newData
    })

    setDraggedNode(null)
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
            nodeLocation.node.connectionIds.forEach(connectedId => {
              if (!visited.has(connectedId)) {
                queue.push({nodeId: connectedId, path: [...path, connectedId]})
              }
            })
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
  }, [highlightedNodes, data])

  const hoveredConnections = useMemo(() => {
    if (!hoveredNode) return new Set<string>()

    const connections = new Set<string>()
    connections.add(hoveredNode)

    data.sections.forEach((section) => {
      section.columns.forEach((column) => {
        column.nodes.forEach((node) => {
          if (node.id === hoveredNode) {
            node.connectionIds.forEach((id) => connections.add(id))
          }
          if (node.connectionIds.includes(hoveredNode)) {
            connections.add(node.id)
          }
        })
      })
    })

    return connections
  }, [hoveredNode, data])

  return (
    <div className="flex relative gap-32">
      {data.sections.map((section, sectionIndex) => (
        <div key={sectionIndex} className="flex-1">
          <div className="flex gap-8">
            {/* Section title positioned to center over actual columns */}
            <div className="flex-1 flex flex-col">
              <div className="bg-gray-100 rounded-lg px-4 py-2 mb-4 mx-2">
                <h2
                  className={clsx(
                    "text-lg font-bold text-center",
                    sectionIndex === 0 && "text-red-700",
                    sectionIndex === data.sections.length - 1 && "text-green-700",
                    sectionIndex !== 0 &&
                      sectionIndex !== data.sections.length - 1 &&
                      "text-indigo-700",
                  )}
                >
                  {section.title}
                </h2>
              </div>
              <div className="flex gap-8">
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
                
                {/* Existing column */}
                <div 
                  className={clsx(
                    "flex-1 min-h-96 p-2 rounded-lg border-2 border-dashed transition-colors",
                    dragOverLocation?.sectionIndex === sectionIndex && 
                    dragOverLocation?.columnIndex === colIndex && 
                    !dragOverLocation?.isNewColumn
                      ? "border-blue-400 bg-blue-50"
                      : "border-transparent"
                  )}
                  onDragOver={(e) => {
                    e.preventDefault()
                    handleDragOver(sectionIndex, colIndex, false)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    handleDrop(sectionIndex, colIndex, false)
                  }}
                >
                  <div className="flex flex-col gap-4 justify-evenly min-h-96">
                    {/* Drop zone at top of column */}
                    <div 
                      className={clsx(
                        "h-8 rounded-lg transition-colors border-2 border-dashed flex items-center justify-center",
                        dragOverLocation?.sectionIndex === sectionIndex && 
                        dragOverLocation?.columnIndex === colIndex && 
                        dragOverLocation?.nodeIndex === 0
                          ? "bg-blue-200 border-blue-400"
                          : draggedNode 
                            ? "border-blue-200 bg-blue-50 hover:border-blue-300 hover:bg-blue-100" 
                            : "border-transparent"
                      )}
                      onDragOver={(e) => {
                        e.preventDefault()
                        handleDragOver(sectionIndex, colIndex, false, 0)
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        handleDrop(sectionIndex, colIndex, false, 0)
                      }}
                    >
                      {draggedNode && (
                        <div className="text-blue-400 text-xs font-medium">
                          Drop here
                        </div>
                      )}
                    </div>
                    {column.nodes.map((node, nodeIndex) => (
                      <React.Fragment key={node.id}>
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
                        {/* Drop zone after each node */}
                        <div 
                          className={clsx(
                            "h-8 rounded-lg transition-colors border-2 border-dashed flex items-center justify-center",
                            dragOverLocation?.sectionIndex === sectionIndex && 
                            dragOverLocation?.columnIndex === colIndex && 
                            dragOverLocation?.nodeIndex === nodeIndex + 1
                              ? "bg-blue-200 border-blue-400"
                              : draggedNode 
                                ? "border-blue-200 bg-blue-50 hover:border-blue-300 hover:bg-blue-100" 
                                : "border-transparent"
                          )}
                          onDragOver={(e) => {
                            e.preventDefault()
                            handleDragOver(sectionIndex, colIndex, false, nodeIndex + 1)
                          }}
                          onDrop={(e) => {
                            e.preventDefault()
                            handleDrop(sectionIndex, colIndex, false, nodeIndex + 1)
                          }}
                        >
                          {draggedNode && (
                            <div className="text-blue-400 text-xs font-medium">
                              Drop here
                            </div>
                          )}
                        </div>
                      </React.Fragment>
                    ))}
                  </div>
                </div>

                {/* Drop zone after column */}
                <div 
                  className={clsx(
                    "w-4 min-h-96 rounded-lg border-2 border-dashed transition-colors flex items-center justify-center",
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
  nodeRefs,
  highlightedNodes,
  connectedNodes,
  hoveredConnections,
}: {
  data: ToCData
  nodeRefs: { [key: string]: HTMLDivElement | null }
  highlightedNodes: Set<string>
  connectedNodes: Set<string>
  hoveredConnections: Set<string>
}) {
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const updateSize = () => {
      // Calculate based on the number of sections and estimate width
      const numSections = data.sections.length
      
      // Estimate dimensions based on content structure
      const estimatedWidth = numSections * 400 + (numSections - 1) * 128 // 400px per section + 128px gap
      const estimatedHeight = Math.max(window.innerHeight, 800) // At least 800px height
      
      setSvgSize({
        width: estimatedWidth + 200, // Add padding
        height: estimatedHeight + 200,
      })
    }
    
    updateSize()
    window.addEventListener("resize", updateSize)
    
    return () => {
      window.removeEventListener("resize", updateSize)
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

  const connections = data.sections
    .flatMap((section, sectionIndex) =>
      section.columns.flatMap((column, columnIndex) =>
        column.nodes.flatMap((node) =>
          node.connectionIds.map((connectionId) => {
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
            }
          }),
        ),
      ),
    )
    .filter((connection) => connection.start && connection.end)

  const strokeWidth = 12
  return (
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

        return (
          <path
            key={index}
            d={`M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX - controlPointOffset} ${endY}, ${endX} ${endY}`}
            className={clsx(
              "fill-none",
              isHovered
                ? "stroke-indigo-200"
                : isHighlighted
                  ? "stroke-indigo-300"
                  : isConnected
                    ? "stroke-indigo-300/60"
                    : "stroke-indigo-300/20",
            )}
            style={{
              strokeWidth: `${strokeWidth}px`,
              opacity: isLowOpacity ? 0.01 : 1,
            }}
          />
        )
      })}
    </svg>
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
  onDragStart: (node: Node) => void
  onDragEnd: () => void
}) {
  const [showPopup, setShowPopup] = useState(false)
  const nodeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    updateNodeRef(node.id, nodeRef.current)
  }, [node.id, updateNodeRef])

  const handleClick = () => {
    toggleHighlight(node.id)
  }

  const handleExpandClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowPopup(!showPopup)
  }

  return (
    <div className="relative">
      <div
        ref={nodeRef}
        draggable
        onDragStart={(e) => {
          onDragStart(node)
          e.dataTransfer.effectAllowed = "move"
        }}
        onDragEnd={onDragEnd}
        className={clsx(
          "flex border rounded-lg cursor-pointer transition-all w-48 h-32",
          isHighlighted
            ? "bg-indigo-200"
            : isHovered
              ? "bg-indigo-100"
              : "hover:bg-gray-100",
          hasHighlightedNodes && !isConnected && "opacity-30",
          isDragging && "opacity-50 scale-95 shadow-lg"
        )}
        onClick={handleClick}
        onMouseEnter={() => setHoveredNode(node.id)}
        onMouseLeave={() => setHoveredNode(null)}
      >
        <div className={clsx("flex-grow px-4 py-2 flex items-center justify-center", !node.text && "w-full")}>
          <div className="text-sm font-medium text-center">{node.title}</div>
        </div>
        {node.text && (
          <button
            className="flex shrink-0 items-center justify-center w-5 hover:bg-white rounded-r-lg"
            onClick={handleExpandClick}
          >
            <InformationCircleIcon className="h-4 w-4" />
          </button>
        )}
      </div>
      
      {showPopup && node.text && (
        <div className="absolute bottom-full left-0 mb-2 p-3 bg-white border border-gray-300 rounded-lg shadow-lg z-50 min-w-64 max-w-80">
          <div className="text-sm">{node.text}</div>
          <button
            className="absolute top-1 right-2 text-gray-500 hover:text-gray-700 text-lg leading-none"
            onClick={(e) => {
              e.stopPropagation()
              setShowPopup(false)
            }}
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
