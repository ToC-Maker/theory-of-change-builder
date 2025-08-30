import clsx from "clsx"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ToCData, Node } from "../types"
import { NodeComponent } from "../components/NodeComponent"
import { ConnectionsComponent } from "../components/ConnectionsComponent"
import { EditToolbar } from "../components/EditToolbar"
import { Legend } from "../components/Legend"
import { NodePopup } from "../components/NodePopup"




export function ToC({ 
  data: initialData, 
  onSizeChange,
  onDataChange
}: { 
  data: ToCData
  onSizeChange?: (size: { width: number; height: number }) => void 
  onDataChange?: (data: ToCData) => void
}) {
  const [data, setData] = useState<ToCData>(initialData)
  
  // Create a wrapped setData that also notifies parent
  const setDataAndNotify = useCallback((newData: ToCData | ((prevData: ToCData) => ToCData)) => {
    setData((prevData) => {
      const updatedData = typeof newData === 'function' ? newData(prevData) : newData;
      // Always notify parent of changes using setTimeout to avoid infinite loops
      setTimeout(() => onDataChange?.(updatedData), 0);
      return updatedData;
    });
  }, [onDataChange]);
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
  const [curvature, setCurvature] = useState(initialData.curvature ?? 0.5)
  const [textSize, setTextSize] = useState(initialData.textSize ?? 1) // 0.5 to 2.0 scale
  const [nodeWidth, setNodeWidth] = useState(192) // Default width in pixels (w-48)
  const [nodeColor, setNodeColor] = useState('#ffffff') // Default white background
  const [nodePopup, setNodePopup] = useState<{
    id: string
    title: string
    text: string
  } | null>(null)
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 })
  const [legendPosition, setLegendPosition] = useState({ x: 20, y: 70 }) // Start 50px lower
  const [isDraggingLegend, setIsDraggingLegend] = useState(false)
  const [legendDragOffset, setLegendDragOffset] = useState({ x: 0, y: 0 })

  const updateNodeRef = useCallback((id: string, ref: HTMLDivElement | null) => {
    setNodeRefs((prev) => ({ ...prev, [id]: ref }))
  }, [])

  const handleLegendMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDraggingLegend(true)
    setLegendDragOffset({
      x: e.clientX - legendPosition.x,
      y: e.clientY - legendPosition.y
    })
  }, [legendPosition])

  const handleLegendMouseMove = useCallback((e: MouseEvent) => {
    if (isDraggingLegend) {
      setLegendPosition({
        x: e.clientX - legendDragOffset.x,
        y: e.clientY - legendDragOffset.y
      })
    }
  }, [isDraggingLegend, legendDragOffset])

  const handleLegendMouseUp = useCallback(() => {
    setIsDraggingLegend(false)
  }, [])

  useEffect(() => {
    if (isDraggingLegend) {
      document.addEventListener('mousemove', handleLegendMouseMove)
      document.addEventListener('mouseup', handleLegendMouseUp)
      return () => {
        document.removeEventListener('mousemove', handleLegendMouseMove)
        document.removeEventListener('mouseup', handleLegendMouseUp)
      }
    }
  }, [isDraggingLegend, handleLegendMouseMove, handleLegendMouseUp])

  // Update internal data state when prop changes
  useEffect(() => {
    console.log('ToC component received new initialData:', initialData);
    setData(initialData);
  }, [initialData]);

  // Update textSize and curvature when data changes
  useEffect(() => {
    if (initialData.textSize !== undefined) {
      setTextSize(initialData.textSize)
    }
    if (initialData.curvature !== undefined) {
      setCurvature(initialData.curvature)
    }
  }, [initialData.textSize, initialData.curvature])

  const copyGraphJSON = useCallback(async () => {
    try {
      const graphData = {
        ...data,
        // Include text size and curve shape as part of main data
        textSize,
        curvature,
        // Include additional UI state in metadata
        _metadata: {
          exportedAt: new Date().toISOString(),
          legendPosition,
        }
      }
      await navigator.clipboard.writeText(JSON.stringify(graphData, null, 2))
      // Could add a toast notification here if desired
    } catch (err) {
      console.error('Failed to copy JSON:', err)
    }
  }, [data, curvature, textSize, legendPosition])

  const toggleHighlight = (id: string, selectionMode: 'single' | 'multi' | 'column' = 'single') => {
    setHighlightedNodes((prev) => {
      if (selectionMode === 'multi') {
        // Multi-select mode (Ctrl held): toggle individual nodes
        const newSet = new Set(prev)
        if (newSet.has(id)) {
          newSet.delete(id)
        } else {
          newSet.add(id)
        }
        
        // When adding a node to selection, snap width slider and color to that node's properties
        if (newSet.size === 1 && newSet.has(id)) { // Only snap if this is the first/only selected node
          const nodeLocation = findNodeLocation(id)
          if (nodeLocation) {
            const node = nodeLocation.node
            const currentWidth = node.width || 192
            const currentColor = node.color || '#ffffff'
            setNodeWidth(currentWidth)
            setNodeColor(currentColor)
          }
        }
        return newSet
      } else if (selectionMode === 'column') {
        // Column select mode (Shift held): select all nodes in the same column
        const nodeLocation = findNodeLocation(id)
        if (nodeLocation) {
          const { sectionIndex, columnIndex } = nodeLocation
          const columnNodes = data.sections[sectionIndex].columns[columnIndex].nodes
          const columnNodeIds = columnNodes.map(node => node.id)
          
          // Check if all column nodes are already selected
          const allColumnNodesSelected = columnNodeIds.every(nodeId => prev.has(nodeId))
          
          if (allColumnNodesSelected) {
            // If all column nodes are selected, deselect them
            const newSet = new Set(prev)
            columnNodeIds.forEach(nodeId => newSet.delete(nodeId))
            return newSet
          } else {
            // Select all nodes in the column (add to existing selection)
            const newSet = new Set(prev)
            columnNodeIds.forEach(nodeId => newSet.add(nodeId))
            
            // Snap to the clicked node's properties
            const node = nodeLocation.node
            const currentWidth = node.width || 192
            const currentColor = node.color || '#ffffff'
            setNodeWidth(currentWidth)
            setNodeColor(currentColor)
            
            return newSet
          }
        }
        return prev
      } else {
        // Single select mode (default): clear existing selection and select only this node
        const newSet = new Set<string>()
        if (!prev.has(id) || prev.size > 1) {
          // Either this node wasn't selected, or multiple nodes were selected
          // In both cases, select only this node
          newSet.add(id)
          
          // Snap width slider and color to the selected node's properties
          const nodeLocation = findNodeLocation(id)
          if (nodeLocation) {
            const node = nodeLocation.node
            const currentWidth = node.width || 192
            const currentColor = node.color || '#ffffff'
            setNodeWidth(currentWidth)
            setNodeColor(currentColor)
          }
        }
        // If this node was the only selected node, deselect it (newSet remains empty)
        return newSet
      }
    })
  }


  const moveNodeVertically = useCallback((nodeId: string, direction: 'up' | 'down') => {
    const moveAmount = direction === 'up' ? -20 : 20
    
    setDataAndNotify((prevData) => ({
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
  }, [setDataAndNotify])

  const straightenEdges = useCallback(() => {
    if (!editMode) return
    
    setDataAndNotify((prevData) => {
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
      const tolerance = 40

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
  }, [editMode, setDataAndNotify, nodeRefs])

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
    return widths
  }, [data.sections])


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
    setNodeWidth(192)
    setNodeColor('#ffffff')
  }, [editMode, highlightedNodes, setDataAndNotify])

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
    setNodeWidth(192)
    setNodeColor('#ffffff')
  }, [editMode, highlightedNodes, setDataAndNotify, areNodesConnected, disconnectSelectedNodes])

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

    setDataAndNotify((prevData) => {
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
          // Clear selections when clicking empty space in both view and edit mode
          if (e.target === e.currentTarget) {
            setHighlightedNodes(new Set())
            // Reset controls to default when clearing selection
            setNodeWidth(192)
            setNodeColor('#ffffff')
          }
        }}
      >
      {data.sections.map((section, sectionIndex) => (
        <div key={sectionIndex}
             onClick={(e) => {
               // Allow deselection by clicking section area in both view and edit mode
               if (e.target === e.currentTarget) {
                 setHighlightedNodes(new Set())
                 setNodeWidth(192)
                 setNodeColor('#ffffff')
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
                      "w-8 min-h-96 rounded-lg border-2 border-dashed transition-colors flex items-center justify-center",
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
                    // Allow deselection by clicking column area in both view and edit mode
                    if (e.target === e.currentTarget) {
                      setHighlightedNodes(new Set())
                      setNodeWidth(192)
                      setNodeColor('#ffffff')
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
                          <NodeComponent
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
                      "w-8 min-h-screen rounded-lg border-2 border-dashed transition-colors flex items-center justify-center",
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
      
      <EditToolbar
        editMode={editMode}
        highlightedNodes={highlightedNodes}
        columnDragMode={columnDragMode}
        setColumnDragMode={setColumnDragMode}
        curvature={curvature}
        setCurvature={setCurvature}
        textSize={textSize}
        setTextSize={setTextSize}
        nodeWidth={nodeWidth}
        setNodeWidth={setNodeWidth}
        nodeColor={nodeColor}
        setNodeColor={setNodeColor}
        straightenEdges={straightenEdges}
        connectSelectedNodes={connectSelectedNodes}
        areNodesConnected={areNodesConnected}
        copyGraphJSON={copyGraphJSON}
        setData={setDataAndNotify}
      />

      {/* Hide the draggable legend since we now have it in the info panel */}
      {false && (
        <Legend
          legendPosition={legendPosition}
          setLegendPosition={setLegendPosition}
          isDraggingLegend={isDraggingLegend}
          setIsDraggingLegend={setIsDraggingLegend}
          legendDragOffset={legendDragOffset}
          setLegendDragOffset={setLegendDragOffset}
        />
      )}

      {/* Edit Mode Toggle Button - positioned at bottom right corner */}
      <div 
        className="absolute z-50"
        style={{
          right: '20px',
          bottom: editMode ? '80px' : '20px' // Move up when banner is visible
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
                setNodeWidth(192)
                setNodeColor('#ffffff')
              }
            }}
            className={`w-12 h-12 rounded-full shadow-lg transition-all duration-200 flex items-center justify-center ${
              editMode 
                ? 'bg-gray-800 text-white border border-gray-600' 
                : 'bg-gray-700 text-white hover:bg-gray-800 border border-gray-600'
            }`}
            title="Edit Mode"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
      </div>
      
      <ConnectionsComponent
        data={data}
        setData={setDataAndNotify}
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
      
      {nodePopup && (
        <NodePopup
          nodePopup={nodePopup}
          setNodePopup={setNodePopup}
          svgSize={svgSize}
        />
      )}
    </div>
  )
}

