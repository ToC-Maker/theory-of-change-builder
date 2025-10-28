import React, { useState, useEffect } from "react"
import { TrashIcon, PencilIcon } from "@heroicons/react/24/outline"
import { getContrastTextColor } from "../utils"
import { MDXEditorComponent } from './MDXEditor'

interface EdgePopupProps {
  edgePopup: {
    sourceId: string
    targetId: string
    x: number
    y: number
    confidence: number
    minConfidence?: number
    maxConfidence?: number
    evidence?: string
    assumptions?: string
  }
  setEdgePopup: React.Dispatch<React.SetStateAction<any>>
  updateConfidence: (sourceId: string, targetId: string, newConfidence: number) => void
  findNodeTitle: (nodeId: string) => string
  findNodeColor: (nodeId: string) => string
  svgSize: { width: number; height: number }
  editMode?: boolean
  onUpdateConnection?: (sourceId: string, targetId: string, evidence: string, assumptions: string) => void
  onDeleteConnection?: (sourceId: string, targetId: string) => void
  fontFamily?: string
}

export function EdgePopup({
  edgePopup,
  setEdgePopup,
  updateConfidence,
  findNodeTitle,
  findNodeColor,
  svgSize,
  editMode = false,
  onUpdateConnection,
  onDeleteConnection,
  fontFamily,
}: EdgePopupProps) {
  const [editEvidence, setEditEvidence] = useState(edgePopup.evidence || '')
  const [editAssumptions, setEditAssumptions] = useState(edgePopup.assumptions || '')
  const [isEditing, setIsEditing] = useState(editMode)

  useEffect(() => {
    setEditEvidence(edgePopup.evidence || '')
    setEditAssumptions(edgePopup.assumptions || '')
    setIsEditing(editMode)
  }, [edgePopup, editMode])

  const handleEvidenceChange = (newEvidence: string) => {
    setEditEvidence(newEvidence)
    // Don't save immediately - let MDXEditor handle undo/redo internally
  }

  const handleAssumptionsChange = (newAssumptions: string) => {
    setEditAssumptions(newAssumptions)
    // Don't save immediately - let MDXEditor handle undo/redo internally
  }

  const saveChanges = () => {
    if (onUpdateConnection && (editEvidence !== (edgePopup.evidence || '') || editAssumptions !== (edgePopup.assumptions || ''))) {
      onUpdateConnection(edgePopup.sourceId, edgePopup.targetId, editEvidence, editAssumptions)
    }
  }

  const handleDeleteConnection = () => {
    if (onDeleteConnection) {
      onDeleteConnection(edgePopup.sourceId, edgePopup.targetId)
      setEdgePopup(null)
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
          setEdgePopup(null)
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
          className="relative bg-white rounded-xl shadow-2xl flex flex-col transform transition-all duration-150 ease-out pointer-events-auto"
          style={{
            width: '800px',
            height: '600px',
            animation: 'scaleIn 0.15s ease-out'
          }}
        >
        {/* Fixed Header */}
        <div className="relative flex-shrink-0 p-8 pb-4 border-b border-gray-200">
          {/* Delete button - top left */}
          {editMode && onDeleteConnection && (
            <button
              className="absolute top-4 left-4 text-gray-400 hover:text-red-600 transition-colors"
              onClick={handleDeleteConnection}
              title="Delete connection"
            >
              <TrashIcon className="w-5 h-5" />
            </button>
          )}

          {/* Close button - top right */}
          <button
            className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-2xl leading-none"
            onClick={() => {
              saveChanges()
              setEdgePopup(null)
            }}
          >
            ×
          </button>

          <h2 className="text-4xl font-bold text-gray-900 mb-2" style={{ fontFamily }}>
            Connection Details
          </h2>
          <div
            className="bg-gray-50 rounded-lg p-4 border-l-4 border-r-4"
            style={{
              borderLeftColor: '#000000',
              borderRightColor: '#000000'
            }}
          >
            <div className="text-sm text-gray-600 uppercase tracking-wide font-semibold mb-2" style={{ fontFamily }}>
              Connection
            </div>
            <div className="flex items-center gap-4">
              <div
                className="flex-1 rounded-xl p-3 border-0 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.3),_0_4px_6px_-2px_rgba(0,0,0,0.15)] text-center"
                style={{ backgroundColor: findNodeColor(edgePopup.sourceId) }}
              >
                <div
                  className="text-sm mb-1 opacity-75"
                  style={{ color: getContrastTextColor(findNodeColor(edgePopup.sourceId)), fontFamily }}
                >
                  From
                </div>
                <div
                  className="text-lg font-medium"
                  style={{ color: getContrastTextColor(findNodeColor(edgePopup.sourceId)), fontFamily }}
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
                <div className="text-xs text-gray-500 mt-1" style={{ fontFamily }}>leads to</div>
              </div>
              <div
                className="flex-1 rounded-xl p-3 border-0 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.3),_0_4px_6px_-2px_rgba(0,0,0,0.15)] text-center"
                style={{ backgroundColor: findNodeColor(edgePopup.targetId) }}
              >
                <div
                  className="text-sm mb-1 opacity-75"
                  style={{ color: getContrastTextColor(findNodeColor(edgePopup.targetId)), fontFamily }}
                >
                  To
                </div>
                <div
                  className="text-lg font-medium"
                  style={{ color: getContrastTextColor(findNodeColor(edgePopup.targetId)), fontFamily }}
                >
                  {findNodeTitle(edgePopup.targetId)}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-8">
          <div className="space-y-6">
          <div>
            <h3 className="text-2xl font-semibold text-gray-800 mb-3" style={{ fontFamily }}>
              Confidence Level
            </h3>
            <div className="space-y-4">
              <div className="text-center">
                <span className="text-2xl font-bold text-gray-800" style={{ fontFamily }}>
                  {Math.round(edgePopup.confidence)}%
                </span>
              </div>
              
              <div className="space-y-3">
                {editMode && (
                  <div className="flex items-center space-x-4">
                    <span className="text-xs text-gray-600 font-medium" style={{ fontFamily }}>0%</span>
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
                    <span className="text-xs text-gray-600 font-medium" style={{ fontFamily }}>100%</span>
                  </div>
                )}
                <div className="text-xs text-gray-700 text-center" style={{ fontFamily }}>
                  {edgePopup.confidence >= 80
                    ? `Very high confidence (${Math.round(edgePopup.confidence)}%). This connection has robust evidence and high certainty.`
                    : edgePopup.confidence >= 60
                    ? `High confidence (${Math.round(edgePopup.confidence)}%). This connection has solid evidence with some certainty.`
                    : edgePopup.confidence >= 40
                    ? `Medium confidence (${Math.round(edgePopup.confidence)}%). This connection has reasonable evidence but uncertainty remains.`
                    : edgePopup.confidence >= 20
                    ? `Low confidence (${Math.round(edgePopup.confidence)}%). This connection has limited evidence and significant uncertainty.`
                    : `Very low confidence (${Math.round(edgePopup.confidence)}%). This connection is speculative with minimal supporting evidence.`}
                </div>
              </div>
            </div>
          </div>
          
          <div>
            <div className="flex items-center justify-between mb-3 relative">
              {editMode && !isEditing && (
                <button
                  onClick={() => {
                    saveChanges()
                    setIsEditing(true)
                  }}
                  className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
                  title="Edit connection details"
                >
                  <PencilIcon className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="space-y-4 text-left">
              <div>
                <h4 className="font-medium text-gray-800 mb-2 text-left" style={{ fontFamily }}>Assumptions</h4>
                {editMode && isEditing ? (
                  <MDXEditorComponent
                    markdown={editAssumptions}
                    onChange={handleAssumptionsChange}
                    placeholder="What assumptions are being made for this connection to hold true?"
                    fontFamily={fontFamily}
                  />
                ) : (
                  <div className="text-gray-600 leading-relaxed text-left">
                    {editAssumptions ? (
                      <MDXEditorComponent
                        markdown={editAssumptions}
                        readOnly={true}
                        fontFamily={fontFamily}
                      />
                    ) : (
                      <p className="text-gray-400 italic" style={{ fontFamily }}>No assumptions documented yet.</p>
                    )}
                  </div>
                )}
              </div>

              <div>
                <h4 className="font-medium text-gray-800 mb-2 text-left" style={{ fontFamily }}>Evidence</h4>
                {editMode && isEditing ? (
                  <MDXEditorComponent
                    markdown={editEvidence}
                    onChange={handleEvidenceChange}
                    placeholder="What evidence supports this connection?"
                    fontFamily={fontFamily}
                  />
                ) : (
                  <div className="text-gray-600 leading-relaxed text-left">
                    {editEvidence ? (
                      <MDXEditorComponent
                        markdown={editEvidence}
                        readOnly={true}
                        fontFamily={fontFamily}
                      />
                    ) : (
                      <p className="text-gray-400 italic" style={{ fontFamily }}>No evidence documented yet.</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footnote */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <p className="text-xs text-gray-500 text-left" style={{ fontFamily }}>
              * This connection represents the causal relationship between these two elements in the theory of change.
              The source element directly contributes to or enables the target element.
            </p>
          </div>
        </div>
        </div>
        </div>
      </div>
    </>
  )
}