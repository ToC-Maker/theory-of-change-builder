import clsx from "clsx"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ToCData, Node } from "../types"
import { NodeComponent } from "../components/NodeComponent"
import { ConnectionsComponent } from "../components/ConnectionsComponent"
import { EditToolbar } from "../components/EditToolbar"
import { Legend } from "../components/Legend"
import { NodePopup } from "../components/NodePopup"
import { EditModeToggle } from "../components/EditModeToggle"
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts"




export function ToC({ 
  data: initialData, 
  onSizeChange,
  onDataChange,
  showEditButton = true
}: { 
  data: ToCData
  onSizeChange?: (size: { width: number; height: number }) => void 
  onDataChange?: (data: ToCData) => void
  showEditButton?: boolean
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
  const [nodeHeights, setNodeHeights] = useState<{
    [key: string]: number
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
  const [columnPadding, setColumnPadding] = useState(initialData.columnPadding ?? 24) // Default column padding in pixels
  const [sectionPadding, setSectionPadding] = useState(initialData.sectionPadding ?? 32) // Default section padding in pixels
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingSectionIndex, setEditingSectionIndex] = useState<number | null>(null)
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
    
    // Update height when ref changes
    if (ref) {
      const height = ref.getBoundingClientRect().height
      setNodeHeights((prev) => ({ ...prev, [id]: height }))
    }
  }, [])

  const updateNode = useCallback((nodeId: string, title: string, text: string) => {
    setDataAndNotify(prevData => ({
      ...prevData,
      sections: prevData.sections.map(section => ({
        ...section,
        columns: section.columns.map(column => ({
          ...column,
          nodes: column.nodes.map(node => 
            node.id === nodeId 
              ? { ...node, title, text }
              : node
          )
        }))
      }))
    }))
    
    // Trigger height recalculation for the updated node
    // We need to wait for the DOM to update first
    setTimeout(() => {
      const nodeRef = nodeRefs[nodeId]
      if (nodeRef) {
        const height = nodeRef.getBoundingClientRect().height
        setNodeHeights(prev => ({ ...prev, [nodeId]: height }))
      }
    }, 0)
  }, [setDataAndNotify, nodeRefs])

  const recalculateAllNodeHeights = useCallback(() => {
    // Force recalculation of all node heights
    setTimeout(() => {
      Object.entries(nodeRefs).forEach(([nodeId, ref]) => {
        if (ref) {
          const height = ref.getBoundingClientRect().height
          setNodeHeights(prev => ({ ...prev, [nodeId]: height }))
        }
      })
    }, 50) // Slightly longer delay to ensure DOM updates
  }, [nodeRefs])

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
    // Recalculate node heights when data changes (e.g., from AI edits)
    recalculateAllNodeHeights();
  }, [initialData, recalculateAllNodeHeights]);

  // Update settings when data changes
  useEffect(() => {
    if (initialData.textSize !== undefined) {
      setTextSize(initialData.textSize)
    }
    if (initialData.curvature !== undefined) {
      setCurvature(initialData.curvature)
    }
    if (initialData.columnPadding !== undefined) {
      setColumnPadding(initialData.columnPadding)
    }
    if (initialData.sectionPadding !== undefined) {
      setSectionPadding(initialData.sectionPadding)
    }
  }, [initialData.textSize, initialData.curvature, initialData.columnPadding, initialData.sectionPadding])

  const copyGraphJSON = useCallback(async () => {
    try {
      const graphData = {
        ...data,
        // Include all settings as part of main data
        textSize,
        curvature,
        columnPadding,
        sectionPadding,
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
  }, [data, curvature, textSize, columnPadding, sectionPadding, legendPosition])

  // Generate unique node ID
  const generateNodeId = useCallback((): string => {
    return `node-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }, [])

  // Create new node at specified position
  const createNewNode = useCallback((sectionIndex: number, columnIndex: number, yPosition: number) => {
    if (!editMode) return

    const newNode: Node = {
      id: generateNodeId(),
      title: "New Node",
      text: "Details of New Node.",
      connectionIds: [],
      connections: [],
      yPosition: yPosition,
      width: nodeWidth, // Use current width setting
      color: nodeColor  // Use current color setting
    }

    setDataAndNotify(prevData => ({
      ...prevData,
      sections: prevData.sections.map((section, sIdx) =>
        sIdx === sectionIndex ? {
          ...section,
          columns: section.columns.map((column, cIdx) =>
            cIdx === columnIndex ? {
              ...column,
              nodes: [...column.nodes, newNode]
            } : column
          )
        } : section
      )
    }))

    // Select the new node and open it for editing
    setHighlightedNodes(new Set([newNode.id]))
    setTimeout(() => {
      setNodePopup({
        id: newNode.id,
        title: newNode.title,
        text: newNode.text
      })
    }, 100)
  }, [editMode, nodeWidth, nodeColor, setDataAndNotify, generateNodeId])

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
              // Use cached height or default
              const actualHeight = nodeHeights[node.id] || 150
              
              // Calculate current center Y position
              const defaultCenterY = nodeIndex * 180 + 30 + actualHeight / 2
              const currentCenterY = node.yPosition ?? defaultCenterY
              return { ...node, yPosition: currentCenterY + moveAmount }
            }
            return node
          })
        }))
      }))
    }))
  }, [setDataAndNotify, nodeHeights])

  const straightenEdges = useCallback(() => {
    if (!editMode) return
    
    setDataAndNotify((prevData) => {
      // Collect all nodes with their actual center positions
      const allNodes: { node: Node; sectionIndex: number; columnIndex: number; nodeIndex: number; centerY: number; topY: number; height: number }[] = []
      
      prevData.sections.forEach((section, sectionIndex) => {
        section.columns.forEach((column, columnIndex) => {
          column.nodes.forEach((node, nodeIndex) => {
            // Use cached height or default
            const actualHeight = nodeHeights[node.id] || 150
            
            // yPosition now represents the center Y
            const centerY = node.yPosition ?? (nodeIndex * 180 + 30 + actualHeight / 2)
            const topY = centerY - actualHeight / 2
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
          
          group.forEach(({ sectionIndex, columnIndex, nodeIndex }) => {
            const node = newData.sections[sectionIndex].columns[columnIndex].nodes[nodeIndex]
            // yPosition now represents the center Y, so set it directly
            newData.sections[sectionIndex].columns[columnIndex].nodes[nodeIndex] = {
              ...node,
              yPosition: avgCenterY
            }
          })
        }
      })

      return newData
    })
  }, [editMode, setDataAndNotify, nodeHeights])

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
    // Defensive programming: ensure sections is an array
    if (!data.sections || !Array.isArray(data.sections)) {
      console.error('Data corruption detected: sections is not an array', data.sections);
      return [400]; // Return default width
    }
    
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
      const gaps = Math.max(0, columnWidths.length - 1) * columnPadding // Use dynamic column padding
      
      return totalColumnWidth + gaps
    })
    return widths
  }, [data.sections, columnPadding])


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

  // Generic function to delete a specific connection
  const deleteConnection = useCallback((sourceId: string, targetId: string) => {
    if (!editMode) return

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
  }, [editMode, setDataAndNotify])

  // Generic function to delete a specific node
  const deleteNode = useCallback((nodeId: string) => {
    if (!editMode) return

    // Combine node deletion and connection cleanup in a single atomic update
    setDataAndNotify(prevData => ({
      ...prevData,
      sections: prevData.sections.map(section => ({
        ...section,
        columns: section.columns.map(column => ({
          ...column,
          nodes: column.nodes
            .filter(node => node.id !== nodeId) // Remove the deleted node
            .map(node => ({
              ...node,
              // Clean up any connections to the deleted node
              connectionIds: node.connectionIds?.filter(id => id !== nodeId) || [],
              connections: node.connections?.filter(conn => conn.targetId !== nodeId)
            }))
        }))
      }))
    }))

    // Clear any selection of the deleted node
    setHighlightedNodes(prev => {
      const newSet = new Set(prev)
      newSet.delete(nodeId)
      return newSet
    })
  }, [editMode, setDataAndNotify])

  const disconnectSelectedNodes = useCallback(() => {
    if (!editMode) return

    if (highlightedNodes.size !== 2) {
      return
    }

    const [sourceId, targetId] = Array.from(highlightedNodes)
    deleteConnection(sourceId, targetId)

    // Clear selection after disconnecting
    setHighlightedNodes(new Set())
    setNodeWidth(192)
    setNodeColor('#ffffff')
  }, [editMode, highlightedNodes, deleteConnection])

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
    // Since yPosition now represents center, we need to get the actual node height
    let adjustedYPosition = 20 // Default fallback
    if (yPosition !== undefined) {
      // Use cached height or default
      const actualHeight = nodeHeights[draggedNode.id] || 150
      // Convert from top position to center position
      adjustedYPosition = yPosition - dragOffset.y + actualHeight / 2
    }

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

  // Initialize keyboard shortcuts hook
  const keyboardShortcuts = useKeyboardShortcuts({
    data,
    setDataAndNotify,
    highlightedNodes,
    setHighlightedNodes,
    editMode,
    nodeRefs,
    setNodeWidth,
    setNodeColor,
    setNodePopup,
    moveNodeVertically,
    nodeHeights
  })


  return (
    <div className="flex flex-col">
      {/* Graph Title */}
      {(data.title || editMode) && (
        <div className="mb-6">
          {editMode && editingTitle ? (
            <input
              type="text"
              value={data.title || ''}
              onChange={(e) => {
                setDataAndNotify(prev => ({ ...prev, title: e.target.value }))
              }}
              onBlur={() => setEditingTitle(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setEditingTitle(false)
                }
              }}
              className="text-4xl font-bold text-center text-gray-800 tracking-wider w-full bg-transparent border-b-2 border-gray-400 outline-none focus:border-indigo-500"
              autoFocus
            />
          ) : (
            <h1
              className={`text-4xl font-bold text-center text-gray-800 tracking-wider ${editMode ? 'cursor-pointer hover:text-indigo-600 transition-colors' : ''}`}
              onClick={() => editMode && setEditingTitle(true)}
              title={editMode ? 'Click to edit title' : ''}
            >
              {data.title || (editMode ? 'Click to add title' : '')}
            </h1>
          )}
        </div>
      )}
      
      <div
        className="flex relative min-w-fit overflow-visible"
        style={{
          gap: `${sectionPadding}px`,
          width: svgSize.width > 0 ? `${svgSize.width}px` : 'auto',
          height: svgSize.height > 0 ? `${svgSize.height-55}px` : '100vh' // I don't understand why I need to subtract 55, but it works
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
      {Array.isArray(data.sections) ? data.sections.map((section, sectionIndex) => (
        <div key={sectionIndex}
             onClick={(e) => {
               // Allow deselection by clicking section area in both view and edit mode
               if (e.target === e.currentTarget) {
                 setHighlightedNodes(new Set())
                 setNodeWidth(192)
                 setNodeColor('#ffffff')
               }
             }}>
          <div className="flex">
            {/* Section title positioned to center over actual columns */}
            <div className="flex flex-col">
              <div 
                className="rounded py-3 mb-2 px-3"
                style={{ 
                  backgroundColor: data.color || '#374151', // Default to gray-700
                  minWidth: `${sectionWidths[sectionIndex] + (editMode && columnDragMode ? columnPadding + 16 : 0)}px` // Account for drop zones
                }}
              >
                {editMode && editingSectionIndex === sectionIndex ? (
                  <input
                    type="text"
                    value={section.title}
                    onChange={(e) => {
                      setDataAndNotify(prev => ({
                        ...prev,
                        sections: prev.sections.map((s, idx) =>
                          idx === sectionIndex ? { ...s, title: e.target.value } : s
                        )
                      }))
                    }}
                    onBlur={() => setEditingSectionIndex(null)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        setEditingSectionIndex(null)
                      }
                    }}
                    className="text-3xl font-bold text-center text-white uppercase bg-transparent border-b-2 border-white/50 outline-none focus:border-white w-full"
                    autoFocus
                  />
                ) : (
                  <h2
                    className={`text-3xl font-bold text-center text-white uppercase ${editMode ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
                    onClick={() => editMode && setEditingSectionIndex(sectionIndex)}
                    title={editMode ? 'Click to edit section label' : ''}
                  >
                    {section.title}
                  </h2>
                )}
              </div>
              <div className="flex" style={{ gap: `${columnPadding}px` }}>
            {(() => {
              // Always show at least one column per section, even if empty
              const nonEmptyColumns = section.columns.filter(column => column.nodes.length > 0);
              const columnsToShow = nonEmptyColumns.length > 0 ? nonEmptyColumns : [section.columns[0] || { nodes: [] }];
              return columnsToShow;
            })().map((column, colIndex) => (
              <React.Fragment key={colIndex}>
                {/* Drop zone before first column - only show when column dragging is enabled */}
                {editMode && columnDragMode && colIndex === 0 && (
                  <div
                    className={clsx(
                      "min-h-96 rounded-lg border-2 border-dashed transition-colors flex items-center justify-center",
                      dragOverLocation?.sectionIndex === sectionIndex &&
                      dragOverLocation?.columnIndex === 0 &&
                      dragOverLocation?.isNewColumn
                        ? "border-green-400 bg-green-50"
                        : "border-transparent",
                      draggedNode ? "hover:border-green-300" : ""
                    )}
                    style={{ width: `${columnPadding / 2}px` }}
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
                  className="relative"
                  style={{ 
                    minWidth: `${Math.max(...column.nodes.map(node => node.width || 192), 192)}px`, 
                    width: `${Math.max(...column.nodes.map(node => node.width || 192), 192)}px`,
                    height: editMode ? (svgSize.height > 0 ? `${svgSize.height - 62}px` : '740px') : 'auto'
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
                  onDoubleClick={editMode ? (e) => {
                    // Only create new node if double-clicking in blank column area
                    if (e.target === e.currentTarget) {
                      const rect = e.currentTarget.getBoundingClientRect()
                      const yPosition = e.clientY - rect.top
                      createNewNode(sectionIndex, colIndex, yPosition)
                    }
                  } : undefined}
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
                              ? `${node.yPosition - (nodeHeights[node.id] || 150) / 2}px` // Convert from center to top position using cached height
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
                      "min-h-screen rounded-lg border-2 border-dashed transition-colors flex items-center justify-center",
                      dragOverLocation?.sectionIndex === sectionIndex &&
                      dragOverLocation?.columnIndex === colIndex + 1 &&
                      dragOverLocation?.isNewColumn
                        ? "border-green-400 bg-green-50"
                        : "border-transparent",
                      draggedNode ? "hover:border-green-300" : ""
                    )}
                    style={{ width: `${columnPadding / 2}px` }}
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
      )) : (
        <div className="flex items-center justify-center h-64 bg-red-50 border-2 border-red-200 rounded-lg">
          <div className="text-center">
            <div className="text-red-600 text-lg font-semibold mb-2">Data Error Detected</div>
            <div className="text-red-500 text-sm">The graph data structure has been corrupted. Please reload the page.</div>
          </div>
        </div>
      )}

      <ConnectionsComponent
        data={data}
        setData={setDataAndNotify}
        nodeRefs={nodeRefs}
        nodeHeights={nodeHeights}
        highlightedNodes={highlightedNodes}
        connectedNodes={connectedNodes}
        hoveredConnections={hoveredConnections}
        curvature={curvature}
        editMode={editMode}
        columnDragMode={columnDragMode}
        sectionWidths={sectionWidths}
        columnPadding={columnPadding}
        sectionPadding={sectionPadding}
        onSizeChange={(size) => {
          setSvgSize(size)
          onSizeChange?.(size)
        }}
        onDeleteConnection={deleteConnection}
      />

      <EditToolbar
        editMode={editMode}
        highlightedNodes={highlightedNodes}
        columnDragMode={columnDragMode}
        setColumnDragMode={setColumnDragMode}
        curvature={curvature}
        setCurvature={(value) => {
          setCurvature(value)
          // Update data with new curvature
          setDataAndNotify(prev => ({ ...prev, curvature: value }))
        }}
        textSize={textSize}
        setTextSize={(value) => {
          setTextSize(value)
          // Update data with new text size
          setDataAndNotify(prev => ({ ...prev, textSize: value }))
        }}
        nodeWidth={nodeWidth}
        setNodeWidth={setNodeWidth}
        nodeColor={nodeColor}
        setNodeColor={setNodeColor}
        columnPadding={columnPadding}
        setColumnPadding={(value) => {
          setColumnPadding(value)
          // Update data with new padding
          setDataAndNotify(prev => ({ ...prev, columnPadding: value }))
        }}
        sectionPadding={sectionPadding}
        setSectionPadding={(value) => {
          setSectionPadding(value)
          // Update data with new padding
          setDataAndNotify(prev => ({ ...prev, sectionPadding: value }))
        }}
        straightenEdges={straightenEdges}
        setData={setDataAndNotify}
      />

      {/* Connect Nodes Popup - shows when exactly 2 nodes are selected in edit mode */}
      {editMode && highlightedNodes.size === 2 && (() => {
        const nodeIds = Array.from(highlightedNodes)
        const [sourceId, targetId] = nodeIds
        
        // This component will continuously update position during interactions
        const ConnectButton = () => {
          const [position, setPosition] = useState({ x: 0, y: 0 })
          const [smoothUpdates, setSmoothUpdates] = useState(false)
          const animationFrameRef = useRef<number | null>(null)
          const smoothUpdateTimeoutRef = useRef<NodeJS.Timeout | null>(null)
          
          // Update position like ConnectionsComponent does
          const updatePosition = useCallback(() => {
            const sourceNodeRef = nodeRefs[sourceId]
            const targetNodeRef = nodeRefs[targetId]
            
            if (sourceNodeRef && targetNodeRef) {
              const sourceRect = sourceNodeRef.getBoundingClientRect()
              const targetRect = targetNodeRef.getBoundingClientRect()
              const containerRect = sourceNodeRef.closest(".flex.relative")?.getBoundingClientRect()
              
              if (containerRect) {
                // Use exact same logic as ConnectionsComponent
                const startX = sourceRect.right - containerRect.left
                const startY = sourceRect.top + sourceRect.height / 2 - containerRect.top
                const endX = targetRect.left - containerRect.left
                const endY = targetRect.top + targetRect.height / 2 - containerRect.top
                
                // Position at midpoint like the edge popup does
                const midX = (startX + endX) / 2
                const midY = (startY + endY) / 2
                
                setPosition({ x: midX, y: midY })
              }
            }
          }, [sourceId, targetId, nodeRefs])
          
          // Mimic ConnectionsComponent's smooth update logic
          useEffect(() => {
            const updateConnections = () => {
              if (smoothUpdates) {
                updatePosition()
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
          }, [smoothUpdates, updatePosition])

          // Enable smooth updates when this button is visible (always true since it only renders when 2 nodes selected)
          useEffect(() => {
            // Always enable smooth updates since this component only exists when we need it
            setSmoothUpdates(true)
            
            return () => {
              // Clean up when component unmounts
              if (smoothUpdateTimeoutRef.current) {
                clearTimeout(smoothUpdateTimeoutRef.current)
                smoothUpdateTimeoutRef.current = null
              }
            }
          }, []) // Empty dependency array - only run on mount/unmount
          
          // Initial position update
          useEffect(() => {
            updatePosition()
          }, [updatePosition])
          
          const isConnected = areNodesConnected(sourceId, targetId)
          
          return (
            <div
              className="absolute z-50 p-3 pointer-events-none"
              style={{
                left: `${position.x}px`,
                top: `${position.y}px`,
                transform: 'translate(-50%, -50%)'
              }}
            >
              <div className="pointer-events-auto">
                {isConnected ? (
                  <button
                    onClick={connectSelectedNodes}
                    className="flex items-center justify-center w-5 h-5 bg-white text-gray-600 hover:text-red-600 rounded-full border border-gray-300 hover:border-red-300 transition-colors shadow-sm"
                    title="Disconnect nodes"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
                    </svg>
                  </button>
                ) : (
                  <button
                    onClick={connectSelectedNodes}
                    className="flex items-center justify-center w-5 h-5 bg-white text-gray-600 hover:text-gray-800 rounded-full border border-gray-300 hover:border-gray-400 transition-colors shadow-sm"
                    title="Connect nodes"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v12m6-6H6" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )
        }
        
        return <ConnectButton />
      })()}

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

      {/* Edit Mode Toggle Button */}
      <EditModeToggle
        editMode={editMode}
        setEditMode={setEditMode}
        setHighlightedNodes={setHighlightedNodes}
        setColumnDragMode={setColumnDragMode}
        setNodeWidth={setNodeWidth}
        setNodeColor={setNodeColor}
        setEditingTitle={setEditingTitle}
        setEditingSectionIndex={setEditingSectionIndex}
        show={showEditButton}
      />

      {nodePopup && (
        <NodePopup
          nodePopup={nodePopup}
          setNodePopup={setNodePopup}
          svgSize={svgSize}
          editMode={editMode}
          onUpdateNode={updateNode}
          onDeleteNode={deleteNode}
        />
      )}

    </div>
    </div>
  )
}

