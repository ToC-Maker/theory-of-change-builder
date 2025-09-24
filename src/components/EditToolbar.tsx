import React, { useState, useRef, useEffect } from "react"
import { ToCData, Node } from "../types"
import { ShareIcon, AdjustmentsHorizontalIcon } from "@heroicons/react/24/outline"

interface EditToolbarProps {
  editMode: boolean
  highlightedNodes: Set<string>
  setHighlightedNodes: React.Dispatch<React.SetStateAction<Set<string>>>
  layoutMode: boolean
  setLayoutMode: React.Dispatch<React.SetStateAction<boolean>>
  curvature: number
  setCurvature: React.Dispatch<React.SetStateAction<number>>
  textSize: number
  setTextSize: React.Dispatch<React.SetStateAction<number>>
  nodeWidth: number
  setNodeWidth: React.Dispatch<React.SetStateAction<number>>
  nodeColor: string
  setNodeColor: React.Dispatch<React.SetStateAction<string>>
  columnPadding: number
  setColumnPadding: React.Dispatch<React.SetStateAction<number>>
  sectionPadding: number
  setSectionPadding: React.Dispatch<React.SetStateAction<number>>
  straightenEdges: () => void
  setData: React.Dispatch<React.SetStateAction<ToCData>>
  // Header controls props
  undoHistory: ToCData[]
  redoHistory: ToCData[]
  handleUndo: () => void
  handleRedo: () => void
  setShowShareModal: React.Dispatch<React.SetStateAction<boolean>>
  isSaving: boolean
  currentEditToken: string | null
  lastSyncTime: Date | null
  isManualSyncing: boolean
  handleManualSync: () => void
  getTimeAgo: (date: Date) => string
  data: ToCData
  onDeleteNode?: (nodeId: string) => void
}

export function EditToolbar({
  editMode,
  highlightedNodes,
  setHighlightedNodes,
  layoutMode,
  setLayoutMode,
  curvature,
  setCurvature,
  textSize,
  setTextSize,
  nodeWidth,
  setNodeWidth,
  nodeColor,
  setNodeColor,
  columnPadding,
  setColumnPadding,
  sectionPadding,
  setSectionPadding,
  straightenEdges,
  setData,
  undoHistory,
  redoHistory,
  handleUndo,
  handleRedo,
  setShowShareModal,
  isSaving,
  currentEditToken,
  lastSyncTime,
  isManualSyncing,
  handleManualSync,
  getTimeAgo,
  data,
  onDeleteNode,
}: EditToolbarProps) {
  const [showWidthDropdown, setShowWidthDropdown] = useState(false)
  const [showAlignmentSuggestion, setShowAlignmentSuggestion] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Smart detection for misaligned nodes
  const detectMisalignedNodes = (): boolean => {
    if (!editMode) return false

    const allNodes: { node: Node; centerY: number }[] = []

    // Collect all nodes with their Y positions
    data.sections.forEach((section) => {
      section.columns.forEach((column) => {
        column.nodes.forEach((node) => {
          const centerY = node.yPosition ?? 0
          allNodes.push({ node, centerY })
        })
      })
    })

    if (allNodes.length < 2) return false

    // Group nodes by similar Y positions (within tolerance)
    const tolerance = 40 // Same as straightenEdges function
    const groups: typeof allNodes[] = []

    allNodes.forEach((nodeData) => {
      let addedToGroup = false
      for (const group of groups) {
        const avgCenterY = group.reduce((sum, n) => sum + n.centerY, 0) / group.length
        if (Math.abs(nodeData.centerY - avgCenterY) <= tolerance) {
          group.push(nodeData)
          addedToGroup = true
          break
        }
      }
      if (!addedToGroup) {
        groups.push([nodeData])
      }
    })

    // Find misaligned groups
    const misalignedGroups = groups.filter(group => {
      if (group.length < 2) return false
      const positions = group.map(n => n.centerY)
      const min = Math.min(...positions)
      const max = Math.max(...positions)
      return (max - min) > 0 // Any difference = misaligned
    })

    return misalignedGroups.length > 0
  }

  // Check for misalignment when data changes
  useEffect(() => {
    const hasMisaligned = detectMisalignedNodes()
    if (editMode && hasMisaligned) {
      setShowAlignmentSuggestion(true)
    } else {
      setShowAlignmentSuggestion(false)
    }
  }, [data, editMode])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowWidthDropdown(false)
      }
    }

    if (showWidthDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showWidthDropdown])

  if (!editMode) return null

  return (
    <>
      <div className="fixed top-0 left-0 right-0 z-50 bg-white border-b border-gray-300 shadow-sm">
        <div className="max-w-none mx-auto px-6 py-2" style={{ maxWidth: '120rem' }}>
        <div className="flex items-center justify-between relative">
          {/* Left side - Header controls and main tools */}
          <div className="flex items-center gap-6 flex-1">
            {/* Undo/Redo Group */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">({undoHistory.length})</span>
              <button
                onClick={handleUndo}
                disabled={undoHistory.length === 0}
                className="p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200"
                title="Undo (Ctrl+Z)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
              </button>
              <button
                onClick={handleRedo}
                disabled={redoHistory.length === 0}
                className="p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200"
                title="Redo (Ctrl+Y)"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 10H11a8 8 0 00-8 8v2m18-10l-6 6m6-6l-6-6" />
                </svg>
              </button>
              <span className="text-xs text-gray-500">({redoHistory.length})</span>
            </div>

            {/* Separator */}
            <div className="h-6 w-px bg-gray-300 mx-1"></div>

            {/* Edit Tools */}
            <div className="flex items-center">
              <button
                onClick={() => setLayoutMode(!layoutMode)}
                className={`p-2 rounded transition-all duration-200 ${
                  layoutMode
                    ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-800'
                }`}
                title={`Layout Mode: ${layoutMode ? 'On' : 'Off'}`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
                </svg>
              </button>

              {/* More Tools Dropdown */}
              <div className="relative" ref={dropdownRef}>
                <button
                  onClick={() => setShowWidthDropdown(!showWidthDropdown)}
                  className="p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded transition-all duration-200"
                  title="More formatting options"
                >
                  <AdjustmentsHorizontalIcon className="w-5 h-5" />
                </button>

                {/* Dropdown Menu */}
                {showWidthDropdown && (
                  <div className="absolute top-full mt-1 left-0 w-64 bg-white rounded-lg shadow-lg border border-gray-200 py-2 z-50">
                    <div className="px-4 py-3 border-b border-gray-100">
                      <h4 className="text-sm font-medium text-gray-700">Formatting Options</h4>
                    </div>

                    <div className="p-4 space-y-4">
                      {/* Spacing Controls */}
                      <div>
                        <label className="text-sm text-gray-600">Column Spacing</label>
                        <div className="flex items-center gap-2 mt-1">
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="4"
                            value={columnPadding}
                            onChange={(e) => setColumnPadding(parseInt(e.target.value))}
                            className="flex-1 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
                          />
                          <span className="text-xs text-gray-500 w-12">{columnPadding}px</span>
                        </div>
                      </div>

                      <div>
                        <label className="text-sm text-gray-600">Section Spacing</label>
                        <div className="flex items-center gap-2 mt-1">
                          <input
                            type="range"
                            min="0"
                            max="100"
                            step="4"
                            value={sectionPadding}
                            onChange={(e) => setSectionPadding(parseInt(e.target.value))}
                            className="flex-1 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
                          />
                          <span className="text-xs text-gray-500 w-12">{sectionPadding}px</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Center - Share Button */}
          <div className="absolute left-1/2 transform -translate-x-1/2 z-10">
            <button
              onClick={() => setShowShareModal(true)}
              className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition-all duration-200 flex items-center gap-2"
              title="Share"
            >
              <ShareIcon className="w-4 h-4" />
              Share
            </button>
          </div>

          {/* Right side - Visual Controls and Actions */}
          <div className="flex items-center gap-1 flex-1 justify-end">
            {/* Visual Controls */}
            <div className="flex items-center gap-1">
              {/* Curve Control */}
              <div className="flex items-center gap-2 px-2">
                <span className="text-sm text-gray-600">Curve</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={curvature}
                  onChange={(e) => setCurvature(parseFloat(e.target.value))}
                  className="w-16 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
                />
              </div>

              {/* Text Size Control */}
              <div className="flex items-center gap-2 px-2">
                <span className="text-sm text-gray-600">Size</span>
                <input
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={textSize}
                  onChange={(e) => setTextSize(parseFloat(e.target.value))}
                  className="w-16 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
                />
              </div>
            </div>

            {/* Separator */}
            <div className="h-6 w-px bg-gray-300 mx-2"></div>

            {/* Save Status */}
            <div className="flex items-center gap-2">
              {isSaving && (
                <div className="flex items-center gap-1 px-2 py-1 text-gray-600 text-sm">
                  <svg className="animate-spin w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span>Saving...</span>
                </div>
              )}
              {!isSaving && currentEditToken && (
                <div className="flex items-center gap-1 px-2 py-1 text-gray-600 text-sm">
                  <svg className="w-4 h-4 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span>Saved</span>
                </div>
              )}
              {currentEditToken && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleManualSync}
                    disabled={isManualSyncing}
                    className="p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200"
                    title="Sync with server"
                  >
                    <svg className={`w-5 h-5 ${isManualSyncing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                  {lastSyncTime && (
                    <span className="text-gray-600 text-sm">Last synced: {getTimeAgo(lastSyncTime)}</span>
                  )}
                </div>
              )}
            </div>

          </div>
        </div>
      </div>
      </div>

      {/* Smart Alignment Suggestion Popup */}
      {showAlignmentSuggestion && (
        <div
          className="absolute z-50 bg-white rounded-lg shadow-lg border border-gray-200 px-2 py-2 max-w-xs transition-all duration-300 ease-out"
          style={{
            right: '20px',
            bottom: '20px'
          }}
        >
            <div className="flex flex-col items-center text-center gap-3">
              <div className="flex items-center justify-center gap-3 w-full">
                {/* Misaligned nodes */}
                <svg className="w-12 h-12 text-blue-600" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
                  <rect x="2" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
                  <rect x="8" y="10" width="3" height="8" rx="1.5" opacity="0.7" />
                  <rect x="14" y="7" width="3" height="8" rx="1.5" opacity="0.7" />
                </svg>

                {/* Arrow */}
                <svg className="w-8 h-8 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h8m0 0l-3-3m3 3l-3 3" />
                </svg>

                {/* Aligned nodes */}
                <svg className="w-12 h-12 text-blue-600" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
                  <rect x="2" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
                  <rect x="8" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
                  <rect x="14" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
                </svg>
              </div>
              <div>
                <div className="text-sm font-medium text-gray-900 mb-1">
                  Clean up alignment?
                </div>
                <div className="text-xs text-gray-600 mb-3">
                  Some nodes are close but not perfectly aligned
                </div>
                <div className="flex gap-2 justify-center">
                  <button
                    onClick={() => {
                      straightenEdges()
                      setShowAlignmentSuggestion(false)
                    }}
                    className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700 transition-colors"
                  >
                    Align nodes
                  </button>
                  <button
                    onClick={() => setShowAlignmentSuggestion(false)}
                    className="px-3 py-1.5 text-gray-600 text-xs rounded hover:bg-gray-100 transition-colors"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
        </div>
      )}

      {/* Node Selection Popup - Miro Style Horizontal Bar */}
      {highlightedNodes.size > 0 && (() => {
        // Get actual positions of selected nodes from DOM with smooth updates
        const getNodePosition = () => {
          const nodeElements = Array.from(highlightedNodes).map(nodeId =>
            document.getElementById(`node-${nodeId}`)
          ).filter(Boolean);

          if (nodeElements.length === 0) {
            // Fallback to center if nodes not found
            return { x: window.innerWidth / 2, y: 200 };
          }

          // Calculate centroid of selected nodes (accounting for current transforms)
          const rects = nodeElements.map(el => {
            const rect = el.getBoundingClientRect();
            // Account for any transform scaling on hover
            const computedStyle = window.getComputedStyle(el);
            const transform = computedStyle.transform;
            return rect;
          });

          const avgX = rects.reduce((sum, rect) => sum + rect.left + rect.width / 2, 0) / rects.length;
          const topY = Math.min(...rects.map(rect => rect.top));

          return { x: avgX, y: topY - 80 }; // 80px above the topmost node
        };

        const nodePosition = getNodePosition();

        return (
          <div
            className="fixed z-[60] bg-white rounded-lg shadow-lg border border-gray-200 px-4 py-3 transition-all duration-300 ease-out"
            style={{
              left: nodePosition.x,
              top: nodePosition.y,
              transform: 'translateX(-50%)',
              minWidth: '400px'
            }}
          >
            <div className="flex items-center gap-6">
              {/* Node Count */}
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-700">
                  {highlightedNodes.size === 1 ? '1 node' : `${highlightedNodes.size} nodes`}
                </span>
              </div>

              {/* Separator */}
              <div className="h-4 w-px bg-gray-300"></div>

              {/* Width Control */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Width</span>
                <input
                  type="range"
                  min="128"
                  max="320"
                  step="16"
                  value={nodeWidth}
                  onChange={(e) => {
                    const newWidth = parseInt(e.target.value)
                    setNodeWidth(newWidth)
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
                  className="w-20 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
                />
                <span className="text-xs text-gray-500 w-10 text-right">{nodeWidth}px</span>
              </div>

              {/* Separator */}
              <div className="h-4 w-px bg-gray-300"></div>

              {/* Color Control */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Color</span>
                <input
                  type="color"
                  value={nodeColor}
                  onChange={(e) => {
                    const newColor = e.target.value
                    setNodeColor(newColor)
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
                />
                <button
                  onClick={() => {
                    setNodeColor('#ffffff')
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
                  className="text-xs text-gray-600 hover:text-gray-800 px-2 py-1 rounded hover:bg-gray-100 transition-colors"
                >
                  Reset
                </button>
              </div>

              {/* Delete Button - only in edit mode */}
              {editMode && onDeleteNode && (
                <>
                  {/* Separator */}
                  <div className="h-4 w-px bg-gray-300"></div>

                  <button
                    onClick={() => {
                      // Delete all selected nodes
                      highlightedNodes.forEach(nodeId => {
                        onDeleteNode(nodeId)
                      })
                      // Clear selection after deleting
                      setHighlightedNodes(new Set())
                    }}
                    className="p-2 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-all duration-200"
                    title={`Delete ${highlightedNodes.size === 1 ? 'node' : 'nodes'}`}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1-1v-1m4 0a1 1 0 011 1v1m-4-1v1m-1 0V4a1 1 0 00-1-1H9a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })()}
    </>
  )
}