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
}

export function NodePopup({
  nodePopup,
  setNodePopup,
  svgSize,
  editMode = false,
  onUpdateNode,
  onDeleteNode,
}: NodePopupProps) {
  const [editTitle, setEditTitle] = useState(nodePopup.title)
  const [editText, setEditText] = useState(nodePopup.text)
  const [isEditing, setIsEditing] = useState(editMode)
  const titleInputRef = useRef<HTMLTextAreaElement>(null)
  const textAreaRef = useRef<HTMLTextAreaElement>(null)

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
          left: '-200vw',
          top: '-200vh',
          right: '-200vw',
          bottom: '-200vh',
          width: '500vw',
          height: '500vh'
        }}
        onClick={() => {
          saveChanges()
          setNodePopup(null)
        }}
      />

      {/* Modal container - centered in graph container */}
      <div
        className="absolute inset-0 z-[210] flex items-center justify-center transition-all duration-150 ease-out pointer-events-none"
        style={{
          animation: 'fadeIn 0.15s ease-out'
        }}
      >
      
        {/* Modal content */}
        <div
          className="relative bg-white rounded-xl shadow-2xl p-8 overflow-y-auto max-h-[500px] transform transition-all duration-150 ease-out pointer-events-auto"
          style={{
            width: '600px',
            animation: 'scaleIn 0.15s ease-out'
          }}
        >

        {/* Close button - top right */}
        <button
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
          onClick={() => {
            saveChanges()
            setNodePopup(null)
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
              />
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900 mb-2 whitespace-pre-wrap text-left">
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
              />
            ) : (
              <div className="text-gray-600 leading-relaxed text-sm text-left">
                {nodePopup.text ? (
                  <MDXEditorComponent
                    markdown={nodePopup.text}
                    readOnly={true}
                  />
                ) : (
                  <p className="text-gray-400 italic">No description</p>
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