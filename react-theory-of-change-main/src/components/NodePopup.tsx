import React, { useState, useRef, useEffect } from "react"
import { MDXEditorComponent } from './MDXEditor'
import { PencilIcon } from '@heroicons/react/24/outline'

interface NodePopupProps {
  nodePopup: {
    id: string
    title: string
    text: string
  }
  setNodePopup: React.Dispatch<React.SetStateAction<{ id: string; title: string; text: string } | null>>
  svgSize: { width: number; height: number }
  editMode?: boolean
  onUpdateNode?: (nodeId: string, title: string, text: string) => void
  onDeleteNode?: (nodeId: string) => void
  fontFamily?: string
  onClearSelection?: () => void
  viewportOffset?: { left: number; top: number; right: number; bottom: number }
  zoomScale?: number
}

export function NodePopup({
  nodePopup,
  setNodePopup,
  svgSize,
  editMode = false,
  onUpdateNode,
  onDeleteNode,
  fontFamily,
  onClearSelection,
  viewportOffset = { left: 0, top: 0, right: 0, bottom: 0 },
  zoomScale = 1,
}: NodePopupProps) {
  const [editTitle, setEditTitle] = useState(nodePopup.title)
  const [editText, setEditText] = useState(nodePopup.text)
  const [isEditing, setIsEditing] = useState(editMode)
  const titleInputRef = useRef<HTMLTextAreaElement>(null)
  const textAreaRef = useRef<HTMLTextAreaElement>(null)
  const [windowSize, setWindowSize] = useState({ width: typeof window !== 'undefined' ? window.innerWidth : 1000, height: typeof window !== 'undefined' ? window.innerHeight : 800 })

  // Update window size on resize
  useEffect(() => {
    const handleResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight })
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Calculate scale based on available viewport size
  const availableWidth = windowSize.width - viewportOffset.left - viewportOffset.right
  const availableHeight = windowSize.height - viewportOffset.top - viewportOffset.bottom
  const isMobile = windowSize.width < 768
  const scaleX = Math.min(1, (availableWidth - 40) / 600) // 600px width + 40px margin
  const scaleY = Math.min(1, (availableHeight - 40) / 500) // 500px height + 40px margin
  const popupScale = Math.min(scaleX, scaleY)

  useEffect(() => {
    setEditTitle(nodePopup.title)
    setEditText(nodePopup.text)
    setIsEditing(editMode)
  }, [nodePopup, editMode])

  const handleTitleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newTitle = e.target.value
    setEditTitle(newTitle)
    if (onUpdateNode) {
      onUpdateNode(nodePopup.id, newTitle, editText)
    }
  }

  const handleTextChange = (newText: string) => {
    setEditText(newText)
    // Don't save immediately - let MDXEditor handle undo/redo internally
  }

  const saveChanges = () => {
    if (onUpdateNode && (editTitle !== nodePopup.title || editText !== nodePopup.text)) {
      onUpdateNode(nodePopup.id, editTitle, editText)
    }
  }

  const handleDeleteNode = () => {
    if (onDeleteNode) {
      onDeleteNode(nodePopup.id)
      setNodePopup(null)
    }
  }

  return (
    <>
      {/* Backdrop with blur - covers entire viewport */}
      <div
        className="fixed z-[200] bg-black bg-opacity-40 backdrop-blur-[2px]"
        style={{
          left: '-1000vw',
          top: '-1000vh',
          right: '-1000vw',
          bottom: '-1000vh',
          width: '2000vw',
          height: '2000vh'
        }}
        onClick={() => {
          saveChanges()
          setNodePopup(null)
          onClearSelection?.()
        }}
      />

      {/* Modal container - centered in available viewport area (accounting for sidebar) */}
      <div
        className="fixed z-[210] flex items-center justify-center transition-all duration-150 ease-out pointer-events-none"
        style={{
          top: isMobile ? 0 : viewportOffset.top,
          left: isMobile ? 0 : viewportOffset.left,
          right: isMobile ? 0 : viewportOffset.right,
          bottom: isMobile ? 0 : viewportOffset.bottom,
          animation: 'fadeIn 0.15s ease-out'
        }}
      >

        {/* Modal content - fixed size, scaled to fit viewport (full screen on mobile) */}
        <div
          className="relative bg-white shadow-2xl p-8 overflow-y-auto pointer-events-auto"
          style={{
            width: isMobile ? '100vw' : '600px',
            height: isMobile ? '100vh' : 'auto',
            maxHeight: isMobile ? '100vh' : '500px',
            borderRadius: isMobile ? 0 : '0.75rem',
            transform: isMobile ? 'none' : `scale(${popupScale})`
          }}
          onWheel={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onTouchMove={(e) => e.stopPropagation()}
        >

        {/* Close button - top right */}
        <button
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
          onClick={() => {
            saveChanges()
            setNodePopup(null)
            onClearSelection?.()
          }}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        
        {/* Header */}
        <div className="mt-4 mb-6 text-left">
          {editMode && isEditing ? (
            <div className="mb-2 text-left">
              <MDXEditorComponent
                markdown={editTitle}
                onChange={(newTitle) => {
                  setEditTitle(newTitle)
                  // Don't save immediately - let MDXEditor handle undo/redo internally
                }}
                placeholder="Enter node title..."
                simple={true}
                fontFamily={fontFamily}
              />
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900 mb-2 whitespace-pre-wrap text-left" style={{ fontFamily }}>
                {nodePopup.title}
              </h2>
              {editMode && !isEditing && (
                <button
                  onClick={() => {
                    saveChanges()
                    setIsEditing(true)
                  }}
                  className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
                  title="Edit node"
                >
                  <PencilIcon className="w-4 h-4" />
                </button>
              )}
            </div>
          )}
        </div>
        
        {/* Content */}
        <div className="space-y-6 text-left">
          <div className="text-left">
            {editMode && isEditing ? (
              <MDXEditorComponent
                markdown={editText}
                onChange={handleTextChange}
                placeholder="Enter node description... (Markdown supported)"
                fontFamily={fontFamily}
              />
            ) : (
              <div className="text-gray-600 leading-relaxed text-sm text-left">
                {nodePopup.text ? (
                  <MDXEditorComponent
                    markdown={nodePopup.text}
                    readOnly={true}
                    fontFamily={fontFamily}
                  />
                ) : (
                  <p className="text-gray-400 italic" style={{ fontFamily }}>No description</p>
                )}
              </div>
            )}
          </div>
        </div>
        </div>
      </div>
    </>
  )
}