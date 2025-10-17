import clsx from "clsx"
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ToCData, Node } from "../types"
import { NodeComponent } from "./NodeComponent"
import { ConnectionsComponent } from "./ConnectionsComponent"
import { EditToolbar } from "./EditToolbar"
import { Legend } from "./Legend"
import { NodePopup } from "./NodePopup"
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts"
import { PlusIcon, MinusIcon } from "@heroicons/react/24/outline"




export function ToC({
  data: initialData,
  onSizeChange,
  onDataChange,
  showEditButton = true,
  undoHistory = [],
  redoHistory = [],
  handleUndo = () => {},
  handleRedo = () => {},
  setShowShareModal = () => {},
  isSaving = false,
  currentEditToken = null,
  lastSyncTime = null,
  isManualSyncing = false,
  handleManualSync = () => {},
  getTimeAgo = () => "",
  renderEditToolbar,
  zoomScale = 1,
  camera,
  onHighlightedNodesChange,
  onEditTokenChange
}: {
  data: ToCData
  onSizeChange?: (size: { width: number; height: number }) => void
  onDataChange?: (data: ToCData) => void
  showEditButton?: boolean
  undoHistory?: ToCData[]
  redoHistory?: ToCData[]
  handleUndo?: () => void
  handleRedo?: () => void
  setShowShareModal?: React.Dispatch<React.SetStateAction<boolean>>
  isSaving?: boolean
  currentEditToken?: string | null
  lastSyncTime?: Date | null
  isManualSyncing?: boolean
  handleManualSync?: () => void
  getTimeAgo?: (date: Date) => string
  renderEditToolbar?: (props: any) => React.ReactNode
  zoomScale?: number
  camera?: { x: number; y: number; z: number }
  onHighlightedNodesChange?: (highlightedNodes: Set<string>) => void
  onEditTokenChange?: (token: string) => void
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

  // Notify parent when highlighted nodes change
  useEffect(() => {
    onHighlightedNodesChange?.(highlightedNodes)
  }, [highlightedNodes, onHighlightedNodesChange])
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const [draggedNode, setDraggedNode] = useState<Node | null>(null)
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null)
  const [dragOverLocation, setDragOverLocation] = useState<{
    sectionIndex: number
    columnIndex: number
    yPosition?: number
    isNewColumn?: boolean
  } | null>(null)
  const [editMode, setEditMode] = useState(showEditButton)
  const [layoutMode, setLayoutMode] = useState(false)
  const [curvature, setCurvature] = useState(initialData.curvature ?? 0.5)
  const [textSize, setTextSize] = useState(initialData.textSize ?? 1) // 0.5 to 2.0 scale
  const [nodeWidth, setNodeWidth] = useState(192) // Default width in pixels (w-48)
  const [nodeColor, setNodeColor] = useState('#ffffff') // Default white background
  const [columnPadding, setColumnPadding] = useState(initialData.columnPadding ?? 24) // Default column padding in pixels
  const [sectionPadding, setSectionPadding] = useState(initialData.sectionPadding ?? 32) // Default section padding in pixels
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingSectionIndex, setEditingSectionIndex] = useState<number | null>(null)
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)
  const [nodePopup, setNodePopup] = useState<{
    id: string
    title: string
    text: string
  } | null>(null)
  const [edgePopup, setEdgePopup] = useState<any>(null)
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 })
  const [legendPosition, setLegendPosition] = useState({ x: 340, y: 70 })
  const [isDraggingLegend, setIsDraggingLegend] = useState(false)
  const [legendDragOffset, setLegendDragOffset] = useState({ x: 0, y: 0 })
  const graphContainerRef = useRef<HTMLDivElement>(null)

  const updateNodeRef = useCallback((id: string, ref: HTMLDivElement | null) => {
    setNodeRefs((prev) => ({ ...prev, [id]: ref }))

    // Update height when ref changes - use offsetHeight for local (pre-transform) height
    if (ref) {
      const height = ref.offsetHeight
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
        const height = nodeRef.offsetHeight
        setNodeHeights(prev => ({ ...prev, [nodeId]: height }))
      }
    }, 0)
  }, [setDataAndNotify, nodeRefs])

  const updateNodeTitle = useCallback((nodeId: string, title: string) => {
    setDataAndNotify(prevData => ({
      ...prevData,
      sections: prevData.sections.map(section => ({
        ...section,
        columns: section.columns.map(column => ({
          ...column,
          nodes: column.nodes.map(node =>
            node.id === nodeId
              ? { ...node, title }
              : node
          )
        }))
      }))
    }))
  }, [setDataAndNotify])

  const recalculateAllNodeHeights = useCallback(() => {
    // Force recalculation of all node heights
    setTimeout(() => {
      Object.entries(nodeRefs).forEach(([nodeId, ref]) => {
        if (ref) {
          const height = ref.offsetHeight
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

  // Position legend in bottom-right corner when svgSize changes
  useEffect(() => {
    if (svgSize.width > 0 && svgSize.height > 0) {
      setLegendPosition({
        x: svgSize.width - 170, // 170px from right edge (legend width ~160px + 10px margin)
        y: svgSize.height - 190  // 190px from bottom (legend height ~150px + 40px margin)
      })
    }
  }, [svgSize.width, svgSize.height])

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

    // Get the column to determine width
    const column = data.sections[sectionIndex]?.columns[columnIndex]
    if (!column) return

    // Calculate width to match the column
    let newNodeWidth = nodeWidth // Default to current width setting
    if (column.nodes.length > 0) {
      // If column has nodes, match their width (use max width in column)
      const columnNodeWidths = column.nodes.map(node => node.width || 192)
      newNodeWidth = Math.max(...columnNodeWidths)
    }

    // yPosition is where the user clicked - this becomes the center Y of the node
    const newNode: Node = {
      id: generateNodeId(),
      title: "New Node",
      text: "Details of New Node.",
      connectionIds: [],
      connections: [],
      yPosition: yPosition, // Click position = center Y
      width: newNodeWidth, // Match column width
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

    // Select the new node and enter edit mode
    setHighlightedNodes(new Set([newNode.id]))
    setTimeout(() => {
      setEditingNodeId(newNode.id)
    }, 0)
  }, [editMode, nodeWidth, nodeColor, setDataAndNotify, generateNodeId, data.sections])

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
              const actualHeight = nodeHeights[node.id] || 76

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
            const actualHeight = nodeHeights[node.id] || 76

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

      // Create a wrapper div to apply scale without affecting the drag image capture
      const wrapper = document.createElement('div')
      wrapper.style.position = 'fixed'
      wrapper.style.top = '-9999px'
      wrapper.style.left = '-9999px'
      wrapper.style.width = `${nodeElement.offsetWidth * zoomScale}px`
      wrapper.style.height = `${nodeElement.offsetHeight * zoomScale}px`
      wrapper.style.pointerEvents = 'none'

      const dragImage = nodeElement.cloneNode(true) as HTMLElement
      dragImage.style.width = `${nodeElement.offsetWidth}px`
      dragImage.style.height = `${nodeElement.offsetHeight}px`
      dragImage.style.transform = `scale(${zoomScale})`
      dragImage.style.transformOrigin = '0 0'
      dragImage.style.opacity = '0.8'

      wrapper.appendChild(dragImage)
      document.body.appendChild(wrapper)

      // Set the drag image with scaled offset
      event.dataTransfer.setDragImage(wrapper, offsetX, offsetY)

      // Clean up after drag starts
      requestAnimationFrame(() => {
        if (wrapper.parentNode) {
          document.body.removeChild(wrapper)
        }
      })
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
      // Always include all columns (even empty ones)
      const columnsToCalculate = section.columns

      if (columnsToCalculate.length === 0) return 192 // Default width for empty sections

      // Calculate width needed for each column (max node width in that column)
      const columnWidths = columnsToCalculate.map(column => {
        if (column.nodes.length === 0) return 128 // Empty columns get default width
        const nodeWidths = column.nodes.map(node => node.width || 192)
        return Math.max(...nodeWidths, 128) // At least 128px per column
      })

      // Total width = sum of all column widths
      const totalColumnWidth = columnWidths.reduce((sum, width) => sum + width, 0)

      // In add/remove mode, gaps become drop zones and are added in ConnectionsComponent
      // So we don't add gaps here, but the drop zones are calculated as (N+1) * columnPadding
      // which is already handled in ConnectionsComponent
      const gaps = (editMode && layoutMode)
        ? 0
        : Math.max(0, columnWidths.length - 1) * columnPadding

      return totalColumnWidth + gaps
    })
    return widths
  }, [data.sections, columnPadding, editMode, layoutMode, data.sections.map(s => s.columns.length).join(',')])


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


    // Adjust yPosition by the drag offset so the node appears where the user grabbed it
    let adjustedYPosition = 20 // Default fallback
    if (yPosition !== undefined) {
      // yPosition comes from e.clientY - rect.top where rect is from getBoundingClientRect()
      // getBoundingClientRect() returns viewport coordinates which are already scaled by the zoom transform
      // So we need to convert back to local space by dividing by zoom
      const mouseLocalY = yPosition / zoomScale

      // dragOffset.y was captured from the original drag event, also in viewport space
      const dragOffsetLocalY = dragOffset.y / zoomScale

      // Calculate where the node's top would be in local space
      const nodeTopLocal = mouseLocalY - dragOffsetLocalY

      // Get node height (stored in local space)
      const actualHeight = nodeHeights[draggedNode.id] || 76

      // Calculate center in local space
      adjustedYPosition = nodeTopLocal + actualHeight / 2
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
        ref={graphContainerRef}
        className="flex relative min-w-fit overflow-visible"
        style={{
          gap: editMode && layoutMode ? '0px' : `${sectionPadding}px`,
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
        <React.Fragment key={sectionIndex}>
          {/* Gap before first section or between sections with click to add section */}
          {editMode && layoutMode && (
            <div
              className="bg-green-50 hover:bg-green-100 transition-colors flex items-center justify-center cursor-pointer group rounded-lg"
              style={{ width: `${sectionPadding}px`, height: svgSize.height > 0 ? `${svgSize.height - 124}px` : '740px', marginTop: '68px' }}
              onClick={() => {
                setDataAndNotify(prevData => {
                  const newData = { ...prevData }
                  newData.sections.splice(sectionIndex, 0, {
                    title: 'New Section',
                    columns: [{ nodes: [] }]
                  })
                  return newData
                })
              }}
              title="Click to add section"
            >
              <div className="text-green-500 text-xs font-medium rotate-90 whitespace-nowrap opacity-100 transition-opacity">
                + Section
              </div>
            </div>
          )}
          <div
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
                  width: `${Math.max(
                    sectionWidths[sectionIndex] + (editMode && layoutMode ? (section.columns.length + 1) * columnPadding : 0),
                    section.title.length * 20 + 24 // Estimate: ~20px per character + padding
                  )}px`,
                  maxWidth: `${Math.max(
                    sectionWidths[sectionIndex] + (editMode && layoutMode ? (section.columns.length + 1) * columnPadding : 0),
                    section.title.length * 20 + 24
                  )}px`
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
              <div className="flex" style={{ gap: editMode && layoutMode ? '0px' : `${columnPadding}px` }}>
            {section.columns.map((column, colIndex) => (
              <React.Fragment key={`${sectionIndex}-${colIndex}`}>
                {/* Gap before first column with click to add column */}
                {editMode && layoutMode && colIndex === 0 && (
                  <div
                    className="bg-blue-50 hover:bg-blue-100 transition-colors flex items-center justify-center cursor-pointer group rounded-lg"
                    style={{ width: `${columnPadding}px`, height: svgSize.height > 0 ? `${svgSize.height  - 124}px` : '740px' }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      const yPosition = e.clientY - rect.top
                      handleDragOver(sectionIndex, 0, true, yPosition)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      const yPosition = e.clientY - rect.top
                      handleDrop(sectionIndex, 0, true, yPosition)
                    }}
                    onClick={() => {
                      setDataAndNotify(prevData => {
                        const newData = { ...prevData }
                        newData.sections[sectionIndex].columns.splice(0, 0, { nodes: [] })
                        return newData
                      })
                    }}
                    title="Click to add column"
                  >
                    <div className="text-blue-400 text-xs font-medium rotate-90 whitespace-nowrap opacity-100 transition-opacity">
                      + Column
                    </div>
                  </div>
                )}

                {/* Column with drag and keyboard positioning */}
                <div
                  className={clsx(
                    "relative",
                    editMode && layoutMode && column.nodes.length === 0 && "bg-red-50 hover:bg-red-100 transition-colors flex items-center justify-center cursor-pointer group rounded-lg"
                  )}
                  style={{
                    width: `${Math.max(...column.nodes.map(node => node.width || 192), 128)}px`,
                    height: editMode && layoutMode && column.nodes.length === 0
                      ? (svgSize.height > 0 ? `${svgSize.height - 124}px` : '740px')
                      : editMode
                      ? (svgSize.height > 0 ? `${svgSize.height - 62 - (data.title ? 80 : 0)}px` : '740px')
                      : 'auto'
                  }}
                  title={editMode && layoutMode && column.nodes.length === 0 ? "Click to delete column" : undefined}
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
                    // Only handle clicks on the column area itself
                    if (e.target === e.currentTarget) {
                      if (editMode && layoutMode && column.nodes.length === 0) {
                        // Delete the empty column
                        setDataAndNotify(prevData => {
                          const updatedSection = {
                            ...prevData.sections[sectionIndex],
                            columns: prevData.sections[sectionIndex].columns.filter((_, i) => i !== colIndex)
                          }

                          // If this was the last column in the section, delete the section entirely
                          const newSections = updatedSection.columns.length === 0
                            ? prevData.sections.filter((_, i) => i !== sectionIndex)
                            : prevData.sections.map((s, i) => i === sectionIndex ? updatedSection : s)

                          return {
                            ...prevData,
                            sections: newSections
                          }
                        })
                      } else {
                        // Deselect nodes when clicking column area
                        setHighlightedNodes(new Set())
                        setNodeWidth(192)
                        setNodeColor('#ffffff')
                      }
                    }
                  }}
                  onDoubleClick={editMode && !layoutMode ? (e) => {
                    // Only create new node if double-clicking in blank column area (not in layout mode)
                    if (e.target === e.currentTarget) {
                      const rect = e.currentTarget.getBoundingClientRect()
                      const viewportY = e.clientY - rect.top
                      const localY = viewportY / zoomScale
                      createNewNode(sectionIndex, colIndex, localY)
                    }
                  } : undefined}
                >
                  {column.nodes
                    .map((node, nodeIndex) => {
                      const nodeWidth = node.width || 192
                      const columnWidth = Math.max(...column.nodes.map(node => node.width || 192), 128)
                      const leftOffset = Math.max(0, (columnWidth - nodeWidth) / 2)

                      return (
                        <div
                          key={node.id}
                          className="absolute"
                          style={{
                            top: node.yPosition !== undefined
                              ? `${node.yPosition - (nodeHeights[node.id] || 76) / 2}px` // Convert from center to top position using cached height (76px is typical height for "New Node")
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
                            isEditingTitle={editingNodeId === node.id}
                            setEditingNodeId={setEditingNodeId}
                            updateNodeTitle={updateNodeTitle}
                          />
                        </div>
                      )
                    })}

                  {/* Label for empty column in add/remove mode */}
                  {editMode && layoutMode && column.nodes.length === 0 && (
                    <div className="text-red-400 text-xs font-medium rotate-90 whitespace-nowrap opacity-100 transition-opacity">
                      - Delete
                    </div>
                  )}
                </div>

                {/* Gap after column with click to add column */}
                {editMode && layoutMode && (
                  <div
                    className="bg-blue-50 hover:bg-blue-100 transition-colors flex items-center justify-center cursor-pointer group rounded-lg"
                    style={{ width: `${columnPadding}px`, height: svgSize.height > 0 ? `${svgSize.height  - 124}px` : '740px' }}
                    onDragOver={(e) => {
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      const yPosition = e.clientY - rect.top
                      handleDragOver(sectionIndex, colIndex + 1, true, yPosition)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      const rect = e.currentTarget.getBoundingClientRect()
                      const yPosition = e.clientY - rect.top
                      handleDrop(sectionIndex, colIndex + 1, true, yPosition)
                    }}
                    onClick={() => {
                      // Add new column
                      setDataAndNotify(prevData => {
                        const newData = { ...prevData }
                        newData.sections[sectionIndex].columns.splice(colIndex + 1, 0, { nodes: [] })
                        return newData
                      })
                    }}
                    title="Click to add column"
                  >
                    <div className="text-blue-400 text-xs font-medium rotate-90 whitespace-nowrap opacity-100 transition-opacity">
                      + Column
                    </div>
                  </div>
                )}
              </React.Fragment>
            ))}
              </div>
            </div>
          </div>
          </div>
          {/* Gap after last section with click to add section */}
          {editMode && layoutMode && sectionIndex === data.sections.length - 1 && (
            <div
              className="bg-green-50 hover:bg-green-100 transition-colors flex items-center justify-center cursor-pointer group rounded-lg"
              style={{ width: `${sectionPadding}px`, height: svgSize.height > 0 ? `${svgSize.height - 124}px` : '740px', marginTop: '68px' }}
              onClick={() => {
                setDataAndNotify(prevData => {
                  const newData = { ...prevData }
                  newData.sections.splice(sectionIndex + 1, 0, {
                    title: 'New Section',
                    columns: [{ nodes: [] }]
                  })
                  return newData
                })
              }}
              title="Click to add section"
            >
              <div className="text-green-500 text-xs font-medium rotate-90 whitespace-nowrap opacity-100 transition-opacity">
                + Section
              </div>
            </div>
          )}
        </React.Fragment>
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
        layoutMode={layoutMode}
        sectionWidths={sectionWidths}
        columnPadding={columnPadding}
        sectionPadding={sectionPadding}
        onSizeChange={(size) => {
          setSvgSize(size)
          onSizeChange?.(size)
        }}
        onDeleteConnection={deleteConnection}
        containerRef={graphContainerRef}
        onEdgePopupChange={setEdgePopup}
      />

      {createPortal(
        <EditToolbar
        editMode={editMode}
        setEditMode={setEditMode}
        showEditButton={showEditButton}
        highlightedNodes={highlightedNodes}
        setHighlightedNodes={setHighlightedNodes}
        layoutMode={layoutMode}
        setLayoutMode={setLayoutMode}
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
        undoHistory={undoHistory}
        redoHistory={redoHistory}
        handleUndo={handleUndo}
        handleRedo={handleRedo}
        setShowShareModal={setShowShareModal}
        isSaving={isSaving}
        currentEditToken={currentEditToken}
        lastSyncTime={lastSyncTime}
        isManualSyncing={isManualSyncing}
        handleManualSync={handleManualSync}
        getTimeAgo={getTimeAgo}
        data={data}
        onDeleteNode={deleteNode}
        nodePopup={nodePopup}
        edgePopup={edgePopup}
        camera={camera}
        onEditTokenChange={onEditTokenChange}
        containerSize={svgSize}
      />,
        document.body
      )}

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
          const positionCalculatedRef = useRef(false)

          // Calculate position only once per button instance
          useEffect(() => {
            // Only calculate once per button pair
            if (positionCalculatedRef.current) {
              return
            }

            const sourceNodeRef = nodeRefs[sourceId]
            const targetNodeRef = nodeRefs[targetId]

            if (!sourceNodeRef || !targetNodeRef) {
              return
            }

            const container = graphContainerRef.current || sourceNodeRef.closest(".flex.relative")
            if (!container) {
              return
            }

            // Use the same getLocalPosition function as ConnectionsComponent
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

            const sourcePos = getLocalPosition(sourceNodeRef)
            const targetPos = getLocalPosition(targetNodeRef)

            // Check if nodes are in the same column for vertical connections
            const sourceLocation = findNodeLocation(sourceId)
            const targetLocation = findNodeLocation(targetId)
            const isSameColumn = sourceLocation && targetLocation &&
                               sourceLocation.sectionIndex === targetLocation.sectionIndex &&
                               sourceLocation.columnIndex === targetLocation.columnIndex

            // Check if this is a backward connection (right to left)
            const isBackwardConnection = !isSameColumn && sourceLocation && targetLocation && (
              targetLocation.sectionIndex < sourceLocation.sectionIndex ||
              (targetLocation.sectionIndex === sourceLocation.sectionIndex &&
               targetLocation.columnIndex < sourceLocation.columnIndex)
            )

            let startX, startY, endX, endY

            if (isSameColumn) {
              // Vertical connection logic (using local coordinates)
              startX = sourcePos.x + sourcePos.width / 2
              endX = targetPos.x + targetPos.width / 2

              if (sourcePos.y < targetPos.y) {
                startY = sourcePos.y + sourcePos.height
                endY = targetPos.y - 14
              } else {
                startY = sourcePos.y
                endY = targetPos.y + targetPos.height + 14
              }
            } else if (isBackwardConnection) {
              // Backward connection logic (right to left)
              startX = sourcePos.x // Start from left side of source node
              startY = sourcePos.y + sourcePos.height / 2
              endX = targetPos.x + targetPos.width + 14 // End at right side of target node with arrow offset
              endY = targetPos.y + targetPos.height / 2
            } else {
              // Forward connection logic (left to right)
              startX = sourcePos.x + sourcePos.width
              startY = sourcePos.y + sourcePos.height / 2
              endX = targetPos.x - 14
              endY = targetPos.y + targetPos.height / 2
            }

            // Position at midpoint
            const midX = (startX + endX) / 2
            const midY = (startY + endY) / 2

            setPosition({ x: midX, y: midY })
            positionCalculatedRef.current = true // Mark as calculated
          }, [sourceId, targetId]) // Only depends on node IDs

          // Reset calculation flag when nodes change
          useEffect(() => {
            positionCalculatedRef.current = false
          }, [sourceId, targetId])
          
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
          )
        }
        
        return <ConnectButton />
      })()}

      {/* Draggable Legend */}
      <Legend
        legendPosition={legendPosition}
        setLegendPosition={setLegendPosition}
        isDraggingLegend={isDraggingLegend}
        setIsDraggingLegend={setIsDraggingLegend}
        legendDragOffset={legendDragOffset}
        setLegendDragOffset={setLegendDragOffset}
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

