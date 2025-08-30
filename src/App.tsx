import { useState, useEffect, useCallback } from "react"
import { Routes, Route, useParams, Link } from "react-router-dom"
import { ToC } from "./stories/ToC"
import { CharityEntrepreneurship } from "./stories/ToC.stories"
import { ChatInterface } from "./components/ChatInterface"
import { InfoPanel } from "./components/InfoPanel"
import { StaticLegend } from "./components/StaticLegend"
import { JsonDropdown } from "./components/JsonDropdown"
import "./App.css"

interface ToCData {
  sections: any[]
  textSize?: number
  curvature?: number
}

function ToCViewer() {
  const { filename } = useParams<{ filename: string }>()
  const [data, setData] = useState<ToCData | null>(null)
  const [undoHistory, setUndoHistory] = useState<ToCData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false)
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false)

  const saveToHistory = (currentData: ToCData) => {
    if (currentData) {
      setUndoHistory(prev => [...prev, JSON.parse(JSON.stringify(currentData))]);
    }
  };

  const handleGraphUpdate = (newGraphData: ToCData) => {
    console.log('App handleGraphUpdate called with:', newGraphData);
    console.log('Current data before update:', data);
    
    // Save current state to history before updating
    if (data) {
      saveToHistory(data);
    }
    
    setData(newGraphData);
    console.log('setData called with new graph data');
  };

  const handleDataChange = (newData: ToCData) => {
    console.log('App handleDataChange called with:', newData);
    
    // Save current state to history before updating
    if (data) {
      saveToHistory(data);
    }
    
    setData(newData);
  };

  const handleUndo = useCallback(() => {
    if (undoHistory.length > 0) {
      const previousState = undoHistory[undoHistory.length - 1];
      const newHistory = undoHistory.slice(0, -1);
      
      setUndoHistory(newHistory);
      setData(previousState);
      
      console.log('Undo performed, history length:', newHistory.length);
    }
  }, [undoHistory]);

  // Keyboard shortcut handler
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        handleUndo();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleUndo]); // Re-run when handleUndo changes

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      setError(null)
      
      try {
        if (filename) {
          const response = await fetch(`/ToC-graphs/${filename}`)
          if (!response.ok) {
            throw new Error(`Failed to load ${filename}`)
          }
          const jsonData = await response.json()
          setData(jsonData)
        } else {
          // Default to Charity Entrepreneurship
          setData(CharityEntrepreneurship.args.data)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data')
        console.error('Error loading ToC data:', err)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [filename])

  if (loading) {
    return (
      <div className="h-screen w-screen bg-gray-50 flex items-center justify-center">
        <div className="text-xl text-gray-600">Loading Theory of Change...</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-screen w-screen bg-gray-50 flex flex-col items-center justify-center">
        <div className="text-xl text-red-600 mb-4">Error: {error}</div>
        <Link to="/" className="text-blue-600 hover:underline">
          Return to Home
        </Link>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="h-screen w-screen bg-gray-50 flex items-center justify-center">
        <div className="text-xl text-gray-600">No data available</div>
      </div>
    )
  }

  const title = filename 
    ? filename.replace('.json', '').replace(/([A-Z])/g, ' $1').trim()
    : 'Charity Entrepreneurship'

  return (
    <div className="h-screen w-screen bg-gray-50 flex flex-col items-center justify-start py-4 px-4 overflow-auto fixed inset-0">
      <div className="flex items-center gap-4 mb-4 flex-shrink-0">
        <h1 className="text-3xl font-bold text-center text-gray-800">
          Theory of Change: {title}
        </h1>
        <button
          onClick={handleUndo}
          disabled={undoHistory.length === 0}
          className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Undo last change (Ctrl+Z)"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
          Undo ({undoHistory.length})
        </button>
      </div>
      
      <div className="flex flex-1 gap-6 justify-center items-start">
        {/* Left Side Panel - AI Assistant */}
        <div className="flex-shrink-0">
          <ChatInterface 
            height={containerSize.height > 0 ? containerSize.height + 32 : undefined}
            isCollapsed={isLeftPanelCollapsed}
            onToggle={() => setIsLeftPanelCollapsed(!isLeftPanelCollapsed)}
            graphData={data}
            onGraphUpdate={handleGraphUpdate}
          />
        </div>
        
        {/* Main Graph Container and JSON Dropdown */}
        <div className="flex flex-col flex-shrink-0 items-start">
          <div 
            className="bg-white rounded-xl shadow-lg p-4"
            style={{
              width: containerSize.width > 0 ? `${containerSize.width + 32}px` : 'auto',
              height: containerSize.height > 0 ? `${containerSize.height + 32}px` : 'auto',
              minWidth: containerSize.width > 0 ? `${containerSize.width + 32}px` : 'auto',
              minHeight: containerSize.height > 0 ? `${containerSize.height + 32}px` : 'auto',
              maxWidth: containerSize.width > 0 ? `${containerSize.width + 32}px` : 'none',
              maxHeight: containerSize.height > 0 ? `${containerSize.height}px` : 'none'
            }}
          >
            <ToC data={data} onSizeChange={setContainerSize} onDataChange={handleDataChange} />
          </div>
          
          {/* JSON Dropdown below graph */}
          <div 
            style={{
              width: containerSize.width > 0 ? `${containerSize.width + 32}px` : 'auto'
            }}
          >
            <JsonDropdown data={data} title="Current Graph JSON" />
          </div>
        </div>
        
        {/* Right Side Panel - Info and Legend */}
        <div className="flex-shrink-0">
          <InfoPanel 
            legendComponent={<StaticLegend />} 
            height={containerSize.height > 0 ? containerSize.height + 32 : undefined}
            isCollapsed={isRightPanelCollapsed}
            onToggle={() => setIsRightPanelCollapsed(!isRightPanelCollapsed)}
          />
        </div>
      </div>
    </div>
  )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<ToCViewer />} />
      <Route path="/:filename" element={<ToCViewer />} />
    </Routes>
  )
}

export default App
