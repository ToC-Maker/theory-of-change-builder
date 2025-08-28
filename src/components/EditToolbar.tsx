import React from "react"
import { ToCData } from "../types"

interface EditToolbarProps {
  editMode: boolean
  highlightedNodes: Set<string>
  columnDragMode: boolean
  setColumnDragMode: React.Dispatch<React.SetStateAction<boolean>>
  curvature: number
  setCurvature: React.Dispatch<React.SetStateAction<number>>
  textSize: number
  setTextSize: React.Dispatch<React.SetStateAction<number>>
  nodeWidth: number
  setNodeWidth: React.Dispatch<React.SetStateAction<number>>
  nodeColor: string
  setNodeColor: React.Dispatch<React.SetStateAction<string>>
  straightenEdges: () => void
  connectSelectedNodes: () => void
  areNodesConnected: (sourceId: string, targetId: string) => boolean
  copyGraphJSON: () => Promise<void>
  setData: React.Dispatch<React.SetStateAction<ToCData>>
}

export function EditToolbar({
  editMode,
  highlightedNodes,
  columnDragMode,
  setColumnDragMode,
  curvature,
  setCurvature,
  textSize,
  setTextSize,
  nodeWidth,
  setNodeWidth,
  nodeColor,
  setNodeColor,
  straightenEdges,
  connectSelectedNodes,
  areNodesConnected,
  copyGraphJSON,
  setData,
}: EditToolbarProps) {
  if (!editMode) return null

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200 shadow-lg">
      <div className="max-w-none mx-auto px-4 py-4" style={{ maxWidth: '120rem' }}>
        <div className="flex items-center justify-between">
          {/* Left side - Main tools */}
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              <h3 className="font-medium text-gray-900">Edit Tools</h3>
            </div>
            
            {/* Action Buttons */}
            <div className="flex items-center gap-4">
              {/* Straighten Edges Tool */}
              <button
                onClick={straightenEdges}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-indigo-50 hover:text-indigo-600 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
                <span>Straighten</span>
              </button>

              {/* Connect Nodes Tool */}
              <button
                onClick={connectSelectedNodes}
                disabled={highlightedNodes.size !== 2}
                className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                  highlightedNodes.size === 2
                    ? 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-600'
                    : 'text-gray-400 cursor-not-allowed'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                <span>
                  {highlightedNodes.size === 0 && 'Connect (Select 2)'}
                  {highlightedNodes.size === 1 && 'Connect (Select 1 more)'}
                  {highlightedNodes.size === 2 && (() => {
                    const [sourceId, targetId] = Array.from(highlightedNodes)
                    return areNodesConnected(sourceId, targetId) ? 'Disconnect' : 'Connect'
                  })()}
                  {highlightedNodes.size > 2 && 'Connect (Too many selected)'}
                </span>
              </button>

              {/* Column Drag Mode Toggle */}
              <button
                onClick={() => setColumnDragMode(!columnDragMode)}
                className={`flex items-center gap-2 px-3 py-2 text-sm rounded-lg transition-colors ${
                  columnDragMode
                    ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
                    : 'text-gray-700 hover:bg-indigo-50 hover:text-indigo-600'
                }`}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span>Column Drag: {columnDragMode ? 'On' : 'Off'}</span>
              </button>

              {/* Copy JSON Button */}
              <button
                onClick={copyGraphJSON}
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-green-50 hover:text-green-600 rounded-lg transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
                <span>Copy JSON</span>
              </button>
            </div>
          </div>

          {/* Right side - Controls and Close */}
          <div className="flex items-center gap-6">
            {/* Curve Control */}
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-700">Curve:</label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Flat</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={curvature}
                  onChange={(e) => setCurvature(parseFloat(e.target.value))}
                  className="w-20 h-2 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-blue-200 to-indigo-400"
                />
                <span className="text-xs text-gray-500">Curved</span>
              </div>
            </div>

            {/* Text Size Control */}
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-700">Text Size:</label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">S</span>
                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={textSize}
                  onChange={(e) => setTextSize(parseFloat(e.target.value))}
                  className="w-20 h-2 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-gray-300 to-gray-600"
                />
                <span className="text-xs text-gray-500">L</span>
              </div>
            </div>

            {/* Node Width Control */}
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-700">Width:</label>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min="128"
                  max="320"
                  step="16"
                  value={nodeWidth}
                  onChange={(e) => {
                    const newWidth = parseInt(e.target.value)
                    setNodeWidth(newWidth)
                    // Auto-apply to selected nodes
                    if (highlightedNodes.size > 0) {
                      setData((prevData) => ({
                        ...prevData,
                        sections: prevData.sections.map((section) => ({
                          ...section,
                          columns: section.columns.map((column) => ({
                            ...column,
                            nodes: column.nodes.map((node) => {
                              if (highlightedNodes.has(node.id)) {
                                return { ...node, width: newWidth }
                              }
                              return node
                            })
                          }))
                        }))
                      }))
                    }
                  }}
                  className="w-20 h-2 rounded-lg appearance-none cursor-pointer bg-gradient-to-r from-orange-300 to-orange-600"
                />
                <span className="text-xs text-gray-500 w-10">{nodeWidth}px</span>
              </div>
            </div>

            {/* Node Color Control */}
            <div className="flex items-center gap-3">
              <label className="text-sm text-gray-700">Color:</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={nodeColor}
                  onChange={(e) => {
                    const newColor = e.target.value
                    setNodeColor(newColor)
                    // Auto-apply to selected nodes
                    if (highlightedNodes.size > 0) {
                      setData((prevData) => ({
                        ...prevData,
                        sections: prevData.sections.map((section) => ({
                          ...section,
                          columns: section.columns.map((column) => ({
                            ...column,
                            nodes: column.nodes.map((node) => {
                              if (highlightedNodes.has(node.id)) {
                                return { ...node, color: newColor }
                              }
                              return node
                            })
                          }))
                        }))
                      }))
                    }
                  }}
                  className="w-8 h-8 rounded border border-gray-300 cursor-pointer"
                  title="Node background color"
                />
                <button
                  onClick={() => {
                    setNodeColor('#ffffff')
                    // Auto-apply to selected nodes
                    if (highlightedNodes.size > 0) {
                      setData((prevData) => ({
                        ...prevData,
                        sections: prevData.sections.map((section) => ({
                          ...section,
                          columns: section.columns.map((column) => ({
                            ...column,
                            nodes: column.nodes.map((node) => {
                              if (highlightedNodes.has(node.id)) {
                                return { ...node, color: '#ffffff' }
                              }
                              return node
                            })
                          }))
                        }))
                      }))
                    }
                  }}
                  className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition-colors"
                  title="Reset to white"
                >
                  Reset
                </button>
              </div>
              {highlightedNodes.size > 0 && (
                <span className="text-xs text-gray-500">
                  ({highlightedNodes.size} selected)
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}