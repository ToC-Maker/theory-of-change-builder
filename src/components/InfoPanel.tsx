import React from "react"

interface InfoPanelProps {
  legendComponent: React.ReactNode
  height?: number
  isCollapsed: boolean
  onToggle: () => void
}

export function InfoPanel({ legendComponent, height, isCollapsed, onToggle }: InfoPanelProps) {
  return (
    <div 
      className={`bg-white rounded-lg shadow-lg border border-gray-200 flex flex-col transition-all duration-300 ${
        isCollapsed ? 'w-12' : 'w-80'
      }`}
      style={{ 
        height: height ? `${height}px` : 'fit-content',
        minHeight: height ? `${height}px` : 'auto'
      }}
    >
      {/* Toggle Button */}
      <div className="flex-shrink-0 p-2 border-b border-gray-200">
        <button
          onClick={onToggle}
          className="w-full h-8 flex items-center justify-center text-gray-600 hover:text-gray-800 hover:bg-gray-50 rounded transition-colors"
          title={isCollapsed ? "Expand Info Panel" : "Collapse Info Panel"}
        >
          <svg 
            className={`w-4 h-4 transition-transform duration-300 ${isCollapsed ? 'rotate-180' : ''}`}
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          {!isCollapsed && <span className="ml-2 text-sm font-medium">Info & Legend</span>}
        </button>
      </div>

      {/* Panel Content */}
      <div className={`flex-1 overflow-hidden transition-all duration-300 ${isCollapsed ? 'opacity-0' : 'opacity-100'}`}>
        <div className="p-4 h-full flex flex-col">
          <div className="mb-4 pb-4 border-b border-gray-200">
            <h4 className="font-medium text-gray-800 mb-3">Legend</h4>
            <div className="bg-gray-50 rounded-lg p-3">
              {legendComponent}
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto">
            <h3 className="text-lg font-semibold text-gray-800 mb-4">How to Use</h3>
            
            <div className="space-y-3 text-sm text-gray-700">
              <div>
                <h4 className="font-medium text-gray-800 mb-1">Navigation</h4>
                <ul className="space-y-1 text-xs">
                  <li>• Click nodes to view details</li>
                  <li>• Hover over nodes to see connections</li>
                  <li>• Scroll to zoom in/out of the graph</li>
                </ul>
              </div>
              
              <div>
                <h4 className="font-medium text-gray-800 mb-1">Edit Mode</h4>
                <ul className="space-y-1 text-xs">
                  <li>• Click the edit button to enable editing</li>
                  <li>• Drag nodes to reposition them</li>
                  <li>• Select nodes to connect/disconnect</li>
                  <li>• Use arrow keys to fine-tune positions</li>
                </ul>
              </div>
              
              <div>
                <h4 className="font-medium text-gray-800 mb-1">Selection</h4>
                <ul className="space-y-1 text-xs">
                  <li>• Click: Select single node</li>
                  <li>• Ctrl+Click: Multi-select nodes</li>
                  <li>• Shift+Click: Select entire column</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}