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
  moveNodeVertically
}: UseKeyboardShortcutsProps) {
  const [copiedNodes, setCopiedNodes] = useState<Node[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
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
    setShowSearch(false)
    setSearchQuery('')
    setNodePopup(null)
  }, [setHighlightedNodes, setNodeWidth, setNodeColor, setNodePopup])

  // Navigate to next/previous node with Tab
  const navigateNodes = useCallback((direction: 'next' | 'previous' = 'next') => {
    const allNodes = getAllNodesInOrder()
    if (allNodes.length === 0) return

    let newIndex = direction === 'next' 
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
            connectionIds: node.connectionIds.filter(id => !highlightedNodes.has(id)),
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

      // Handle Ctrl+A - Select all nodes (only in edit mode)
      if (event.ctrlKey && event.key === 'a' && editMode) {
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

      // Handle Ctrl+F - Open search interface
      if (event.ctrlKey && event.key === 'f') {
        event.preventDefault()
        setShowSearch(true)
        return
      }

      // Handle arrow keys for moving nodes
      if (editMode && highlightedNodes.size > 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
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
  }, [editMode, highlightedNodes, moveNodeVertically, selectAllNodes, navigateNodes, clearSelections, copySelectedNodes, pasteNodes, deleteSelectedNodes, copiedNodes.length])

  return {
    // State
    copiedNodes,
    searchQuery,
    setSearchQuery,
    showSearch,
    setShowSearch,
    currentTabIndex,
    
    // Functions
    findNodeLocation,
    getAllNodesInOrder,
    selectAllNodes,
    clearSelections,
    navigateNodes,
    copySelectedNodes,
    pasteNodes,
    deleteSelectedNodes
  }
}