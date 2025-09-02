import React from 'react'
import { Node, ToCData } from '../types'

interface SearchInterfaceProps {
  showSearch: boolean
  setShowSearch: (show: boolean) => void
  searchQuery: string
  setSearchQuery: (query: string) => void
  data: ToCData
  nodeRefs: { [key: string]: HTMLDivElement | null }
  setHighlightedNodes: (nodes: Set<string>) => void
  setNodeWidth: (width: number) => void
  setNodeColor: (color: string) => void
}

export function SearchInterface({
  showSearch,
  setShowSearch,
  searchQuery,
  setSearchQuery,
  data,
  nodeRefs,
  setHighlightedNodes,
  setNodeWidth,
  setNodeColor
}: SearchInterfaceProps) {
  // Auto-select matching nodes when search query changes
  React.useEffect(() => {
    if (!searchQuery || !showSearch) {
      return
    }

    const matchingNodeIds = new Set<string>()
    data.sections.forEach((section) => {
      section.columns.forEach((column) => {
        column.nodes.forEach((node) => {
          const query = searchQuery.toLowerCase()
          if (node.title.toLowerCase().includes(query) || 
              node.text.toLowerCase().includes(query)) {
            matchingNodeIds.add(node.id)
          }
        })
      })
    })

    setHighlightedNodes(matchingNodeIds)
  }, [searchQuery, showSearch, data, setHighlightedNodes])

  if (!showSearch) return null

  return (
    <div className="fixed top-4 right-4 z-50">
      <div className="bg-white rounded-lg p-4 w-80 shadow-lg border border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-700">Search Nodes</h3>
          <button
            onClick={() => setShowSearch(false)}
            className="text-gray-400 hover:text-gray-600"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        
        <input
          type="text"
          placeholder="Search node titles and text..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          autoFocus
        />
        
        {searchQuery && (
          <div className="mt-3 text-xs text-gray-600">
            {(() => {
              const matchingCount = data.sections.reduce((count, section) => {
                return count + section.columns.reduce((colCount, column) => {
                  return colCount + column.nodes.filter((node) => {
                    const query = searchQuery.toLowerCase()
                    return node.title.toLowerCase().includes(query) || 
                           node.text.toLowerCase().includes(query)
                  }).length
                }, 0)
              }, 0)
              
              return `${matchingCount} node${matchingCount !== 1 ? 's' : ''} selected`
            })()}
          </div>
        )}
      </div>
    </div>
  )
}