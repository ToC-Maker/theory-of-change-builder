import React, { useState, useRef, useEffect } from "react"

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

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value
    setEditText(newText)
    if (onUpdateNode) {
      onUpdateNode(nodePopup.id, editTitle, newText)
    }
  }

  const handleDeleteNode = () => {
    if (onDeleteNode) {
      onDeleteNode(nodePopup.id)
      setNodePopup(null)
    }
  }

  return (
    <div 
      className="fixed inset-0 z-[100] flex items-center justify-center transition-all duration-150 ease-out"
      style={{
        pointerEvents: 'auto',
        animation: 'fadeIn 0.15s ease-out'
      }}
    >
      {/* Backdrop with blur */}
      <div 
        className="absolute bg-black bg-opacity-40 backdrop-blur-[2px]"
        style={{
          top: 0,
          left: 0,
          width: '100%',
          height: '100%'
        }}
        onClick={() => setNodePopup(null)}
      />
      
      {/* Modal content */}
      <div 
        className="relative bg-white rounded-xl shadow-2xl p-8 overflow-y-auto max-h-[500px] transform transition-all duration-150 ease-out"
        style={{
          width: '600px',
          animation: 'scaleIn 0.15s ease-out'
        }}
      >
        {/* Delete button - top left */}
        {editMode && onDeleteNode && (
          <button
            className="absolute top-4 left-4 text-gray-400 hover:text-red-600 transition-colors"
            onClick={handleDeleteNode}
            title="Delete node"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1-1H8a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        )}

        {/* Close button - top right */}
        <button
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
          onClick={() => setNodePopup(null)}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        
        {/* Header */}
        <div className="mt-4 mb-6">
          {editMode && isEditing ? (
            <textarea
              ref={titleInputRef}
              value={editTitle}
              onChange={handleTitleChange}
              className="text-lg font-bold text-gray-900 mb-2 w-full px-2 py-1 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none overflow-hidden"
              autoFocus
              rows={1}
              style={{ minHeight: '2.25rem' }}
              onInput={(e) => {
                // Auto-resize textarea based on content
                const target = e.target as HTMLTextAreaElement;
                target.style.height = 'auto';
                target.style.height = target.scrollHeight + 'px';
              }}
            />
          ) : (
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-gray-900 mb-2 whitespace-pre-wrap text-left">
                {nodePopup.title}
              </h2>
              {editMode && !isEditing && (
                <button
                  onClick={() => setIsEditing(true)}
                  className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
                  title="Edit node"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </div>
        
        {/* Content */}
        <div className="space-y-6">
          <div>
            {editMode && isEditing ? (
              <textarea
                ref={textAreaRef}
                value={editText}
                onChange={handleTextChange}
                className="w-full h-32 px-3 py-2 text-gray-600 text-sm leading-relaxed border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 resize-vertical"
                placeholder="Node description..."
              />
            ) : (
              <p className="text-gray-600 leading-relaxed text-sm text-left">
                {nodePopup.text}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}