import { useCallback, useEffect, useState } from 'react'
import { Node, ToCData } from '../types'

interface UseKeyboardShortcutsProps {
  data: ToCData
  setDataAndNotify: (data: ToCData | ((prevData: ToCData) => ToCData)) => void
  highlightedNodes: Set<string>
  setHighlightedNodes: (nodes: Set<string>) => void
  editMode: boolean
  nodeRefs: { [key: string]: HTMLDivElement | null } 
  setNodeWidth: (width: number) => void
  setNodeColor: (color: string) => void
  setNodePopup: React.Dispatch<React.SetStateAction<{ id: string; title: string; text: string } | null>>
  moveNodeVertically: (nodeId: string, direction: 'up' | 'down') => void
  nodeHeights: { [key: string]: number }
}

export function useKeyboardShortcuts({
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
}: UseKeyboardShortcutsProps) {
  const [currentTabIndex, setCurrentTabIndex] = useState(-1)

  // Find node location helper
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

  // Get all nodes in reading order (left to right, top to bottom)
  const getAllNodesInOrder = useCallback(() => {
    const allNodes: { node: Node; sectionIndex: number; columnIndex: number; nodeIndex: number }[] = []
    data.sections.forEach((section, sectionIndex) => {
      section.columns.forEach((column, columnIndex) => {
        column.nodes.forEach((node, nodeIndex) => {
          allNodes.push({ node, sectionIndex, columnIndex, nodeIndex })
        })
      })
    })
    return allNodes
  }, [data.sections])

  // Select all nodes
  const selectAllNodes = useCallback(() => {
    const allNodeIds = new Set<string>()
    data.sections.forEach(section => {
      section.columns.forEach(column => {
        column.nodes.forEach(node => {
          allNodeIds.add(node.id)
        })
      })
    })
    setHighlightedNodes(allNodeIds)
  }, [data.sections, setHighlightedNodes])

  // Clear all selections and close search
  const clearSelections = useCallback(() => {
    setHighlightedNodes(new Set())
    setNodeWidth(192)
    setNodeColor('#ffffff')
    setNodePopup(null)
  }, [setHighlightedNodes, setNodeWidth, setNodeColor, setNodePopup])

  // Navigate to next/previous node with Tab
  const navigateNodes = useCallback((direction: 'next' | 'previous' = 'next') => {
    const allNodes = getAllNodesInOrder()
    if (allNodes.length === 0) return

    const newIndex = direction === 'next'
      ? (currentTabIndex + 1) % allNodes.length
      : (currentTabIndex - 1 + allNodes.length) % allNodes.length

    setCurrentTabIndex(newIndex)
    const targetNode = allNodes[newIndex]
    
    // Select the node
    setHighlightedNodes(new Set([targetNode.node.id]))
    
    // Scroll to the node
    const nodeRef = nodeRefs[targetNode.node.id]
    if (nodeRef) {
      nodeRef.scrollIntoView({ behavior: 'smooth', block: 'center' })
      
      // Update width and color controls
      setNodeWidth(targetNode.node.width || 192)
      setNodeColor(targetNode.node.color || '#ffffff')
    }
  }, [getAllNodesInOrder, currentTabIndex, nodeRefs, setHighlightedNodes, setNodeWidth, setNodeColor])

  // Copy selected nodes (disabled in edit mode)
  const copySelectedNodes = useCallback(() => {
    // No copying functionality in edit mode
    return
  }, [])

  // Paste copied nodes (disabled in edit mode)
  const pasteNodes = useCallback(() => {
    // No pasting functionality in edit mode
    return
  }, [])

  // Move node horizontally between columns and sections
  const moveNodeHorizontally = useCallback((nodeId: string, direction: 'left' | 'right') => {
    if (!editMode) return

    const nodeLocation = findNodeLocation(nodeId)
    if (!nodeLocation) return

    const { sectionIndex, columnIndex } = nodeLocation
    let targetSectionIndex = sectionIndex
    let targetColumnIndex = direction === 'left' ? columnIndex - 1 : columnIndex + 1
    
    // Check if we need to move to a different section
    if (targetColumnIndex < 0) {
      // Moving left beyond current section - go to rightmost column of previous section
      if (sectionIndex > 0) {
        targetSectionIndex = sectionIndex - 1
        targetColumnIndex = Math.max(0, data.sections[targetSectionIndex].columns.length - 1)
      } else {
        return // Already at leftmost column of first section
      }
    } else if (targetColumnIndex >= data.sections[sectionIndex].columns.length) {
      // Moving right beyond current section - go to leftmost column of next section
      if (sectionIndex < data.sections.length - 1) {
        targetSectionIndex = sectionIndex + 1
        targetColumnIndex = 0
      } else {
        return // Already at rightmost column of last section
      }
    }

    setDataAndNotify(prevData => {
      const newData = { ...prevData }
      
      // Ensure target section has at least one column
      if (newData.sections[targetSectionIndex].columns.length === 0) {
        newData.sections[targetSectionIndex].columns.push({ nodes: [] })
        targetColumnIndex = 0
      }
      
      const sourceSection = newData.sections[sectionIndex]
      const targetSection = newData.sections[targetSectionIndex]
      const sourceColumn = sourceSection.columns[columnIndex]
      const targetColumn = targetSection.columns[targetColumnIndex]
      
      // Find the node to move
      const nodeToMove = sourceColumn.nodes.find(node => node.id === nodeId)
      if (!nodeToMove) return prevData

      // Remove node from source column
      sourceColumn.nodes = sourceColumn.nodes.filter(node => node.id !== nodeId)
      
      // Add node to target column with preserved yPosition or calculate new position
      const nodeWithPosition = {
        ...nodeToMove,
        yPosition: nodeToMove.yPosition || (targetColumn.nodes.length * 180 + 30 + (nodeHeights[nodeId] || 150) / 2)
      }
      targetColumn.nodes.push(nodeWithPosition)

      return newData
    })
  }, [editMode, findNodeLocation, data.sections, setDataAndNotify, nodeHeights])

  // Delete selected nodes
  const deleteSelectedNodes = useCallback(() => {
    if (highlightedNodes.size === 0 || !editMode) return

    setDataAndNotify(prevData => ({
      ...prevData,
      sections: prevData.sections.map(section => ({
        ...section,
        columns: section.columns.map(column => ({
          ...column,
          nodes: column.nodes.filter(node => !highlightedNodes.has(node.id))
        }))
      }))
    }))

    // Also remove any connections to deleted nodes
    setDataAndNotify(prevData => ({
      ...prevData,
      sections: prevData.sections.map(section => ({
        ...section,
        columns: section.columns.map(column => ({
          ...column,
          nodes: column.nodes.map(node => ({
            ...node,
            connectionIds: node.connectionIds?.filter(id => !highlightedNodes.has(id)) || [],
            connections: node.connections?.filter(conn => !highlightedNodes.has(conn.targetId))
          }))
        }))
      }))
    }))

    setHighlightedNodes(new Set())
  }, [highlightedNodes, editMode, setDataAndNotify, setHighlightedNodes])

  // Enhanced keyboard event handler
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if user is typing in an input field
      const activeElement = document.activeElement
      const isTyping = activeElement && (
        activeElement.tagName === 'INPUT' || 
        activeElement.tagName === 'TEXTAREA' ||
        (activeElement as HTMLElement).contentEditable === 'true'
      )

      // Allow ALL shortcuts to pass through when typing in input fields
      if (isTyping) {
        // Don't interfere with any keyboard shortcuts while user is typing
        return
      }

      // Handle Ctrl+A / Cmd+A - Select all nodes (only in edit mode)
      if ((event.ctrlKey || event.metaKey) && event.key === 'a' && editMode) {
        event.preventDefault()
        selectAllNodes()
        return
      }

      // Handle Tab - Navigate through nodes (cycles, auto-scrolls)
      if (event.key === 'Tab') {
        event.preventDefault()
        navigateNodes(event.shiftKey ? 'previous' : 'next')
        return
      }

      // Handle Escape - Clear selection/close search/cancel editing
      if (event.key === 'Escape') {
        event.preventDefault()
        clearSelections()
        return
      }

      // Handle Delete - Delete selected nodes
      if (event.key === 'Delete' && editMode && highlightedNodes.size > 0) {
        event.preventDefault()
        deleteSelectedNodes()
        return
      }

      // Handle arrow keys for moving nodes
      if (editMode && highlightedNodes.size > 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault()
        
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          const direction = event.key === 'ArrowUp' ? 'up' : 'down'
          
          // Move all highlighted nodes vertically
          highlightedNodes.forEach((nodeId) => {
            moveNodeVertically(nodeId, direction)
          })
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          const direction = event.key === 'ArrowLeft' ? 'left' : 'right'
          
          // Move all highlighted nodes horizontally
          highlightedNodes.forEach((nodeId) => {
            moveNodeHorizontally(nodeId, direction)
          })
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [editMode, highlightedNodes, moveNodeVertically, moveNodeHorizontally, selectAllNodes, navigateNodes, clearSelections, copySelectedNodes, pasteNodes, deleteSelectedNodes])

  return {
    // State
    currentTabIndex,
    
    // Functions
    findNodeLocation,
    getAllNodesInOrder,
    selectAllNodes,
    clearSelections,
    navigateNodes,
    copySelectedNodes,
    pasteNodes,
    deleteSelectedNodes,
    moveNodeHorizontally
  }
}