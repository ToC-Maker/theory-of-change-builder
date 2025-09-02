import React, { useState, useEffect } from "react"
import { getContrastTextColor } from "../utils"

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
}: EdgePopupProps) {
  const [editEvidence, setEditEvidence] = useState(edgePopup.evidence || '')
  const [editAssumptions, setEditAssumptions] = useState(edgePopup.assumptions || '')
  const [isEditing, setIsEditing] = useState(editMode)

  useEffect(() => {
    setEditEvidence(edgePopup.evidence || '')
    setEditAssumptions(edgePopup.assumptions || '')
    setIsEditing(editMode)
  }, [edgePopup, editMode])

  const handleEvidenceChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newEvidence = e.target.value
    setEditEvidence(newEvidence)
    if (onUpdateConnection) {
      onUpdateConnection(edgePopup.sourceId, edgePopup.targetId, newEvidence, editAssumptions)
    }
  }

  const handleAssumptionsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newAssumptions = e.target.value
    setEditAssumptions(newAssumptions)
    if (onUpdateConnection) {
      onUpdateConnection(edgePopup.sourceId, edgePopup.targetId, editEvidence, newAssumptions)
    }
  }

  return (
    <div 
      className="absolute z-50 flex items-center justify-center transition-all duration-150 ease-out"
      style={{
        top: 0,
        left: 0,
        width: `${svgSize.width}px`,
        height: `${svgSize.height}px`,
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
        onClick={() => setEdgePopup(null)}
      />
      
      {/* Modal content */}
      <div 
        className="relative bg-white rounded-xl shadow-2xl p-8 overflow-y-auto transform transition-all duration-150 ease-out"
        style={{
          width: '800px',
          height: '600px',
          animation: 'scaleIn 0.15s ease-out'
        }}
      >
        {/* Close button */}
        <button
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-2xl leading-none"
          onClick={() => setEdgePopup(null)}
        >
          ×
        </button>
        
        {/* Header */}
        <div className="mb-6">
          <h2 className="text-4xl font-bold text-gray-900 mb-2">
            Connection Details
          </h2>
          <div 
            className="bg-gray-50 rounded-lg p-4 border-l-4 border-r-4"
            style={{ 
              borderLeftColor: '#000000',
              borderRightColor: '#000000'
            }}
          >
            <div className="text-sm text-gray-600 uppercase tracking-wide font-semibold mb-2">
              Connection
            </div>
            <div className="flex items-center gap-4">
              <div 
                className="flex-1 rounded-xl p-3 border-0 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.3),_0_4px_6px_-2px_rgba(0,0,0,0.15)] text-center"
                style={{ backgroundColor: findNodeColor(edgePopup.sourceId) }}
              >
                <div 
                  className="text-sm mb-1 opacity-75"
                  style={{ color: getContrastTextColor(findNodeColor(edgePopup.sourceId)) }}
                >
                  From
                </div>
                <div 
                  className="text-lg font-medium"
                  style={{ color: getContrastTextColor(findNodeColor(edgePopup.sourceId)) }}
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
                <div className="text-xs text-gray-500 mt-1">leads to</div>
              </div>
              <div 
                className="flex-1 rounded-xl p-3 border-0 shadow-[0_10px_15px_-3px_rgba(0,0,0,0.3),_0_4px_6px_-2px_rgba(0,0,0,0.15)] text-center"
                style={{ backgroundColor: findNodeColor(edgePopup.targetId) }}
              >
                <div 
                  className="text-sm mb-1 opacity-75"
                  style={{ color: getContrastTextColor(findNodeColor(edgePopup.targetId)) }}
                >
                  To
                </div>
                <div 
                  className="text-lg font-medium"
                  style={{ color: getContrastTextColor(findNodeColor(edgePopup.targetId)) }}
                >
                  {findNodeTitle(edgePopup.targetId)}
                </div>
              </div>
            </div>
          </div>
        </div>
        
        {/* Content */}
        <div className="space-y-6">
          <div>
            <h3 className="text-2xl font-semibold text-gray-800 mb-3">
              Confidence Level
            </h3>
            <div className="space-y-4">
              <div className="text-center">
                <span className="text-2xl font-bold text-gray-800">
                  {Math.round(edgePopup.confidence)}%
                </span>
                <span className="text-sm text-gray-500 ml-2">
                  ({edgePopup.confidence <= 33 ? 'Low' : edgePopup.confidence <= 66 ? 'Medium' : 'High'})
                </span>
              </div>
              
              <div className="space-y-3">
                <div className="flex items-center space-x-4">
                  <span className="text-xs text-gray-600 font-medium">0%</span>
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
                  <span className="text-xs text-gray-600 font-medium">100%</span>
                </div>
                <div className="text-xs text-gray-700 text-center">
                  {edgePopup.confidence >= 80
                    ? `Very strong confidence (${Math.round(edgePopup.confidence)}%). This connection has robust evidence and high certainty.`
                    : edgePopup.confidence >= 60
                    ? `Good confidence (${Math.round(edgePopup.confidence)}%). This connection has solid evidence with some certainty.`
                    : edgePopup.confidence >= 40
                    ? `Moderate confidence (${Math.round(edgePopup.confidence)}%). This connection has reasonable evidence but uncertainty remains.`
                    : edgePopup.confidence >= 20
                    ? `Low confidence (${Math.round(edgePopup.confidence)}%). This connection has limited evidence and significant uncertainty.`
                    : `Very low confidence (${Math.round(edgePopup.confidence)}%). This connection is speculative with minimal supporting evidence.`}
                </div>
              </div>
            </div>
          </div>
          
          <div>
            <h3 className="text-2xl font-semibold text-gray-800 mb-3">
              Why this connection exists
            </h3>
            <p className="text-gray-600 leading-relaxed">
              This connection represents the causal relationship between these two elements in the theory of change. 
              The source element directly contributes to or enables the target element.
            </p>
          </div>
          
          <div>
            <div className="flex items-center justify-center mb-3 relative">
              <h3 className="text-2xl font-semibold text-gray-800">
                Assumptions & Evidence
              </h3>
              {editMode && !isEditing && (
                <button
                  onClick={() => setIsEditing(true)}
                  className="absolute right-0 text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
                  title="Edit connection details"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                  </svg>
                </button>
              )}
            </div>
            
            <div className="space-y-4">
              <div>
                <h4 className="font-medium text-gray-800 mb-2">Key Assumptions:</h4>
                {editMode && isEditing ? (
                  <textarea
                    value={editAssumptions}
                    onChange={handleAssumptionsChange}
                    className="w-full h-24 px-3 py-2 text-gray-600 text-sm leading-relaxed border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 resize-vertical"
                    placeholder="What assumptions are being made for this connection to hold true?"
                  />
                ) : (
                  <p className="text-gray-600 leading-relaxed whitespace-pre-wrap">
                    {editAssumptions || "No assumptions documented yet."}
                  </p>
                )}
              </div>
              
              <div>
                <h4 className="font-medium text-gray-800 mb-2">Evidence:</h4>
                {editMode && isEditing ? (
                  <textarea
                    value={editEvidence}
                    onChange={handleEvidenceChange}
                    className="w-full h-24 px-3 py-2 text-gray-600 text-sm leading-relaxed border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 resize-vertical"
                    placeholder="What evidence supports this connection?"
                  />
                ) : (
                  <p className="text-gray-600 leading-relaxed whitespace-pre-wrap">
                    {editEvidence || "No evidence documented yet."}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}