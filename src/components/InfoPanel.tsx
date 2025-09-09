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
            
            <div className="space-y-4 text-sm text-gray-700">
              <div>
                <h4 className="font-medium text-gray-800 mb-2">Basic Navigation</h4>
                <ul className="space-y-1 text-xs">
                  <li>• <strong>Click nodes</strong> to select and view details</li>
                  <li>• <strong>Hover nodes</strong> to highlight connections</li>
                  <li>• <strong>Scroll</strong> to zoom in/out of the graph</li>
                  <li>• <strong>Click connections</strong> to view/edit relationship details</li>
                  <li>• <strong>Tab key</strong> to navigate between nodes</li>
                  <li>• <strong>Escape</strong> to clear selections</li>
                </ul>
              </div>
              
              <div>
                <h4 className="font-medium text-gray-800 mb-2">Node Selection</h4>
                <ul className="space-y-1 text-xs">
                  <li>• <strong>Single click:</strong> Select single node</li>
                  <li>• <strong>Ctrl+Click:</strong> Multi-select nodes</li>
                  <li>• <strong>Shift+Click:</strong> Select entire column</li>
                  <li>• <strong>Ctrl+A:</strong> Select all nodes (edit mode)</li>
                  <li>• <strong>Click empty space:</strong> Deselect all</li>
                </ul>
              </div>
              
              <div>
                <h4 className="font-medium text-gray-800 mb-2">Edit Mode Features</h4>
                <ul className="space-y-1 text-xs">
                  <li>• <strong>Toggle edit mode</strong> with the edit button</li>
                  <li>• <strong>Double-click empty space</strong> to create new nodes</li>
                  <li>• <strong>Drag nodes</strong> to reposition them</li>
                  <li>• <strong>Select 2 nodes</strong> to preview/create connections</li>
                  <li>• <strong>Delete key:</strong> Remove selected nodes</li>
                  <li>• <strong>Arrow keys:</strong> Fine-tune node positions</li>
                  <li>• <strong>Left/Right arrows:</strong> Move between columns</li>
                  <li>• <strong>Up/Down arrows:</strong> Adjust vertical position</li>
                </ul>
              </div>
              
              <div>
                <h4 className="font-medium text-gray-800 mb-2">Node Editing</h4>
                <ul className="space-y-1 text-xs">
                  <li>• <strong>Info button (ⓘ):</strong> Edit node title and details</li>
                  <li>• <strong>Width slider:</strong> Adjust selected node width</li>
                  <li>• <strong>Color picker:</strong> Change node background color</li>
                  <li>• <strong>Text size slider:</strong> Scale text throughout graph</li>
                </ul>
              </div>
              
              <div>
                <h4 className="font-medium text-gray-800 mb-2">Connections</h4>
                <ul className="space-y-1 text-xs">
                  <li>• <strong>Line styles</strong> indicate confidence levels</li>
                  <li>• <strong>Solid lines:</strong> High confidence (75-100%)</li>
                  <li>• <strong>Dashed lines:</strong> Medium confidence (25-75%)</li>
                  <li>• <strong>Dotted lines:</strong> Low confidence (0-25%)</li>
                  <li>• <strong>Click connections</strong> to edit confidence & evidence</li>
                </ul>
              </div>
              
              <div>
                <h4 className="font-medium text-gray-800 mb-2">Keyboard Shortcuts</h4>
                <ul className="space-y-1 text-xs">
                  <li>• <strong>Ctrl+Z:</strong> Undo last change</li>
                  <li>• <strong>Ctrl+Y:</strong> Redo last change</li>
                  <li>• <strong>Ctrl+F:</strong> Search nodes</li>
                  <li>• <strong>Tab/Shift+Tab:</strong> Navigate nodes</li>
                </ul>
              </div>
              
              <div>
                <h4 className="font-medium text-gray-800 mb-2">AI Assistant</h4>
                <ul className="space-y-1 text-xs">
                  <li>• <strong>Chat panel</strong> provides AI assistance</li>
                  <li>• <strong>Ask questions</strong> about your theory of change</li>
                  <li>• <strong>Request edits</strong> to nodes and connections</li>
                  <li>• <strong>Generate content</strong> for new sections</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}