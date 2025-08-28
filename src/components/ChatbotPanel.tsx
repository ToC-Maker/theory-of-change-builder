import React from "react"

interface ChatbotPanelProps {
  height?: number
  isCollapsed: boolean
  onToggle: () => void
}

export function ChatbotPanel({ height, isCollapsed, onToggle }: ChatbotPanelProps) {
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
          title={isCollapsed ? "Expand Chatbot Panel" : "Collapse Chatbot Panel"}
        >
{!isCollapsed && <span className="mr-2 text-sm font-medium">AI Assistant</span>}
          <svg 
            className={`w-4 h-4 transition-transform duration-300 ${isCollapsed ? '' : 'rotate-180'}`}
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Panel Content */}
      <div className={`flex-1 overflow-hidden transition-all duration-300 ${isCollapsed ? 'opacity-0' : 'opacity-100'}`}>
        <div className="p-4 h-full flex flex-col">
          <h3 className="text-lg font-semibold text-gray-800 mb-4">AI Assistant</h3>
          
          <div className="flex-1 flex flex-col space-y-4">
            <div className="bg-gray-50 rounded-lg p-4 text-center">
              <div className="text-gray-400 mb-2">
                <svg className="w-8 h-8 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.418 8-9 8a9.013 9.013 0 01-5.314-1.707l-3.414 1.414a1 1 0 01-1.414-1.414l1.414-3.414A9.013 9.013 0 013 12c0-4.97 4.03-9 9-9s9 4.03 9 9z" />
                </svg>
              </div>
              <p className="text-sm text-gray-600 mb-3">
                Chat with AI about your Theory of Change
              </p>
              <p className="text-xs text-gray-500">
                Coming soon...
              </p>
            </div>
            
            <div className="text-xs text-gray-500 flex-1">
              <p className="mb-2">Future features:</p>
              <ul className="space-y-1">
                <li>• Ask questions about connections</li>
                <li>• Get suggestions for improvements</li>
                <li>• Generate new nodes and pathways</li>
                <li>• Export insights and reports</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}