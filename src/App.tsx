import { useState, useEffect, useCallback, useRef } from "react"
import { Routes, Route, useParams, useLocation, Link } from "react-router-dom"
import { ToC } from "./components/TheoryOfChangeGraph"
import { ChatInterface } from "./components/ChatInterface"
import { JsonDropdown } from "./components/JsonDropdown"
import { ShareModal } from "./components/ShareModal"
import { GraphTutorial } from "./components/GraphTutorial"
import { PrivacyPolicyPopup } from "./components/PrivacyPolicyPopup"
import { ApiKeyProvider } from "./contexts/ApiKeyContext"
import { ChartService } from "./services/chartService"
import { PlusIcon, MinusIcon, ArrowsPointingOutIcon, DocumentDuplicateIcon } from "@heroicons/react/24/outline"
import "./App.css"

// Default empty template with 4 sections
const emptyTemplate: ToCData = {
  title: "Theory of Change",
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
    },
    {
      title: "Impact",
      columns: [
        {
          nodes: []
        }
      ]
    }
  ],
  "columnPadding": 48,
  "sectionPadding": 48,
  "color": "#2F2D2E",
  "textSize": 1,
  "curvature": 0.5

};

interface ToCData {
  sections: any[]
  textSize?: number
  curvature?: number
  columnPadding?: number
  sectionPadding?: number
}

// Constants
const EMBED_PADDING = 32; // 16px on each side
const MIN_SCALE = 0.1;
const MAX_SCALE = 5;

function ToCViewerOnly() {
  const { filename, chartId } = useParams<{ filename?: string; chartId?: string }>()
  const location = useLocation()
  const [data, setData] = useState<ToCData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [isCopying, setIsCopying] = useState(false)
  const [isInIframe, setIsInIframe] = useState(false)

  // Auto-scale state for view mode
  const [viewScale, setViewScale] = useState(1.0)

  // Detect if running in iframe
  useEffect(() => {
    setIsInIframe(window.self !== window.top)
  }, [])

  // Set body/html to fill viewport for clean view
  useEffect(() => {
    // Make body/html fill the viewport (100%)
    document.documentElement.style.margin = '0'
    document.documentElement.style.padding = '0'
    document.documentElement.style.height = '100%'
    document.documentElement.style.width = '100%'
    document.body.style.margin = '0'
    document.body.style.padding = '0'
    document.body.style.height = '100%'
    document.body.style.width = '100%'
    document.body.style.overflow = 'hidden'

    const root = document.getElementById('root')
    if (root) {
      root.style.margin = '0'
      root.style.padding = '0'
      root.style.height = '100%'
      root.style.width = '100%'
    }

    return () => {
      // Restore defaults when component unmounts
      document.documentElement.style.margin = ''
      document.documentElement.style.padding = ''
      document.documentElement.style.height = ''
      document.documentElement.style.width = ''
      document.body.style.margin = ''
      document.body.style.padding = ''
      document.body.style.overflow = ''
      document.body.style.height = ''
      document.body.style.width = ''

      const root = document.getElementById('root')
      if (root) {
        root.style.margin = ''
        root.style.padding = ''
        root.style.height = ''
        root.style.width = ''
      }
    }
  }, [])

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

  const handleMakeCopy = async () => {
    if (!data || isCopying) return;

    setIsCopying(true);
    try {
      // Create a copy of the data with modified title
      const copiedData = {
        ...data,
        title: data.title ? `Copy of ${data.title}` : 'Copy of Theory of Change'
      };

      const response = await ChartService.createChart(copiedData);
      // Save the edit token to localStorage
      ChartService.saveEditToken(response.chartId, response.editToken);
      // Redirect to the new edit URL
      window.location.href = response.editUrl;
    } catch (err) {
      console.error('Failed to create copy:', err);
      alert('Failed to create a copy. Please try again.');
      setIsCopying(false);
    }
  };

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      setError(null)

      try {
        if (chartId) {
          // Load from database using chartId
          console.log('Loading chart from database:', chartId);
          const chartData = await ChartService.getChart(chartId);
          setData(chartData);
        } else if (filename) {
          // Fallback to file-based loading for backwards compatibility
          const savedData = loadFromLocalStorage(filename);
          if (savedData) {
            console.log('Using saved data from localStorage');
            setData(savedData);
            return;
          }

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
  }, [filename, chartId, loadFromLocalStorage])

  // Auto-calculate scale based on viewport dimensions to fit content perfectly
  useEffect(() => {
    if (!containerSize.width || !containerSize.height) return;

    const calculateScale = () => {
      const contentWidth = containerSize.width + EMBED_PADDING;
      const contentHeight = containerSize.height + EMBED_PADDING;

      const scaleX = window.innerWidth / contentWidth;
      const scaleY = window.innerHeight / contentHeight;
      const calculatedScale = Math.max(MIN_SCALE, Math.min(scaleX, scaleY));

      setViewScale(calculatedScale);
    };

    calculateScale();

    // Debounced resize handler
    let resizeTimeout: NodeJS.Timeout;
    const handleResize = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(calculateScale, 100);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(resizeTimeout);
    };
  }, [containerSize.width, containerSize.height]);


  // Smart periodic sync with idle detection
  useEffect(() => {
    if (!chartId) return;

    let interval: NodeJS.Timeout;
    let isTabVisible = true;
    let lastActivity = Date.now();
    let syncInterval = 10000; // Start with 10 seconds
    let consecutiveUnchanged = 0;
    let lastDataString = JSON.stringify(data);

    const syncData = async () => {
      // Don't sync if tab is hidden or user is idle
      if (!isTabVisible || Date.now() - lastActivity > 300000) { // 5 min idle timeout
        console.log('Skipping sync - tab hidden or user idle');
        return;
      }

      try {
        console.log(`Syncing chart (interval: ${syncInterval}ms)`);
        const chartData = await ChartService.getChart(chartId);
        const newDataString = JSON.stringify(chartData);

        // Check if data changed
        if (newDataString !== lastDataString) {
          setData(chartData);
          lastDataString = newDataString;
          consecutiveUnchanged = 0;
          syncInterval = 10000; // Reset to 10 seconds
          console.log('Data changed, resetting to 10s interval');
        } else {
          consecutiveUnchanged++;
          // Exponential backoff: 10s -> 15s -> 22s -> 33s -> 50s -> 60s max
          if (consecutiveUnchanged > 2) {
            const newInterval = Math.min(Math.floor(syncInterval * 1.5), 60000);
            if (newInterval !== syncInterval) {
              syncInterval = newInterval;
              console.log(`No changes for ${consecutiveUnchanged} syncs, interval now ${syncInterval}ms`);
            }
          }
        }
      } catch (err) {
        console.error('Error syncing chart data:', err);
      }
    };

    // Handle visibility change
    const handleVisibilityChange = () => {
      isTabVisible = !document.hidden;
      if (isTabVisible) {
        console.log('Tab became visible, syncing immediately');
        syncData(); // Sync immediately when tab becomes visible
        lastActivity = Date.now();
      }
    };

    // Handle user activity
    const handleActivity = () => {
      const timeSinceLastActivity = Date.now() - lastActivity;
      lastActivity = Date.now();

      // If user was idle and becomes active, sync immediately
      if (timeSinceLastActivity > 300000) {
        console.log('User became active after being idle, syncing');
        syncData();
      }
    };

    // Listen for events
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('mousemove', handleActivity);
    document.addEventListener('keydown', handleActivity);
    document.addEventListener('click', handleActivity);
    document.addEventListener('scroll', handleActivity);

    // Initial sync after a short delay
    const initialTimer = setTimeout(syncData, 1000);

    // Dynamic interval
    const runSync = () => {
      syncData();
      clearInterval(interval);
      if (syncInterval < 60000 || consecutiveUnchanged < 10) {
        interval = setInterval(runSync, syncInterval);
      }
    };
    interval = setInterval(runSync, syncInterval);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('mousemove', handleActivity);
      document.removeEventListener('keydown', handleActivity);
      document.removeEventListener('click', handleActivity);
      document.removeEventListener('scroll', handleActivity);
    };
  }, [chartId]) // Remove data dependency to avoid recreation

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

  // Clean view mode - minimal chrome, pixel-perfect fit
  const contentWidth = containerSize.width + EMBED_PADDING;
  const contentHeight = containerSize.height + EMBED_PADDING;
  const scaledWidth = contentWidth * viewScale;
  const scaledHeight = contentHeight * viewScale;
  const offsetX = (window.innerWidth - scaledWidth) / 2;
  const offsetY = (window.innerHeight - scaledHeight) / 2;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        margin: 0,
        padding: 0,
        background: 'transparent',
        overflow: 'visible',
        position: 'relative'
      }}
    >
      {/* Make a Copy button - top right (hidden in iframes) */}
      {!isInIframe && (
        <button
          onClick={handleMakeCopy}
          disabled={isCopying}
          className="fixed top-4 right-4 z-50 bg-white hover:bg-gray-50 text-gray-700 font-medium px-4 py-2 rounded-lg shadow-lg border border-gray-200 transition-all hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          title="Create an editable copy of this graph"
        >
          <DocumentDuplicateIcon className={`w-4 h-4 ${isCopying ? 'animate-pulse' : ''}`} />
          {isCopying ? 'Copying...' : 'Make a Copy'}
        </button>
      )}

      <div
        style={{
          position: 'absolute',
          left: `${offsetX}px`,
          top: `${offsetY}px`,
          transformOrigin: 'top left',
          transform: viewScale !== 1 ? `scale(${viewScale})` : undefined,
          width: `${contentWidth}px`,
          height: `${contentHeight}px`
        }}
      >
        <div style={{ background: 'transparent', padding: '16px' }}>
          <ToC data={data} onSizeChange={setContainerSize} onDataChange={() => {}} showEditButton={false} />
        </div>
      </div>
      <GraphTutorial />
    </div>
  )
}

function ToCViewer() {
  const { filename, editToken } = useParams<{ filename?: string; editToken?: string }>()
  const [data, setData] = useState<ToCData | null>(null)
  const [undoHistory, setUndoHistory] = useState<ToCData[]>([])
  const [redoHistory, setRedoHistory] = useState<ToCData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [currentEditToken, setCurrentEditToken] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)
  const [isManualSyncing, setIsManualSyncing] = useState(false)
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set())
  const [camera, setCamera] = useState({ x: 0, y: 0, z: 1 })
  const zoomableRef = useRef<HTMLDivElement>(null)
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState<{ x: number; y: number } | null>(null)
  const [panStartCamera, setPanStartCamera] = useState<{ x: number; y: number } | null>(null)
  const hasInitializedZoom = useRef(false)

  // Helper function to format relative time
  const getTimeAgo = (date: Date) => {
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 10) {
      return 'less than 10 seconds ago';
    }

    if (diffInSeconds < 60) {
      return 'less than 1 minute ago';
    }

    const diffInMinutes = Math.floor(diffInSeconds / 60);
    if (diffInMinutes < 60) {
      return `${diffInMinutes} minute${diffInMinutes !== 1 ? 's' : ''} ago`;
    }

    const diffInHours = Math.floor(diffInMinutes / 60);
    if (diffInHours < 24) {
      return `${diffInHours} hour${diffInHours !== 1 ? 's' : ''} ago`;
    }

    const diffInDays = Math.floor(diffInHours / 24);
    return `${diffInDays} day${diffInDays !== 1 ? 's' : ''} ago`;
  };

  // Manual sync function
  const handleManualSync = async () => {
    if (!currentEditToken || isManualSyncing) return;

    setIsManualSyncing(true);
    try {
      console.log('Manual sync triggered');
      const result = await ChartService.getChartByEditToken(currentEditToken);
      const newDataStr = JSON.stringify(result.chartData);
      const currentDataStr = JSON.stringify(data);

      if (newDataStr !== currentDataStr) {
        setData(result.chartData);
        console.log('Chart data updated from manual sync');
      }
      setLastSyncTime(new Date());
    } catch (err) {
      console.error('Manual sync failed:', err);
    } finally {
      setIsManualSyncing(false);
    }
  };

  // Debounced undo history to group rapid successive operations
  const undoTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  const saveToHistory = useCallback((currentData: ToCData) => {
    if (!currentData) return;

    // Deep clone the data to avoid reference issues
    const clonedData = JSON.parse(JSON.stringify(currentData));

    // Clear existing timeout
    if (undoTimeoutRef.current) {
      clearTimeout(undoTimeoutRef.current);
    }

    // Set new timeout to save to history after a brief delay
    undoTimeoutRef.current = setTimeout(() => {
      setUndoHistory(prev => [...prev, clonedData]);
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
    pendingChangesRef.current = jsonData;
    saveToLocalStorage(jsonData);

    // Trigger debounced database save for JSON upload
    if (currentEditToken) {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      setIsSaving(true);
      saveTimeoutRef.current = setTimeout(() => {
        if (pendingChangesRef.current && currentEditToken) {
          console.log('Saving uploaded JSON to database');
          ChartService.updateChart(currentEditToken, pendingChangesRef.current)
            .then(() => {
              pendingChangesRef.current = null;
              setIsSaving(false);
            })
            .catch(err => {
              console.error('Failed to save uploaded JSON to database:', err);
              setIsSaving(false);
            });
        } else {
          setIsSaving(false);
        }
        saveTimeoutRef.current = null;
      }, 300);
    }

    console.log('JSON data uploaded successfully');
  }, [data, saveToHistory, saveToLocalStorage, currentEditToken]);

  const handleGraphUpdate = (newGraphData: ToCData) => {
    console.log('App handleGraphUpdate called - delegating to handleUploadJSON');
    console.log('Current data before update:', data);
    console.log('New data to update:', newGraphData);
    // Simply delegate to handleUploadJSON which has the proper logic
    handleUploadJSON(newGraphData);
    console.log('Data after handleUploadJSON call:', data);
  };

  // Debounced save to database
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingChangesRef = useRef<ToCData | null>(null);

  const handleDataChange = (newData: ToCData) => {
    console.log('App handleDataChange called');

    // Save current state to history before updating
    if (data) {
      saveToHistory(data);
    }

    // Clear redo history when new changes are made
    setRedoHistory([]);

    setData(newData);
    pendingChangesRef.current = newData;

    // Always save to localStorage immediately (local backup)
    if (!currentEditToken) {
      saveToLocalStorage(newData);
      return;
    }

    // Debounce database saves
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      console.log('Debouncing - delaying save...');
    }

    // Show saving indicator
    setIsSaving(true);

    // Save to database after 300ms of no changes
    saveTimeoutRef.current = setTimeout(() => {
      if (pendingChangesRef.current && currentEditToken) {
        console.log('Saving to database after debounce period');
        ChartService.updateChart(currentEditToken, pendingChangesRef.current)
          .then(() => {
            console.log('Database save successful');
            pendingChangesRef.current = null;
            setIsSaving(false);
          })
          .catch(err => {
            console.error('Failed to save to database:', err);
            // Fallback to localStorage if database fails
            if (pendingChangesRef.current) {
              saveToLocalStorage(pendingChangesRef.current);
            }
            setIsSaving(false);
          });
      } else {
        setIsSaving(false);
      }
      saveTimeoutRef.current = null;
    }, 300); // 300ms debounce
  };

  const handleUndo = useCallback(() => {
    // Clear any pending saves first
    if (undoTimeoutRef.current) {
      clearTimeout(undoTimeoutRef.current);
      undoTimeoutRef.current = null;
    }

    if (undoHistory.length > 0 && data) {
      const previousState = undoHistory[undoHistory.length - 1];
      const newUndoHistory = undoHistory.slice(0, -1);

      // Validate the previous state has required structure
      if (!previousState || !previousState.sections || !Array.isArray(previousState.sections)) {
        console.error('Invalid undo state detected:', previousState);
        return;
      }

      // Save current state to redo history
      setRedoHistory(prev => [...prev, JSON.parse(JSON.stringify(data))]);
      setUndoHistory(newUndoHistory);

      // Use handleDataChange to trigger debounced save, but skip history management
      const skipHistory = true;
      setData(previousState);
      pendingChangesRef.current = previousState;
      saveToLocalStorage(previousState);

      // Trigger debounced database save for undo
      if (currentEditToken) {
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
        }
        setIsSaving(true);
        saveTimeoutRef.current = setTimeout(() => {
          if (pendingChangesRef.current && currentEditToken) {
            console.log('Saving undo state to database');
            ChartService.updateChart(currentEditToken, pendingChangesRef.current)
              .then(() => {
                pendingChangesRef.current = null;
                setIsSaving(false);
              })
              .catch(err => {
                console.error('Failed to save undo to database:', err);
                setIsSaving(false);
              });
          } else {
            setIsSaving(false);
          }
          saveTimeoutRef.current = null;
        }, 300);
      }

      console.log('Undo performed, undo history length:', newUndoHistory.length);
    }
  }, [undoHistory, data, saveToLocalStorage, currentEditToken]);

  const handleRedo = useCallback(() => {
    // Clear any pending saves first
    if (undoTimeoutRef.current) {
      clearTimeout(undoTimeoutRef.current);
      undoTimeoutRef.current = null;
    }

    if (redoHistory.length > 0 && data) {
      const nextState = redoHistory[redoHistory.length - 1];
      const newRedoHistory = redoHistory.slice(0, -1);

      // Validate the next state has required structure
      if (!nextState || !nextState.sections || !Array.isArray(nextState.sections)) {
        console.error('Invalid redo state detected:', nextState);
        return;
      }

      // Save current state to undo history
      setUndoHistory(prev => [...prev, JSON.parse(JSON.stringify(data))]);
      setRedoHistory(newRedoHistory);

      // Use debounced save for redo as well
      setData(nextState);
      pendingChangesRef.current = nextState;
      saveToLocalStorage(nextState);

      // Trigger debounced database save for redo
      if (currentEditToken) {
        if (saveTimeoutRef.current) {
          clearTimeout(saveTimeoutRef.current);
        }
        setIsSaving(true);
        saveTimeoutRef.current = setTimeout(() => {
          if (pendingChangesRef.current && currentEditToken) {
            console.log('Saving redo state to database');
            ChartService.updateChart(currentEditToken, pendingChangesRef.current)
              .then(() => {
                pendingChangesRef.current = null;
                setIsSaving(false);
              })
              .catch(err => {
                console.error('Failed to save redo to database:', err);
                setIsSaving(false);
              });
          } else {
            setIsSaving(false);
          }
          saveTimeoutRef.current = null;
        }, 300);
      }

      console.log('Redo performed, redo history length:', newRedoHistory.length);
    }
  }, [redoHistory, data, saveToLocalStorage, currentEditToken]);

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

  // Add beforeunload warning for unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Check if there are pending changes or currently saving
      if (pendingChangesRef.current || isSaving) {
        e.preventDefault();
        e.returnValue = ''; // Chrome requires returnValue to be set
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [isSaving]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (undoTimeoutRef.current) {
        clearTimeout(undoTimeoutRef.current);
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        // Save any pending changes immediately on unmount
        if (pendingChangesRef.current && currentEditToken) {
          ChartService.updateChart(currentEditToken, pendingChangesRef.current).catch(console.error);
        }
      }
    };
  }, [currentEditToken]);

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      setError(null)

      try {
        if (editToken) {
          // Load from database using editToken
          console.log('Loading chart from database with edit token:', editToken);
          const result = await ChartService.getChartByEditToken(editToken);
          setData(result.chartData);
          setCurrentEditToken(editToken);
        } else if (filename) {
          // Fallback to file-based loading for backwards compatibility
          const savedData = loadFromLocalStorage(filename);
          if (savedData) {
            console.log('Using saved data from localStorage');
            setData(savedData);
            setLoading(false);
            return;
          }

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
  }, [filename, editToken, loadFromLocalStorage, saveToLocalStorage])

  // Helper function to calculate zoom-to-fit
  const calculateZoomToFit = useCallback(() => {
    if (!containerSize.width || !containerSize.height) {
      return { x: 0, y: 0, z: 1 };
    }

    // Calculate viewport dimensions
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Account for sidebars and padding
    const sidebarWidth = isLeftPanelCollapsed ? 48 : viewportWidth * 0.25; // 3rem or 25%
    const availableWidth = viewportWidth - sidebarWidth - 32; // 32px for padding (left + right)
    const availableHeight = viewportHeight - 64 - 80; // 64px top, 80px bottom padding

    // Calculate graph dimensions (including the white container padding)
    const graphWidth = containerSize.width + 32;
    const graphHeight = containerSize.height + 32;

    // Calculate zoom to fit with some padding (90% of available space)
    const zoomToFitWidth = (availableWidth / graphWidth);
    const zoomToFitHeight = (availableHeight / graphHeight);
    const zoomToFit = Math.min(zoomToFitWidth, zoomToFitHeight);

    // Calculate centering translation
    // Strategy: Position the graph so its center appears at the center of available viewport space
    // The graph container (white box) has dimensions: graphWidth x graphHeight
    // Available viewport space for the graph: availableWidth x availableHeight
    // After zoom, graph appears as: (graphWidth * z) x (graphHeight * z)

    const paddingLeft = sidebarWidth + 16; // sidebarWidth + 1rem
    const paddingTop = 64;

    // Where we want the graph to appear in screen space
    // Center of available space: (paddingLeft + availableWidth/2, paddingTop + availableHeight/2)

    // After transform scale(z) translate(tx, ty), the graph container's top-left corner
    // (which flexbox positions) appears in screen at: z * (topLeft + translate)
    // We want the CENTER to appear at the center of available space

    // Flexbox centers horizontally: topLeft.x = paddingLeft + (availableWidth - graphWidth)/2
    // Flexbox top-aligns: topLeft.y = paddingTop

    // Graph center = topLeft + (graphWidth/2, graphHeight/2)
    // = (paddingLeft + (availableWidth - graphWidth)/2 + graphWidth/2, paddingTop + graphHeight/2)
    // = (paddingLeft + availableWidth/2, paddingTop + graphHeight/2)

    // After transform: z * (topLeft + translate) = where topLeft appears
    // Graph center appears at: z * (topLeft + translate + (graphWidth/2, graphHeight/2))
    // We want this to equal: (paddingLeft + availableWidth/2, paddingTop + availableHeight/2)

    // So: z * (topLeft + translate + graphCenter_relative) = targetCenter
    // translate = targetCenter/z - topLeft - graphCenter_relative

    // Important: Flexbox centers when content fits, but left-aligns when it overflows
    const topLeftX = graphWidth <= availableWidth
      ? paddingLeft + (availableWidth - graphWidth) / 2  // Centered by flexbox
      : paddingLeft;  // Left-aligned when overflowing

    const topLeftY = paddingTop;  // Always top-aligned

    const targetCenterX = paddingLeft + availableWidth / 2;
    const targetCenterY = paddingTop + availableHeight / 2;

    const centerX = targetCenterX / zoomToFit - topLeftX - graphWidth / 2;
    const centerY = targetCenterY / zoomToFit - topLeftY - graphHeight / 2;

    return {
      x: centerX,
      y: centerY,
      z: zoomToFit
    };
  }, [containerSize.width, containerSize.height, isLeftPanelCollapsed]);

  // Zoom to fit on initial load
  useEffect(() => {
    if (hasInitializedZoom.current || !containerSize.width || !containerSize.height) {
      return;
    }

    const zoomToFit = calculateZoomToFit();
    setCamera(zoomToFit);
    hasInitializedZoom.current = true;
    console.log('Zoom to fit applied:', zoomToFit);
  }, [containerSize.width, containerSize.height, calculateZoomToFit]);

  // Smart periodic sync with idle detection for edit mode
  useEffect(() => {
    if (!editToken) return;

    let interval: NodeJS.Timeout;
    let lastSyncedData: string | null = null;
    let isTabVisible = true;
    let lastActivity = Date.now();
    let syncInterval = 10000; // Start with 10 seconds
    let consecutiveUnchanged = 0;

    const syncData = async () => {
      // Don't sync if tab is hidden or user is idle
      if (!isTabVisible || Date.now() - lastActivity > 300000) { // 5 min idle timeout
        console.log('Skipping sync - tab hidden or user idle');
        return;
      }

      try {
        console.log(`Syncing chart in edit mode (interval: ${syncInterval}ms)`);
        const result = await ChartService.getChartByEditToken(editToken);
        const newDataStr = JSON.stringify(result.chartData);

        // Only update if the data has changed (to preserve undo/redo history)
        if (lastSyncedData !== newDataStr) {
          lastSyncedData = newDataStr;
          setData(result.chartData);
          console.log('Chart data updated from sync');
          setLastSyncTime(new Date());
          consecutiveUnchanged = 0;
          syncInterval = 10000; // Reset to 10 seconds
        } else {
          consecutiveUnchanged++;
          // Exponential backoff: 10s -> 15s -> 22s -> 33s -> 50s -> 60s max
          if (consecutiveUnchanged > 2) {
            const newInterval = Math.min(Math.floor(syncInterval * 1.5), 60000);
            if (newInterval !== syncInterval) {
              syncInterval = newInterval;
              console.log(`No changes for ${consecutiveUnchanged} syncs, interval now ${syncInterval}ms`);
            }
          }
        }
      } catch (err) {
        console.error('Error syncing chart data:', err);
      }
    };

    // Handle visibility change
    const handleVisibilityChange = () => {
      isTabVisible = !document.hidden;
      if (isTabVisible) {
        console.log('Tab became visible, syncing immediately');
        syncData(); // Sync immediately when tab becomes visible
        lastActivity = Date.now();
      }
    };

    // Handle user activity
    const handleActivity = () => {
      const timeSinceLastActivity = Date.now() - lastActivity;
      lastActivity = Date.now();

      // If user was idle and becomes active, sync immediately
      if (timeSinceLastActivity > 300000) {
        console.log('User became active after being idle, syncing');
        syncData();
      }
    };

    // Listen for events
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('mousemove', handleActivity);
    document.addEventListener('keydown', handleActivity);
    document.addEventListener('click', handleActivity);
    document.addEventListener('scroll', handleActivity);

    // Initial sync after a short delay
    const initialTimer = setTimeout(syncData, 1000);

    // Dynamic interval
    const runSync = () => {
      syncData();
      clearInterval(interval);
      if (syncInterval < 60000 || consecutiveUnchanged < 10) {
        interval = setInterval(runSync, syncInterval);
      }
    };
    interval = setInterval(runSync, syncInterval);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('mousemove', handleActivity);
      document.removeEventListener('keydown', handleActivity);
      document.removeEventListener('click', handleActivity);
      document.removeEventListener('scroll', handleActivity);
    };
  }, [editToken])

  // Update the "time ago" display every second
  const [, forceUpdate] = useState({});
  useEffect(() => {
    if (!lastSyncTime) return;

    const interval = setInterval(() => {
      // Force re-render to update the "time ago" display
      forceUpdate({});
    }, 1000);

    return () => clearInterval(interval);
  }, [lastSyncTime]);

  // Canvas zoom and pan implementation
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // Check if this is a zoom gesture (Ctrl/Cmd key)
      const isZoomGesture = e.ctrlKey || e.metaKey;

      if (isZoomGesture) {
        e.preventDefault();
        e.stopPropagation();

        const container = zoomableRef.current;
        if (!container) return;

        // Calculate new zoom level - 1% steps
        const zoomStep = 0.05;
        const delta = -e.deltaY > 0 ? 1 : -1;
        const newZoom = Math.max(0.5, Math.min(5, camera.z + delta * zoomStep * camera.z));

        // The transform is: scale(z) translate(x, y) with origin at 0,0
        // This means: screenPoint = scale * (localPoint + translate)
        // Or: screenPoint = localPoint * scale + translate * scale

        // Get mouse position in screen space
        const mouseScreenX = e.clientX;
        const mouseScreenY = e.clientY;

        // Get the untransformed position of the transform origin
        // We need the position where the container WOULD be without the transform
        const parent = container.parentElement;
        if (!parent) return;
        const parentRect = parent.getBoundingClientRect();

        // Origin is at top-left of container (accounting for padding)
        const style = window.getComputedStyle(container);
        const paddingLeft = parseFloat(style.paddingLeft) || 0;
        const paddingTop = parseFloat(style.paddingTop) || 0;

        const originX = parentRect.left + paddingLeft;
        const originY = parentRect.top + paddingTop;

        // Mouse position relative to origin in screen space
        const mouseX = mouseScreenX - originX;
        const mouseY = mouseScreenY - originY;

        // The local point under the mouse: localPoint = (screenPoint - translate * scale) / scale
        const localPointX = (mouseX - camera.x * camera.z) / camera.z;
        const localPointY = (mouseY - camera.y * camera.z) / camera.z;

        // After zoom: mouseX = localPoint * newZoom + newTranslate * newZoom
        // Solving: newTranslate = (mouseX / newZoom) - localPoint
        const newX = mouseX / newZoom - localPointX;
        const newY = mouseY / newZoom - localPointY;

        setCamera({
          x: newX,
          y: newY,
          z: newZoom
        });
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      const container = zoomableRef.current;
      if (!container) return;

      // Check if the target is a draggable node, legend, or interactive element
      const target = e.target as HTMLElement;
      const isNode = target.closest('[draggable="true"]');
      const isLegend = target.closest('.cursor-grab') || target.closest('.cursor-grabbing'); // Legend has grab cursor
      const isChatPanel = target.closest('.fixed.left-0.z-40') !== null; // Check if inside chat panel
      const isJsonPanel = target.closest('.fixed.bottom-0.z-30') !== null; // Check if inside JSON dropdown panel

      // Check if there's any active text editing happening
      const activeElement = document.activeElement;
      const isTextEditing = activeElement && (
        activeElement.tagName === 'INPUT' ||
        activeElement.tagName === 'TEXTAREA' ||
        (activeElement as HTMLElement).contentEditable === 'true'
      );

      // Check if clicking on text content within nodes or detail panels (for text selection in view mode)
      // Only prevent panning for text inside actual nodes or modal panels, not section/graph titles
      const isTextContent = target.tagName === 'DIV' || target.tagName === 'SPAN' || target.tagName === 'P' || target.tagName === 'H2' || target.tagName === 'H3' || target.tagName === 'H4';
      const hasTextContent = target.textContent && target.textContent.trim().length > 0;
      const isInsideNode = target.closest('[id^="node-"]') !== null; // Check if inside a node element
      const isInsideModal = target.closest('[class*="z-[2"]') !== null; // Check if inside a modal (NodePopup/EdgePopup have z-[200+])
      const isSelectableText = isTextContent && hasTextContent && (isInsideNode || isInsideModal);

      const isEditableElement = target.tagName === 'INPUT' ||
                               target.tagName === 'TEXTAREA' ||
                               target.tagName === 'SELECT' ||
                               target.tagName === 'BUTTON' ||
                               target.closest('button') !== null || // Also check if clicked element is inside a button
                               target.contentEditable === 'true' ||
                               target.closest('.mdx-editor-wrapper') !== null || // MDX editor components
                               isTextEditing || // Prevent panning if any text field is being edited
                               isSelectableText; // Allow text selection instead of panning


      // Only pan with left mouse button, no modifiers, and not on interactive elements, chat panel, or JSON panel
      if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !isNode && !isLegend && !isEditableElement && !isChatPanel && !isJsonPanel) {
        e.preventDefault();
        setIsPanning(true);
        setPanStart({ x: e.clientX, y: e.clientY });
        setPanStartCamera({ x: camera.x, y: camera.y });
        container.style.cursor = 'grabbing';
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (isPanning && panStart && panStartCamera) {
        const deltaX = e.clientX - panStart.x;
        const deltaY = e.clientY - panStart.y;

        // Convert pixel movement to camera movement (divide by zoom)
        setCamera(prev => ({
          ...prev,
          x: panStartCamera.x + deltaX / prev.z,
          y: panStartCamera.y + deltaY / prev.z
        }));
      }
    };

    const handleMouseUp = () => {
      if (isPanning) {
        setIsPanning(false);
        setPanStart(null);
        setPanStartCamera(null);
        const container = zoomableRef.current;
        if (container) {
          container.style.cursor = '';
        }
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Prevent Ctrl+Plus, Ctrl+Minus, Ctrl+0 browser zoom (or Cmd on Mac)
      if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0')) {
        e.preventDefault();

        if (e.key === '0') {
          // Reset to zoom-to-fit
          const zoomToFit = calculateZoomToFit();
          setCamera(zoomToFit);
          console.log('Reset to zoom-to-fit:', zoomToFit);
        }
      }
    };

    // Attach to document to catch all events before they bubble
    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    document.addEventListener('mousedown', handleMouseDown, { capture: true });
    document.addEventListener('mousemove', handleMouseMove, { capture: true });
    document.addEventListener('mouseup', handleMouseUp, { capture: true });
    document.addEventListener('keydown', handleKeyDown, { capture: true });

    return () => {
      document.removeEventListener('wheel', handleWheel, { capture: true });
      document.removeEventListener('mousedown', handleMouseDown, { capture: true });
      document.removeEventListener('mousemove', handleMouseMove, { capture: true });
      document.removeEventListener('mouseup', handleMouseUp, { capture: true });
      document.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [camera, isPanning, panStart, panStartCamera, calculateZoomToFit]);

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
    <div className="h-screen w-screen bg-gray-50 overflow-hidden fixed inset-0">
      {/* Left Sidebar - AI Assistant */}
      <ChatInterface
        isCollapsed={isLeftPanelCollapsed}
        onToggle={() => setIsLeftPanelCollapsed(!isLeftPanelCollapsed)}
        graphData={data}
        onGraphUpdate={handleGraphUpdate}
        highlightedNodes={highlightedNodes}
      />

      <div
        ref={zoomableRef}
        className="min-h-full flex flex-col py-4"
        style={{
          paddingTop: '64px',
          paddingLeft: isLeftPanelCollapsed ? 'calc(3rem + 1rem)' : 'calc(25% + 1rem)',
          paddingRight: '1rem',
          paddingBottom: '80px', // Add space for footer
          transform: `scale(${camera.z}) translate(${camera.x}px, ${camera.y}px)`,
          transformOrigin: '0 0',
          transition: 'padding-left 300ms'
        }}
      >
        <div className="flex flex-1 gap-6 justify-center items-start mx-auto">
        {/* Main Graph Container */}
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
            <ToC
              data={data}
              onSizeChange={setContainerSize}
              onDataChange={handleDataChange}
              undoHistory={undoHistory}
              redoHistory={redoHistory}
              handleUndo={handleUndo}
              handleRedo={handleRedo}
              setShowShareModal={setShowShareModal}
              isSaving={isSaving}
              currentEditToken={currentEditToken}
              lastSyncTime={lastSyncTime}
              isManualSyncing={isManualSyncing}
              handleManualSync={handleManualSync}
              getTimeAgo={getTimeAgo}
              zoomScale={camera.z}
              camera={camera}
              onHighlightedNodesChange={setHighlightedNodes}
              onEditTokenChange={setCurrentEditToken}
            />
          </div>
        </div>

      </div>


        {/* Share Modal */}
        <ShareModal
          isOpen={showShareModal}
          onClose={() => setShowShareModal(false)}
          chartData={data}
          currentEditToken={currentEditToken}
        />
      </div>

      {/* Zoom Controls - Google Maps Style */}
      <div
        className="fixed z-40 bg-white rounded-lg shadow-lg border border-gray-200"
        style={{
          bottom: '5rem',
          right: '1rem'
        }}
      >
        <div className="flex flex-col">
          {/* Zoom In */}
          <button
            onClick={() => {
              const viewportWidth = window.innerWidth;
              const viewportHeight = window.innerHeight;
              const sidebarWidth = isLeftPanelCollapsed ? 48 : viewportWidth * 0.25;
              const toolbarHeight = 64;
              const jsonDropdownHeight = 64;

              // Calculate center of available viewport
              const centerX = sidebarWidth + (viewportWidth - sidebarWidth) / 2;
              const centerY = toolbarHeight + (viewportHeight - toolbarHeight - jsonDropdownHeight) / 2;

              // Calculate new zoom (20% increase)
              const newZoom = Math.min(5, camera.z * 1.2);

              // Find the local point at viewport center
              // localPoint = (screenPoint - translate * scale) / scale
              const localX = (centerX - camera.x * camera.z) / camera.z;
              const localY = (centerY - camera.y * camera.z) / camera.z;

              // After zoom, we want the same local point to remain at center
              // screenPoint = localPoint * newScale + translate * newScale
              // centerX = localX * newZoom + newX * newZoom
              // Solving: newX = centerX / newZoom - localX
              const newX = centerX / newZoom - localX;
              const newY = centerY / newZoom - localY;

              setCamera({ x: newX, y: newY, z: newZoom });
            }}
            className="p-2 hover:bg-gray-100 transition-colors rounded-t-lg border-b border-gray-200"
            title="Zoom in"
          >
            <PlusIcon className="w-5 h-5 text-gray-700" />
          </button>

          {/* Zoom Out */}
          <button
            onClick={() => {
              const viewportWidth = window.innerWidth;
              const viewportHeight = window.innerHeight;
              const sidebarWidth = isLeftPanelCollapsed ? 48 : viewportWidth * 0.25;
              const toolbarHeight = 64;
              const jsonDropdownHeight = 64;

              // Calculate center of available viewport
              const centerX = sidebarWidth + (viewportWidth - sidebarWidth) / 2;
              const centerY = toolbarHeight + (viewportHeight - toolbarHeight - jsonDropdownHeight) / 2;

              // Calculate new zoom (20% decrease)
              const newZoom = Math.max(0.1, camera.z / 1.2);

              // Find the local point at viewport center
              const localX = (centerX - camera.x * camera.z) / camera.z;
              const localY = (centerY - camera.y * camera.z) / camera.z;

              // Keep the same local point at center after zoom
              const newX = centerX / newZoom - localX;
              const newY = centerY / newZoom - localY;

              setCamera({ x: newX, y: newY, z: newZoom });
            }}
            className="p-2 hover:bg-gray-100 transition-colors border-b border-gray-200"
            title="Zoom out"
          >
            <MinusIcon className="w-5 h-5 text-gray-700" />
          </button>

          {/* Zoom to Fit */}
          <button
            onClick={() => {
              const zoomToFit = calculateZoomToFit();
              setCamera(zoomToFit);
            }}
            className="p-2 hover:bg-gray-100 transition-colors rounded-b-lg"
            title="Fit to page (Ctrl+0)"
          >
            <ArrowsPointingOutIcon className="w-5 h-5 text-gray-700" />
          </button>
        </div>
      </div>

      {/* JSON Dropdown Footer - Fixed at bottom */}
      <div
        className="fixed bottom-0 z-30"
        style={{
          left: isLeftPanelCollapsed ? '3rem' : '25%',
          right: 0,
          transition: 'left 300ms'
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
  )
}

function App() {
  return (
    <ApiKeyProvider>
      <PrivacyPolicyPopup />
      <Routes>
        {/* New URL-based routes */}
        <Route path="/" element={<ToCViewer />} />
        <Route path="/chart/:chartId" element={<ToCViewerOnly />} />
        <Route path="/edit/:editToken" element={<ToCViewer />} />

        {/* Legacy file-based routes for backwards compatibility */}
        <Route path="/:filename" element={<ToCViewer />} />
        <Route path="/:filename/view" element={<ToCViewerOnly />} />
        <Route path="/view" element={<ToCViewerOnly />} />
      </Routes>
    </ApiKeyProvider>
  )
}

export default App
