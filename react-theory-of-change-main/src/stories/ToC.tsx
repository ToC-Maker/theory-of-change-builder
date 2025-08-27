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
  color?: string // Background color (default white)
}

interface ToCData {
  sections: {
    title: string
    columns: {
      nodes: Node[]
    }[]
  }[]
  textSize?: number // Optional text size scaling factor (0.5 to 2.0)
  curvature?: number // Optional curve shape setting (0.0 to 1.0)
}



function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  // Remove # if present
  hex = hex.replace('#', '')
  
  if (hex.length === 3) {
    // Convert 3-digit hex to 6-digit
    hex = hex.split('').map(char => char + char).join('')
  }
  
  const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null
}

function isColorDark(hexColor: string): boolean {
  const rgb = hexToRgb(hexColor)
  if (!rgb) return false
  
  // Calculate relative luminance using WCAG formula
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255
  
  // Return true if color is dark (luminance < 0.5)
  return luminance < 0.5
}

function getContrastTextColor(backgroundColor: string): string {
  return isColorDark(backgroundColor) ? '#ffffff' : '#000000'
}

function getConfidenceStrokeStyle(confidence: number): { 
  strokeDasharray: string;
  stroke: string;
  opacity: number;
} {
  // Clamp confidence to 0-100 range
  const clampedConfidence = Math.max(0, Math.min(100, confidence))
  
  // Use black color for all connections
  const stroke = '#000000' // black
  
  if (clampedConfidence >= 67) {
    // High confidence: solid line
    return {
      strokeDasharray: 'none',
      stroke,
      opacity: 1.0
    }
  } else if (clampedConfidence >= 34) {
    // Medium confidence: dashed line
    return {
      strokeDasharray: '8 4', // 8px dash, 4px gap (adjusted for thinner lines)
      stroke,
      opacity: 0.9
    }
  } else {
    // Low confidence: dotted line
    return {
      strokeDasharray: '2 4', // 2px dot, 4px gap (adjusted for thinner lines)
      stroke,
      opacity: 0.8
    }
  }
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
    setNodeWidth(192)
    setNodeColor('#ffffff')
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
      
      {/* Edit Tools Banner - positioned at bottom of graph */}
      {editMode && (
        <div className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200 shadow-lg">
          <div className="max-w-none mx-auto px-4 py-4" style={{ maxWidth: '120rem' }}>
            <div className="flex items-center justify-between">
              {/* Left side - Main tools */}
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                  <h3 className="font-medium text-gray-900">Edit Tools</h3>
                </div>
                
                {/* Action Buttons */}
                <div className="flex items-center gap-4">
                  {/* Straighten Edges Tool */}
                  <button
                    onClick={straightenEdges}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-600 rounded-lg transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                    </svg>
                    <span>Straighten</span>
                  </button>

                  {/* Connect Nodes Tool */}
                  <button
                    onClick={connectSelectedNodes}
                    disabled={highlightedNodes.size !== 2}
                    className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                      highlightedNodes.size === 2
                        ? 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-600'
                        : 'text-gray-400 cursor-not-allowed'
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                    <span>
                      {highlightedNodes.size === 0 && 'Connect (Select 2)'}
                      {highlightedNodes.size === 1 && 'Connect (Select 1 more)'}
                      {highlightedNodes.size === 2 && (() => {
                        const [sourceId, targetId] = Array.from(highlightedNodes)
                        return areNodesConnected(sourceId, targetId) ? 'Disconnect' : 'Connect'
                      })()}
                      {highlightedNodes.size > 2 && 'Connect (Too many selected)'}
                    </span>
                  </button>

                  {/* Column Drag Mode Toggle */}
                  <button
                    onClick={() => setColumnDragMode(!columnDragMode)}
                    className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                      columnDragMode
                        ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                        : 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-600'
                    }`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    <span>Column Drag: {columnDragMode ? 'On' : 'Off'}</span>
                  </button>

                  {/* Copy JSON Button */}
                  <button
                    onClick={copyGraphJSON}
                    className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-green-50 hover:text-green-600 rounded-lg transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                    <span>Copy JSON</span>
                  </button>
                </div>
              </div>

              {/* Right side - Controls and Close */}
              <div className="flex items-center gap-6">
                {/* Curve Control */}
                <div className="flex items-center gap-3">
                  <label className="text-sm text-gray-700">Curve:</label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">Flat</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.1"
                      value={curvature}
                      onChange={(e) => setCurvature(parseFloat(e.target.value))}
                      className="w-20 h-2 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-blue-200 to-indigo-400"
                    />
                    <span className="text-xs text-gray-500">Curved</span>
                  </div>
                </div>

                {/* Text Size Control */}
                <div className="flex items-center gap-3">
                  <label className="text-sm text-gray-700">Text Size:</label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">S</span>
                    <input
                      type="range"
                      min="0.5"
                      max="2"
                      step="0.1"
                      value={textSize}
                      onChange={(e) => setTextSize(parseFloat(e.target.value))}
                      className="w-20 h-2 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-gray-300 to-gray-600"
                    />
                    <span className="text-xs text-gray-500">L</span>
                  </div>
                </div>

                {/* Node Width Control */}
                <div className="flex items-center gap-3">
                  <label className="text-sm text-gray-700">Width:</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min="128"
                      max="320"
                      step="16"
                      value={nodeWidth}
                      onChange={(e) => {
                        const newWidth = parseInt(e.target.value)
                        setNodeWidth(newWidth)
                        // Auto-apply to selected nodes
                        if (highlightedNodes.size > 0) {
                          setData((prevData) => ({
                            ...prevData,
                            sections: prevData.sections.map((section) => ({
                              ...section,
                              columns: section.columns.map((column) => ({
                                ...column,
                                nodes: column.nodes.map((node) => {
                                  if (highlightedNodes.has(node.id)) {
                                    return { ...node, width: newWidth }
                                  }
                                  return node
                                })
                              }))
                            }))
                          }))
                        }
                      }}
                      className="w-20 h-2 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-orange-300 to-orange-600"
                    />
                    <span className="text-xs text-gray-500 w-10">{nodeWidth}px</span>
                  </div>
                </div>

                {/* Node Color Control */}
                <div className="flex items-center gap-3">
                  <label className="text-sm text-gray-700">Color:</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={nodeColor}
                      onChange={(e) => {
                        const newColor = e.target.value
                        setNodeColor(newColor)
                        // Auto-apply to selected nodes
                        if (highlightedNodes.size > 0) {
                          setData((prevData) => ({
                            ...prevData,
                            sections: prevData.sections.map((section) => ({
                              ...section,
                              columns: section.columns.map((column) => ({
                                ...column,
                                nodes: column.nodes.map((node) => {
                                  if (highlightedNodes.has(node.id)) {
                                    return { ...node, color: newColor }
                                  }
                                  return node
                                })
                              }))
                            }))
                          }))
                        }
                      }}
                      className="w-8 h-8 rounded border border-gray-300 cursor-pointer"
                      title="Node background color"
                    />
                    <button
                      onClick={() => {
                        setNodeColor('#ffffff')
                        // Auto-apply to selected nodes
                        if (highlightedNodes.size > 0) {
                          setData((prevData) => ({
                            ...prevData,
                            sections: prevData.sections.map((section) => ({
                              ...section,
                              columns: section.columns.map((column) => ({
                                ...column,
                                nodes: column.nodes.map((node) => {
                                  if (highlightedNodes.has(node.id)) {
                                    return { ...node, color: '#ffffff' }
                                  }
                                  return node
                                })
                              }))
                            }))
                          }))
                        }
                      }}
                      className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors"
                      title="Reset to white"
                    >
                      Reset
                    </button>
                  </div>
                  {highlightedNodes.size > 0 && (
                    <span className="text-xs text-gray-500">
                      ({highlightedNodes.size} selected)
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Connection Confidence Legend - draggable */}
      <div 
        className={`absolute z-40 bg-white rounded-lg shadow-lg border border-gray-200 p-3 select-none ${
          isDraggingLegend ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        style={{
          left: `${legendPosition.x}px`,
          top: `${legendPosition.y}px`
        }}
        onMouseDown={handleLegendMouseDown}
      >
        <div className="text-xs font-medium text-gray-700 mb-2">Connection Confidence</div>
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <svg width="24" height="2" className="flex-shrink-0">
              <line x1="0" y1="1" x2="24" y2="1" stroke="#000000" strokeWidth="2" />
            </svg>
            <span className="text-xs text-gray-600">High</span>
          </div>
          <div className="flex items-center gap-3">
            <svg width="24" height="2" className="flex-shrink-0">
              <line x1="0" y1="1" x2="24" y2="1" stroke="#000000" strokeWidth="2" strokeDasharray="8 4" />
            </svg>
            <span className="text-xs text-gray-600">Medium</span>
          </div>
          <div className="flex items-center gap-3">
            <svg width="24" height="2" className="flex-shrink-0">
              <line x1="0" y1="1" x2="24" y2="1" stroke="#000000" strokeWidth="2" strokeDasharray="2 4" />
            </svg>
            <span className="text-xs text-gray-600">Low</span>
          </div>
        </div>
      </div>

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
            className="relative bg-white rounded-xl shadow-2xl p-8 max-w-xl w-full mx-4 max-h-[80vh] overflow-y-auto transform transition-all duration-150 ease-out"
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
              <h2 className="text-lg font-bold text-gray-900 mb-2">
                {nodePopup.title}
              </h2>
            </div>
            
            {/* Content */}
            <div className="space-y-6">
              <div>
                <hr className="border-gray-300 mb-3" />
                <p className="text-gray-600 leading-relaxed text-sm">
                  {nodePopup.text}
                </p>
              </div>
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
    minConfidence?: number
    maxConfidence?: number
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
        
        // Drop zones: N+1 zones × 32px each
        const dropZonesWidth = (columnCount + 1) * 32
        
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

  const strokeWidth = 3
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
        
        return (
          <g key={index}>
            {/* Invisible thicker path for easier clicking */}
            <path
              d={`M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX - controlPointOffset} ${endY}, ${endX} ${endY}`}
              className="fill-none cursor-pointer"
              style={{
                stroke: "transparent",
                strokeWidth: "15px", // Much thicker for easier clicking
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
            {/* Visible styled path */}
            <path
              d={`M ${startX} ${startY} C ${startX + controlPointOffset} ${startY}, ${endX - controlPointOffset} ${endY}, ${endX} ${endY}`}
              className="fill-none"
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
            <div 
              className="bg-gray-50 rounded-lg p-4 border-l-4 border-r-4"
              style={{ 
                borderLeftColor: '#000000',
                borderRightColor: '#000000'
              }}
            >
              <div className="text-sm text-gray-600 uppercase tracking-wide font-semibold mb-2">
                Connection
              </div>
              <div className="flex items-center gap-4">
                <div 
                  className="flex-1 rounded-xl p-3 border-0 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.3),_0_4px_6px_-2px_rgba(0,0,0,0.15)] text-center"
                  style={{ backgroundColor: findNodeColor(edgePopup.sourceId) }}
                >
                  <div 
                    className="text-sm mb-1 opacity-75"
                    style={{ color: getContrastTextColor(findNodeColor(edgePopup.sourceId)) }}
                  >
                    From
                  </div>
                  <div 
                    className="text-lg font-medium"
                    style={{ color: getContrastTextColor(findNodeColor(edgePopup.sourceId)) }}
                  >
                    {findNodeTitle(edgePopup.sourceId)}
                  </div>
                </div>
                <div className="flex flex-col items-center">
                  <div 
                    className="w-8 h-8 rounded-full flex items-center justify-center"
                    style={{ backgroundColor: '#000000' }}
                  >
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5-5 5M6 12h12" />
                    </svg>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">leads to</div>
                </div>
                <div 
                  className="flex-1 rounded-xl p-3 border-0 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.3),_0_4px_6px_-2px_rgba(0,0,0,0.15)] text-center"
                  style={{ backgroundColor: findNodeColor(edgePopup.targetId) }}
                >
                  <div 
                    className="text-sm mb-1 opacity-75"
                    style={{ color: getContrastTextColor(findNodeColor(edgePopup.targetId)) }}
                  >
                    To
                  </div>
                  <div 
                    className="text-lg font-medium"
                    style={{ color: getContrastTextColor(findNodeColor(edgePopup.targetId)) }}
                  >
                    {findNodeTitle(edgePopup.targetId)}
                  </div>
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
                <div className="text-center">
                  <span className="text-2xl font-bold text-gray-800">
                    {Math.round(edgePopup.confidence)}%
                  </span>
                  <span className="text-sm text-gray-500 ml-2">
                    ({edgePopup.confidence <= 33 ? 'Low' : edgePopup.confidence <= 66 ? 'Medium' : 'High'})
                  </span>
                </div>
                
                <div className="space-y-3">
                  <div className="flex items-center space-x-4">
                    <span className="text-xs text-gray-600 font-medium">0%</span>
                    <div className="flex-1 relative">
                      <style>
                        {`
                          .black-slider::-webkit-slider-thumb {
                            appearance: none;
                            height: 16px;
                            width: 16px;
                            border-radius: 50%;
                            background: #000000;
                            cursor: pointer;
                            border: none;
                            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                          }
                          .black-slider::-moz-range-thumb {
                            height: 16px;
                            width: 16px;
                            border-radius: 50%;
                            background: #000000;
                            cursor: pointer;
                            border: none;
                            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                          }
                        `}
                      </style>
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
                        className="black-slider w-full h-2 rounded-lg appearance-none cursor-pointer bg-gray-200"
                      />
                    </div>
                    <span className="text-xs text-gray-600 font-medium">100%</span>
                  </div>
                  <div className="text-xs text-gray-700 text-center">
                    {edgePopup.confidence >= 80
                      ? `Very strong confidence (${Math.round(edgePopup.confidence)}%). This connection has robust evidence and high certainty.`
                      : edgePopup.confidence >= 60
                      ? `Good confidence (${Math.round(edgePopup.confidence)}%). This connection has solid evidence with some certainty.`
                      : edgePopup.confidence >= 40
                      ? `Moderate confidence (${Math.round(edgePopup.confidence)}%). This connection has reasonable evidence but uncertainty remains.`
                      : edgePopup.confidence >= 20
                      ? `Low confidence (${Math.round(edgePopup.confidence)}%). This connection has limited evidence and significant uncertainty.`
                      : `Very low confidence (${Math.round(edgePopup.confidence)}%). This connection is speculative with minimal supporting evidence.`}
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
  toggleHighlight: (id: string, selectionMode?: 'single' | 'multi' | 'column') => void
  setHoveredNode: (id: string | null) => void
  hasHighlightedNodes: boolean
  onDragStart: (node: Node, event: React.DragEvent) => void
  onDragEnd: () => void
  editMode: boolean
  textSize: number
  setNodePopup: React.Dispatch<React.SetStateAction<{ id: string; title: string; text: string } | null>>
}) {
  const nodeRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    updateNodeRef(node.id, nodeRef.current)
  }, [node.id, updateNodeRef])

  const handleClick = (event: React.MouseEvent) => {
    let selectionMode: 'single' | 'multi' | 'column' = 'single'
    
    if (event.ctrlKey) {
      selectionMode = 'multi'
    } else if (event.shiftKey && editMode) {
      selectionMode = 'column'
    }
    
    toggleHighlight(node.id, selectionMode)
  }

  const handleInfoClick = (event: React.MouseEvent) => {
    event.stopPropagation()
    setNodePopup({
      id: node.id,
      title: node.title,
      text: node.text
    })
  }

  const handleMouseEnter = () => {
    setHoveredNode(node.id)
  }

  const handleMouseLeave = () => {
    setHoveredNode(null)
  }

  const handleDoubleClick = (event: React.MouseEvent) => {
    let selectionMode: 'single' | 'multi' | 'column' = 'single'
    
    if (event.ctrlKey) {
      selectionMode = 'multi'
    } else if (event.shiftKey && editMode) {
      selectionMode = 'column'
    }
    
    toggleHighlight(node.id, selectionMode)
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
          "flex flex-col border-0 rounded-xl cursor-pointer transition-all duration-500 ease-in-out shadow-[0_10px_15px_-3px_rgba(0,0,0,0.3),_0_4px_6px_-2px_rgba(0,0,0,0.15)] hover:shadow-[0_20px_25px_-5px_rgba(0,0,0,0.3),_0_10px_10px_-5px_rgba(0,0,0,0.15)] transform hover:scale-105 pt-3 px-3 pb-6",
          // Only apply default gradients if no custom color is set
          !node.color && "bg-gradient-to-br from-white to-gray-50",
          isHighlighted
            ? node.color 
              ? "ring-2 ring-black" 
              : "ring-2 ring-black bg-gradient-to-br from-indigo-50 to-indigo-100"
            : isHovered
              ? node.color
                ? "" // No ring for custom colored nodes when hovered
                : "bg-gradient-to-br from-indigo-25 to-indigo-50" // Only background for default nodes when hovered
              : "hover:shadow-2xl",
          hasHighlightedNodes && !isConnected && "opacity-30",
          isDragging && "opacity-50 scale-95 shadow-lg"
        )}
        style={{
          width: `${node.width || 192}px`,
          backgroundColor: node.color || '#ffffff'
        }}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div className="flex flex-col justify-center relative py-2">
          <div 
            className="font-medium text-center leading-tight break-words"
            style={{ 
              fontSize: `${textSize * 1.125}rem`, // 1.125rem is text-lg base size
              color: node.color ? getContrastTextColor(node.color) : '#000000' // Default black text for no custom color
            }}
          >
            {node.title}
          </div>
        </div>
        
        {/* Information icon for selected nodes with details - positioned relative to outer node */}
        {node.text && isHighlighted && (
          <button
            onClick={handleInfoClick}
            className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center hover:bg-gray-100 hover:bg-opacity-20 transition-colors z-10"
            style={{
              color: node.color ? getContrastTextColor(node.color) : '#6b7280'
            }}
            title="View details"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </button>
        )}
      </div>
    </div>
  )
}
