import clsx from "clsx"
import React, { useRef, useEffect } from "react"
import { Node } from "../types"
import { getContrastTextColor } from "../utils"

interface NodeComponentProps {
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
}

export function NodeComponent({
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
}: NodeComponentProps) {
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
    <div className="relative z-10">
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
        
        {/* Information/Edit icon for selected nodes with details - positioned relative to outer node */}
        {node.text && isHighlighted && (
          <button
            onClick={handleInfoClick}
            className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center hover:bg-gray-100 hover:bg-opacity-20 transition-colors z-10"
            style={{
              color: node.color ? getContrastTextColor(node.color) : '#6b7280'
            }}
            title={editMode ? "Edit details" : "View details"}
          >
            {editMode ? (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  )
}