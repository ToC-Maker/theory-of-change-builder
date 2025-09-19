import { useState, useEffect, useCallback, useRef } from "react"
import { Routes, Route, useParams, Link } from "react-router-dom"
import { ToC } from "./stories/ToC"
import { ChatInterface } from "./components/ChatInterface"
import { InfoPanel } from "./components/InfoPanel"
import { StaticLegend } from "./components/StaticLegend"
import { JsonDropdown } from "./components/JsonDropdown"
import { ToCGeneratorModal } from "./components/ToCGeneratorModal"
import { ShareModal } from "./components/ShareModal"
import { ApiKeyProvider } from "./contexts/ApiKeyContext"
import { ChartService } from "./services/chartService"
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
  columnPadding?: number
  sectionPadding?: number
}

function ToCViewerOnly() {
  const { filename, chartId } = useParams<{ filename?: string; chartId?: string }>()
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

  return (
    <div className="h-screen w-screen bg-gray-50 overflow-auto fixed inset-0">
      {/* Remove horizontal centering to allow full left-right scrolling */}
      <div className="min-h-full flex flex-col justify-center py-4 px-4">
        <div className="flex flex-col flex-shrink-0 mx-auto">
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
  const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(false)
  const [showToCGenerator, setShowToCGenerator] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [currentEditToken, setCurrentEditToken] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

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
      }, 1000);
    }

    console.log('JSON data uploaded successfully');
  }, [data, saveToHistory, saveToLocalStorage, currentEditToken]);

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
    pendingChangesRef.current = newGraphData;
    saveToLocalStorage(newGraphData);

    // Trigger debounced database save for LLM edits
    if (currentEditToken) {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      setIsSaving(true);
      saveTimeoutRef.current = setTimeout(() => {
        if (pendingChangesRef.current && currentEditToken) {
          console.log('Saving LLM edit to database');
          ChartService.updateChart(currentEditToken, pendingChangesRef.current)
            .then(() => {
              pendingChangesRef.current = null;
              setIsSaving(false);
            })
            .catch(err => {
              console.error('Failed to save LLM edit to database:', err);
              setIsSaving(false);
            });
        } else {
          setIsSaving(false);
        }
        saveTimeoutRef.current = null;
      }, 1000);
    }

    console.log('setData called with new graph data');
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

    // Save to database after 1 second of no changes
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
    }, 1000); // 1 second debounce
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
        }, 1000);
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
        }, 1000);
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
    <div className="h-screen w-screen bg-gray-50 overflow-auto fixed inset-0">
      <div className="min-h-full flex flex-col py-4 px-4">
        <div className="flex items-center gap-4 mb-4 flex-shrink-0 mx-auto">
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
          <button
            onClick={() => setShowShareModal(true)}
            className="flex items-center gap-2 px-3 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
            title="Share chart with others"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m9.032 4.026a9.001 9.001 0 01-7.432 0m9.032-4.026A9.001 9.001 0 0112 3c-4.474 0-8.268 3.12-9.032 7.326m9.032 4.026A9.001 9.001 0 019.968 7.326" />
            </svg>
            Share
          </button>
          {isSaving && (
            <div className="flex items-center gap-2 px-3 py-2 bg-yellow-100 text-yellow-800 rounded-lg">
              <svg className="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span className="text-sm font-medium">Saving...</span>
            </div>
          )}
          {!isSaving && currentEditToken && (
            <div className="flex items-center gap-1 px-3 py-2 text-green-700">
              <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="text-sm">Saved</span>
            </div>
          )}
        </div>
      </div>
      
        <div className="flex flex-1 gap-6 justify-center items-start mx-auto">
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

        {/* Share Modal */}
        <ShareModal
          isOpen={showShareModal}
          onClose={() => setShowShareModal(false)}
          chartData={data}
          currentEditToken={currentEditToken}
        />
      </div>
    </div>
  )
}

function App() {
  return (
    <ApiKeyProvider>
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
