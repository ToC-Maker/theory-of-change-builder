import React from 'react'

interface EditModeToggleProps {
  editMode: boolean
  setEditMode: (editMode: boolean) => void
  setHighlightedNodes: (nodes: Set<string>) => void
  setColumnDragMode: (enabled: boolean) => void
  setNodeWidth: (width: number) => void
  setNodeColor: (color: string) => void
  show?: boolean
}

export function EditModeToggle({
  editMode,
  setEditMode,
  setHighlightedNodes,
  setColumnDragMode,
  setNodeWidth,
  setNodeColor,
  show = true
}: EditModeToggleProps) {
  if (!show) return null
  
  return (
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
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
        </svg>
      </button>
    </div>
  )
}