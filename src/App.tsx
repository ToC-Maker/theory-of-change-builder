import { useState, useEffect, useCallback, useRef } from "react"
import { Routes, Route, useParams, Link } from "react-router-dom"
import { ToC } from "./stories/ToC"
import { ChatInterface } from "./components/ChatInterface"
import { InfoPanel } from "./components/InfoPanel"
import { StaticLegend } from "./components/StaticLegend"
import { JsonDropdown } from "./components/JsonDropdown"
import { ToCGeneratorModal } from "./components/ToCGeneratorModal"
import { ApiKeyProvider } from "./contexts/ApiKeyContext"
import "./App.css"

// Default empty template with 4 sections
const emptyTemplate: ToCData = {
  sections: [
    {
      title: "Inputs",
      columns: [
        {
          nodes: []
        }
      ]
    },
    {
      title: "Outputs", 
      columns: [
        {
          nodes: []
        }
      ]
    },
    {
      title: "Outcomes",
      columns: [
        {
          nodes: []
        }
      ]
    },
    {
      title: "Goal",
      columns: [
        {
          nodes: []
        }
      ]
    }
  ]
};

interface ToCData {
  sections: any[]
  textSize?: number
  curvature?: number
}

function ToCViewerOnly() {
  const { filename } = useParams<{ filename: string }>()
  const [data, setData] = useState<ToCData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })

  const loadFromLocalStorage = useCallback((currentFilename?: string): ToCData | null => {
    try {
      const storageKey = `toc_graph_${currentFilename || filename || 'default'}`;
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        console.log('Loaded from localStorage:', storageKey);
        return JSON.parse(saved);
      }
    } catch (error) {
      console.warn('Failed to load from localStorage:', error);
    }
    return null;
  }, [filename]);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      setError(null)
      
      try {
        // First, try to load from localStorage
        const savedData = loadFromLocalStorage(filename);
        if (savedData) {
          console.log('Using saved data from localStorage');
          setData(savedData);
          setLoading(false);
          return;
        }

        // If no saved data, load from file or default
        if (filename) {
          const response = await fetch(`/ToC-graphs/${filename}`)
          if (!response.ok) {
            throw new Error(`Failed to load ${filename}`)
          }
          const jsonData = await response.json()
          setData(jsonData)
        } else {
          // Default to empty template
          setData(emptyTemplate)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data')
        console.error('Error loading ToC data:', err)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [filename, loadFromLocalStorage])

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

  return (
    <div className="h-screen w-screen bg-gray-50 flex flex-col items-center justify-center py-4 px-4 overflow-auto fixed inset-0">
      {/* Only the Main Graph Container */}
      <div className="flex flex-col flex-shrink-0 items-center">
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
          <ToC data={data} onSizeChange={setContainerSize} onDataChange={() => {}} showEditButton={false} />
        </div>
      </div>
    </div>
  )
}

function ToCViewer() {
  const { filename } = useParams<{ filename: string }>()
  const [data, setData] = useState<ToCData | null>(null)
  const [undoHistory, setUndoHistory] = useState<ToCData[]>([])
  const [redoHistory, setRedoHistory] = useState<ToCData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false)
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false)
  const [showToCGenerator, setShowToCGenerator] = useState(false)

  // Debounced undo history to group rapid successive operations
  const undoTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const pendingUndoState = useRef<ToCData | null>(null)

  const saveToHistory = useCallback((currentData: ToCData) => {
    if (!currentData) return;

    // Store the state that should be saved to undo history
    if (!pendingUndoState.current) {
      pendingUndoState.current = JSON.parse(JSON.stringify(currentData));
    }

    // Clear existing timeout
    if (undoTimeoutRef.current) {
      clearTimeout(undoTimeoutRef.current);
    }

    // Set new timeout to save to history after a brief delay
    undoTimeoutRef.current = setTimeout(() => {
      if (pendingUndoState.current) {
        setUndoHistory(prev => [...prev, pendingUndoState.current!]);
        pendingUndoState.current = null;
      }
    }, 300); // 300ms delay to group rapid operations
  }, []);

  const saveToLocalStorage = useCallback((dataToSave: ToCData, currentFilename?: string) => {
    try {
      const storageKey = `toc_graph_${currentFilename || filename || 'default'}`;
      localStorage.setItem(storageKey, JSON.stringify(dataToSave));
      console.log('Saved to localStorage:', storageKey);
    } catch (error) {
      console.warn('Failed to save to localStorage:', error);
    }
  }, [filename]);

  const loadFromLocalStorage = useCallback((currentFilename?: string): ToCData | null => {
    try {
      const storageKey = `toc_graph_${currentFilename || filename || 'default'}`;
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        console.log('Loaded from localStorage:', storageKey);
        return JSON.parse(saved);
      }
    } catch (error) {
      console.warn('Failed to load from localStorage:', error);
    }
    return null;
  }, [filename]);

  const handleUploadJSON = useCallback((jsonData: any) => {
    // Validate that the uploaded data has the expected structure
    if (!jsonData || typeof jsonData !== 'object') {
      alert('Invalid JSON file: Data must be an object');
      return;
    }

    if (!jsonData.sections || !Array.isArray(jsonData.sections)) {
      alert('Invalid JSON file: Missing or invalid sections array');
      return;
    }

    console.log('Uploading JSON data:', jsonData);
    
    // Save current state to history before updating
    if (data) {
      saveToHistory(data);
    }
    
    // Clear redo history when new changes are made
    setRedoHistory([]);
    
    // Set the uploaded data
    setData(jsonData);
    saveToLocalStorage(jsonData);
    
    console.log('JSON data uploaded successfully');
  }, [data, saveToHistory, saveToLocalStorage]);

  const handleGraphUpdate = (newGraphData: ToCData) => {
    console.log('App handleGraphUpdate called with:', newGraphData);
    console.log('Current data before update:', data);
    
    // Save current state to history before updating
    if (data) {
      saveToHistory(data);
    }
    
    // Clear redo history when new changes are made
    setRedoHistory([]);
    
    setData(newGraphData);
    saveToLocalStorage(newGraphData);
    console.log('setData called with new graph data');
  };

  const handleDataChange = (newData: ToCData) => {
    console.log('App handleDataChange called with:', newData);
    
    // Save current state to history before updating
    if (data) {
      saveToHistory(data);
    }
    
    // Clear redo history when new changes are made
    setRedoHistory([]);
    
    setData(newData);
    saveToLocalStorage(newData);
  };

  const handleUndo = useCallback(() => {
    if (undoHistory.length > 0 && data) {
      const previousState = undoHistory[undoHistory.length - 1];
      const newUndoHistory = undoHistory.slice(0, -1);
      
      // Save current state to redo history
      setRedoHistory(prev => [...prev, JSON.parse(JSON.stringify(data))]);
      setUndoHistory(newUndoHistory);
      setData(previousState);
      saveToLocalStorage(previousState);
      
      console.log('Undo performed, undo history length:', newUndoHistory.length);
    }
  }, [undoHistory, data, saveToLocalStorage]);

  const handleRedo = useCallback(() => {
    if (redoHistory.length > 0 && data) {
      const nextState = redoHistory[redoHistory.length - 1];
      const newRedoHistory = redoHistory.slice(0, -1);
      
      // Save current state to undo history
      setUndoHistory(prev => [...prev, JSON.parse(JSON.stringify(data))]);
      setRedoHistory(newRedoHistory);
      setData(nextState);
      saveToLocalStorage(nextState);
      
      console.log('Redo performed, redo history length:', newRedoHistory.length);
    }
  }, [redoHistory, data, saveToLocalStorage]);

  // Keyboard shortcut handler
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if user is typing in an input field
      const activeElement = document.activeElement;
      const isTyping = activeElement && (
        activeElement.tagName === 'INPUT' || 
        activeElement.tagName === 'TEXTAREA' ||
        (activeElement as HTMLElement).contentEditable === 'true'
      );

      // Don't interfere with text editing
      if (isTyping) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
        event.preventDefault();
        handleUndo();
      } else if (
        ((event.ctrlKey || event.metaKey) && event.key === 'z' && event.shiftKey) ||
        ((event.ctrlKey || event.metaKey) && event.key === 'y')
      ) {
        event.preventDefault();
        handleRedo();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleUndo, handleRedo]); // Re-run when handlers change

  const copyGraphJSON = useCallback(async () => {
    if (!data) return;
    
    try {
      const graphData = {
        ...data,
        // Include additional UI state in metadata
        _metadata: {
          exportedAt: new Date().toISOString(),
        }
      }
      await navigator.clipboard.writeText(JSON.stringify(graphData, null, 2))
      // Could add a toast notification here if desired
    } catch (err) {
      console.error('Failed to copy JSON:', err)
    }
  }, [data])

  const resetToOriginal = useCallback(async () => {
    if (!confirm('This will reset your graph to the original version and delete all saved progress. Are you sure?')) {
      return;
    }

    try {
      setLoading(true);
      
      // Clear localStorage for this file
      const storageKey = `toc_graph_${filename || 'default'}`;
      localStorage.removeItem(storageKey);
      console.log('Cleared localStorage:', storageKey);
      
      // Clear undo/redo history
      setUndoHistory([]);
      setRedoHistory([]);
      
      // Load original data
      if (filename) {
        const response = await fetch(`/ToC-graphs/${filename}`)
        if (!response.ok) {
          throw new Error(`Failed to load ${filename}`)
        }
        const jsonData = await response.json()
        setData(jsonData)
      } else {
        // Default to empty template
        setData(emptyTemplate)
      }
      
      console.log('Reset to original data');
    } catch (err) {
      console.error('Error resetting to original:', err);
      setError(err instanceof Error ? err.message : 'Failed to reset to original');
    } finally {
      setLoading(false);
    }
  }, [filename]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (undoTimeoutRef.current) {
        clearTimeout(undoTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      setError(null)
      
      try {
        // First, try to load from localStorage
        const savedData = loadFromLocalStorage(filename);
        if (savedData) {
          console.log('Using saved data from localStorage');
          setData(savedData);
          setLoading(false);
          return;
        }

        // If no saved data, load from file or default
        if (filename) {
          const response = await fetch(`/ToC-graphs/${filename}`)
          if (!response.ok) {
            throw new Error(`Failed to load ${filename}`)
          }
          const jsonData = await response.json()
          setData(jsonData)
          // Save the loaded file data to localStorage for future use
          saveToLocalStorage(jsonData, filename)
        } else {
          // Default to empty template
          setData(emptyTemplate)
          saveToLocalStorage(emptyTemplate)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load data')
        console.error('Error loading ToC data:', err)
      } finally {
        setLoading(false)
      }
    }

    loadData()
  }, [filename, loadFromLocalStorage, saveToLocalStorage])

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
        <div className="flex gap-2">
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
          <button
            onClick={handleRedo}
            disabled={redoHistory.length === 0}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            title="Redo last undone change (Ctrl+Y or Ctrl+Shift+Z)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 10H11a8 8 0 00-8 8v2m18-10l-6 6m6-6l-6-6" />
            </svg>
            Redo ({redoHistory.length})
          </button>
        </div>
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
            onShowToCGenerator={() => setShowToCGenerator(true)}
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
            <JsonDropdown 
              data={data} 
              title="Current Graph JSON" 
              copyGraphJSON={copyGraphJSON}
              resetToOriginal={resetToOriginal}
              onUploadJSON={handleUploadJSON}
              loading={loading}
            />
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
      
      {/* ToC Generator Modal */}
      <ToCGeneratorModal
        isOpen={showToCGenerator}
        onClose={() => setShowToCGenerator(false)}
        onGraphGenerated={handleGraphUpdate}
      />
    </div>
  )
}

function App() {
  return (
    <ApiKeyProvider>
      <Routes>
        <Route path="/" element={<ToCViewer />} />
        <Route path="/:filename" element={<ToCViewer />} />
        <Route path="/:filename/view" element={<ToCViewerOnly />} />
        <Route path="/view" element={<ToCViewerOnly />} />
      </Routes>
    </ApiKeyProvider>
  )
}

export default App
