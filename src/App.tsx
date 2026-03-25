import { useState, useEffect, useCallback, useRef, useMemo } from "react"
import { useZoomPan } from "./hooks/useZoomPan"
import { Routes, Route, useParams, useLocation, Link, useNavigate } from "react-router-dom"
import { useAuth0 } from "@auth0/auth0-react"
import { ToC } from "./components/TheoryOfChangeGraph"
import { ChatInterface } from "./components/ChatInterface"
import { JsonDropdown } from "./components/JsonDropdown"
import { GraphTutorial } from "./components/GraphTutorial"
import { PrivacyPolicyPopup } from "./components/PrivacyPolicyPopup"
import { ApiKeyProvider } from "./contexts/ApiKeyContext"
import { ChartService } from "./services/chartService"
import { chatService } from "./services/chatService"
import { LoggingServiceClass, loggingService } from "./services/loggingService"
import { useLoggingSession } from "./hooks/useLoggingSession"
import { PlusIcon, MinusIcon, ArrowsPointingOutIcon, DocumentDuplicateIcon } from "@heroicons/react/24/outline"
import AuthButton from "./components/AuthButton"
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
  const { loginWithRedirect, isAuthenticated, isLoading: authLoading, getIdTokenClaims } = useAuth0()
  const [data, setData] = useState<ToCData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [isCopying, setIsCopying] = useState(false)
  const [isInIframe, setIsInIframe] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Use shared zoom/pan hook
  const {
    camera,
    isPanning,
    isZoomedIn,
    getTransformPosition,
    zoomIn,
    zoomOut,
    zoomToFit,
    contentWidth,
    contentHeight,
  } = useZoomPan({
    containerSize,
    containerRef,
  })

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
      // Wait for auth to finish loading if it hasn't yet
      if (authLoading) {
        // Auth is still loading, wait a bit and retry
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Get and set the auth token if user is authenticated
      if (isAuthenticated) {
        try {
          const idTokenClaims = await getIdTokenClaims();
          const idToken = idTokenClaims?.__raw;
          if (idToken) {
            ChartService.setAuthToken(idToken);
            console.log('[ToCViewerOnly] Auth token set for copy operation');
          }
        } catch (err) {
          console.error('[ToCViewerOnly] Failed to get ID token:', err);
          // Continue without token - will create anonymous chart
        }
      } else {
        ChartService.setAuthToken(null);
      }

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

  // Update document title when data changes
  useEffect(() => {
    if (data?.title) {
      document.title = `${data.title} - Theory of Change Builder`;
    } else {
      document.title = 'Theory of Change Builder';
    }
  }, [data?.title]);

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
      <div className="h-screen w-screen bg-white flex items-center justify-center">
        <div className="text-xl text-gray-600">Loading Theory of Change...</div>
      </div>
    )
  }

  if (error) {
    const isPendingError = error.includes('pending') || error.includes('approve');
    const isAuthError = error.includes('Authentication required') || error.includes('log in');
    const isNotFoundError = error.includes('not found') || error.includes('deleted');

    return (
      <div className="min-h-screen w-full bg-white flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          {/* Icon */}
          <div className={`mx-auto flex items-center justify-center h-16 w-16 rounded-full mb-4 ${isPendingError ? 'bg-yellow-100' : 'bg-red-100'}`}>
            {isPendingError ? (
              <svg className="h-8 w-8 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : isAuthError ? (
              <svg className="h-8 w-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            ) : isNotFoundError ? (
              <svg className="h-8 w-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="h-8 w-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
          </div>

          {/* Title */}
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            {isPendingError ? 'Access Request Pending' : isAuthError ? 'Authentication Required' : isNotFoundError ? 'Chart Not Found' : 'Unable to Load Chart'}
          </h2>

          {/* Error Message */}
          <p className="text-gray-600 mb-6">
            {error}
          </p>

          {/* Actions */}
          <div className="flex flex-col gap-3">
            {isAuthError && (
              <button
                onClick={() => {
                  // Save the current path to localStorage before redirecting
                  localStorage.setItem('auth0_returnTo', window.location.pathname);
                  loginWithRedirect({
                    appState: { returnTo: window.location.pathname }
                  });
                }}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                Log In to Continue
              </button>
            )}
            <Link
              to="/"
              className="w-full px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
            >
              Go Home
            </Link>
          </div>

          {/* Additional Help */}
          {isAuthError && (
            <p className="mt-6 text-sm text-gray-500">
              This chart requires you to be logged in to access it.
            </p>
          )}
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="h-screen w-screen bg-white flex items-center justify-center">
        <div className="text-xl text-gray-600">No data available</div>
      </div>
    )
  }

  // Get transform position from the hook
  const { x: offsetX, y: offsetY, scale } = getTransformPosition();

  return (
    <div
      ref={containerRef}
      style={{
        width: '100vw',
        height: '100vh',
        margin: 0,
        padding: 0,
        background: 'transparent',
        overflow: 'hidden',
        position: 'fixed',
        top: 0,
        left: 0,
        cursor: isZoomedIn ? (isPanning ? 'grabbing' : 'grab') : 'default'
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: `${offsetX}px`,
          top: `${offsetY}px`,
          transformOrigin: 'top left',
          transform: `scale(${scale})`,
          width: `${contentWidth}px`,
          height: `${contentHeight}px`,
          pointerEvents: 'auto'
        }}
      >
        <div style={{ background: 'transparent', padding: '16px' }}>
          <ToC data={data} onSizeChange={setContainerSize} onDataChange={() => {}} showEditButton={false} />
        </div>
      </div>

      {/* Make a Copy button - fixed position outside transform context (hidden in iframes) */}
      {!isInIframe && (
        <button
          onClick={handleMakeCopy}
          disabled={isCopying}
          className="fixed z-50 bg-white hover:bg-gray-50 text-gray-700 font-medium px-4 py-2 rounded-lg shadow-lg border border-gray-200 transition-all hover:shadow-xl disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          style={{
            top: '16px',
            right: '16px'
          }}
          title="Create an editable copy of this graph"
        >
          <DocumentDuplicateIcon className={`w-4 h-4 ${isCopying ? 'animate-pulse' : ''}`} />
          {isCopying ? 'Copying...' : 'Make a Copy'}
        </button>
      )}

      {/* Zoom controls - bottom right (hidden on mobile) */}
      {!isInIframe && (
        <div className="fixed bottom-4 right-4 z-50 flex-col bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden hidden md:flex">
          <button
            onClick={zoomIn}
            className="p-2 hover:bg-gray-100 transition-colors border-b border-gray-200"
            title="Zoom in"
          >
            <PlusIcon className="w-5 h-5 text-gray-700" />
          </button>
          <button
            onClick={zoomOut}
            className="p-2 hover:bg-gray-100 transition-colors border-b border-gray-200"
            title="Zoom out"
          >
            <MinusIcon className="w-5 h-5 text-gray-700" />
          </button>
          <button
            onClick={zoomToFit}
            className="p-2 hover:bg-gray-100 transition-colors"
            title="Fit to screen"
          >
            <ArrowsPointingOutIcon className="w-5 h-5 text-gray-700" />
          </button>
        </div>
      )}

      <GraphTutorial />
    </div>
  )
}

function ToCViewer() {
  const { filename, editToken } = useParams<{ filename?: string; editToken?: string }>()
  const { getIdTokenClaims, isAuthenticated, isLoading: authLoading, loginWithRedirect } = useAuth0()
  const [data, setData] = useState<ToCData | null>(null)
  const [undoHistory, setUndoHistory] = useState<ToCData[]>([])
  const [redoHistory, setRedoHistory] = useState<ToCData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [isLeftPanelCollapsed, setIsLeftPanelCollapsed] = useState(false)
  const [currentEditToken, setCurrentEditToken] = useState<string | null>(null)
  const [currentChartId, setCurrentChartId] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null)
  const [isManualSyncing, setIsManualSyncing] = useState(false)
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set())
  const containerRef = useRef<HTMLDivElement>(null)
  const [authTokenReady, setAuthTokenReady] = useState(false)

  // Calculate viewport offset based on sidebar state
  const viewportOffset = useMemo(() => ({
    left: isLeftPanelCollapsed ? 48 : Math.floor(window.innerWidth * 0.25),
    top: 64,    // Toolbar height
    right: 0,
    bottom: 80  // JSON dropdown height
  }), [isLeftPanelCollapsed]);

  // Exclude interactive elements from panning in edit mode
  const excludeFromPan = useCallback((target: HTMLElement) => {
    const isNode = target.closest('[draggable="true"]');
    const isLegend = target.closest('.cursor-grab') || target.closest('.cursor-grabbing');
    const isChatPanel = target.closest('.fixed.left-0.z-40') !== null;
    const isJsonPanel = target.closest('.fixed.bottom-0.z-30') !== null;
    const activeElement = document.activeElement;
    const isTextEditing = activeElement && (
      activeElement.tagName === 'INPUT' ||
      activeElement.tagName === 'TEXTAREA' ||
      (activeElement as HTMLElement).contentEditable === 'true'
    );
    const isTextContent = target.tagName === 'DIV' || target.tagName === 'SPAN' || target.tagName === 'P' || target.tagName === 'H2' || target.tagName === 'H3' || target.tagName === 'H4';
    const hasTextContent = target.textContent && target.textContent.trim().length > 0;
    const isInsideNode = target.closest('[id^="node-"]') !== null;
    const isInsideModal = target.closest('[class*="z-[2"]') !== null;
    const isSelectableText = isTextContent && hasTextContent && (isInsideNode || isInsideModal);
    const isEditableElement = target.tagName === 'INPUT' ||
                             target.tagName === 'TEXTAREA' ||
                             target.tagName === 'SELECT' ||
                             target.tagName === 'BUTTON' ||
                             target.closest('button') !== null ||
                             target.contentEditable === 'true' ||
                             target.closest('.mdx-editor-wrapper') !== null ||
                             isTextEditing ||
                             isSelectableText;

    return !!(isNode || isLegend || isEditableElement || isChatPanel || isJsonPanel);
  }, []);

  // Use shared zoom/pan hook
  const {
    camera,
    isPanning,
    isZoomedIn,
    getTransformPosition,
    zoomIn,
    zoomOut,
    zoomToFit,
    contentWidth,
    contentHeight,
  } = useZoomPan({
    containerSize,
    containerRef,
    viewportOffset,
    excludeFromPan,
  })

  // Set Auth0 token on ChartService and LoggingService when user is authenticated
  useEffect(() => {
    const setToken = async () => {
      if (isAuthenticated && !authLoading) {
        try {
          console.log('[App] Fetching Auth0 ID token...');
          const idTokenClaims = await getIdTokenClaims();
          const idToken = idTokenClaims?.__raw;
          if (idToken) {
            ChartService.setAuthToken(idToken);
            chatService.setAuthToken(idToken);
            LoggingServiceClass.setAuthToken(idToken);
            // Sync server-side logging preference to localStorage before proceeding
            await loggingService.syncPreferenceFromServer();
            console.log('[App] Auth token set on ChartService and LoggingService (length:', idToken.length, ')');
            setAuthTokenReady(true);
          } else {
            console.error('[App] ID token not available');
            ChartService.setAuthToken(null);
            chatService.setAuthToken(null);
            LoggingServiceClass.setAuthToken(null);
            setAuthTokenReady(true); // Ready even if no token (anonymous mode)
          }
        } catch (err) {
          console.error('[App] Failed to get ID token:', err);
          ChartService.setAuthToken(null);
          chatService.setAuthToken(null);
          LoggingServiceClass.setAuthToken(null);
          setAuthTokenReady(true); // Ready even if error (anonymous mode)
        }
      } else if (!authLoading) {
        // Auth finished loading but user is not authenticated
        console.log('[App] User not authenticated, clearing token');
        ChartService.setAuthToken(null);
        chatService.setAuthToken(null);
        LoggingServiceClass.setAuthToken(null);
        setAuthTokenReady(true); // Ready for anonymous mode
      } else {
        // Auth still loading
        console.log('[App] Auth still loading, token not ready');
        setAuthTokenReady(false);
      }
    };
    setToken();
  }, [isAuthenticated, authLoading, getIdTokenClaims]);

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

  // Logging session lifecycle (session init, activity tracking, cleanup)
  const {
    initializeLogging,
    handlePrivacyAccept,
    handleLoggingEnabled,
    logGraphChange,
  } = useLoggingSession({ chartId: currentChartId, graphData: data });

  // Handler for when a new chart is created (auto-save or manual share)
  const handleChartCreated = useCallback(async (editToken: string, chartId: string) => {
    setCurrentEditToken(editToken);
    setCurrentChartId(chartId);
    if (dataRef.current) {
      initializeLogging(chartId, dataRef.current);
    }
  }, [initializeLogging]);

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
  const dataRef = useRef<ToCData | null>(data);
  useEffect(() => { dataRef.current = data; }, [data]);

  const handleDataChange = useCallback((newData: ToCData) => {
    console.log('App handleDataChange called');

    // Save current state to history before updating
    if (dataRef.current) {
      saveToHistory(dataRef.current);
    }

    // Clear redo history when new changes are made
    setRedoHistory([]);

    setData(newData);
    pendingChangesRef.current = newData;

    // Save debounced snapshot for logging (manual edits)
    logGraphChange(newData, 'manual_edit');

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
  }, [saveToHistory, saveToLocalStorage, currentEditToken, logGraphChange]);

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

      // Save undo snapshot for logging
      logGraphChange(previousState, 'undo');

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
  }, [undoHistory, data, saveToLocalStorage, currentEditToken, logGraphChange]);

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

      // Save redo snapshot for logging
      logGraphChange(nextState, 'redo');

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
  }, [redoHistory, data, saveToLocalStorage, currentEditToken, logGraphChange]);

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

  // Store currentEditToken in a ref so cleanup can access latest value without re-running
  const currentEditTokenRef = useRef(currentEditToken);
  useEffect(() => {
    currentEditTokenRef.current = currentEditToken;
  }, [currentEditToken]);

  // Cleanup timeouts on unmount only (empty deps = only runs on mount/unmount)
  useEffect(() => {
    return () => {
      if (undoTimeoutRef.current) {
        clearTimeout(undoTimeoutRef.current);
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        // Save any pending changes immediately on unmount
        if (pendingChangesRef.current && currentEditTokenRef.current) {
          ChartService.updateChart(currentEditTokenRef.current, pendingChangesRef.current).catch(console.error);
        }
      }
    };
  }, []);

  useEffect(() => {
    const loadData = async () => {
      // Wait for auth token to be ready (either set or confirmed not needed)
      if (!authTokenReady) {
        console.log('Waiting for auth token to be ready before loading chart...');
        return;
      }

      setLoading(true)
      setError(null)

      try {
        if (editToken) {
          // Load from database using editToken
          console.log('Loading chart from database with edit token:', editToken);
          console.log('Auth state - Authenticated:', isAuthenticated, 'Token ready:', authTokenReady, 'Has token:', ChartService.hasAuthToken());
          const result = await ChartService.getChartByEditToken(editToken);
          setData(result.chartData);
          setCurrentEditToken(editToken);
          setCurrentChartId(result.chartId);

          // Initialize logging session after chart is loaded
          initializeLogging(result.chartId, result.chartData);
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
  }, [filename, editToken, loadFromLocalStorage, saveToLocalStorage, authTokenReady, isAuthenticated])

  // Update document title when data changes
  useEffect(() => {
    if (data?.title) {
      document.title = `${data.title} - Theory of Change Builder`;
    } else {
      document.title = 'Theory of Change Builder';
    }
  }, [data?.title]);

  // Smart periodic sync with idle detection for edit mode
  useEffect(() => {
    if (!editToken || !authTokenReady) return;

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

      // Don't sync if currently saving to prevent conflicts
      if (isSaving) {
        console.log('Skipping sync - save in progress');
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
  }, [editToken, isSaving, authTokenReady])

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

  if (loading) {
    return (
      <div className="h-screen w-screen bg-white flex items-center justify-center">
        <div className="text-xl text-gray-600">Loading Theory of Change...</div>
      </div>
    )
  }

  if (error) {
    const isPendingError = error.includes('pending') || error.includes('approve');
    const isAuthError = error.includes('Authentication required') || error.includes('log in');
    const isNotFoundError = error.includes('not found') || error.includes('deleted');

    return (
      <div className="min-h-screen w-full bg-white flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-8 text-center">
          {/* Icon */}
          <div className={`mx-auto flex items-center justify-center h-16 w-16 rounded-full mb-4 ${isPendingError ? 'bg-yellow-100' : 'bg-red-100'}`}>
            {isPendingError ? (
              <svg className="h-8 w-8 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : isAuthError ? (
              <svg className="h-8 w-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            ) : isNotFoundError ? (
              <svg className="h-8 w-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <svg className="h-8 w-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
          </div>

          {/* Title */}
          <h2 className="text-2xl font-bold text-gray-900 mb-2">
            {isPendingError ? 'Access Request Pending' : isAuthError ? 'Authentication Required' : isNotFoundError ? 'Chart Not Found' : 'Unable to Load Chart'}
          </h2>

          {/* Error Message */}
          <p className="text-gray-600 mb-6">
            {error}
          </p>

          {/* Actions */}
          <div className="flex flex-col gap-3">
            {isAuthError && (
              <button
                onClick={() => {
                  // Save the current path to localStorage before redirecting
                  localStorage.setItem('auth0_returnTo', window.location.pathname);
                  loginWithRedirect({
                    appState: { returnTo: window.location.pathname }
                  });
                }}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                Log In to Continue
              </button>
            )}
            <Link
              to="/"
              className="w-full px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
            >
              Go Home
            </Link>
          </div>

          {/* Additional Help */}
          {isAuthError && (
            <p className="mt-6 text-sm text-gray-500">
              This chart requires you to be logged in to access it.
            </p>
          )}
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="h-screen w-screen bg-white flex items-center justify-center">
        <div className="text-xl text-gray-600">No data available</div>
      </div>
    )
  }

  const title = filename 
    ? filename.replace('.json', '').replace(/([A-Z])/g, ' $1').trim()
    : 'Charity Entrepreneurship'

  // Get transform position from the hook
  const { x: offsetX, y: offsetY, scale } = getTransformPosition();

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

      {/* Zoomable/Pannable Graph Area */}
      <div
        ref={containerRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          width: '100vw',
          height: '100vh',
          overflow: 'hidden',
          cursor: isZoomedIn ? (isPanning ? 'grabbing' : 'grab') : 'default',
          pointerEvents: 'none' // Let events pass through to sidebar/controls
        }}
      >
        <div
          style={{
            position: 'absolute',
            left: `${offsetX}px`,
            top: `${offsetY}px`,
            transformOrigin: 'top left',
            transform: `scale(${scale})`,
            width: `${contentWidth}px`,
            height: `${contentHeight}px`,
            pointerEvents: 'auto' // Enable events on the graph itself
          }}
        >
          <div
            className="bg-white rounded-xl shadow-lg p-4"
            style={{
              width: containerSize.width > 0 ? `${containerSize.width + 32}px` : 'auto',
              height: containerSize.height > 0 ? `${containerSize.height + 32}px` : 'auto',
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
              isSaving={isSaving}
              currentEditToken={currentEditToken}
              lastSyncTime={lastSyncTime}
              isManualSyncing={isManualSyncing}
              handleManualSync={handleManualSync}
              getTimeAgo={getTimeAgo}
              zoomScale={camera.z}
              camera={camera}
              onHighlightedNodesChange={setHighlightedNodes}
              onChartCreated={handleChartCreated}
              viewportOffset={viewportOffset}
            />
          </div>
        </div>
      </div>

      {/* Auth Button - Top Right */}
      <div
        className="fixed"
        style={{
          top: '4rem',
          right: '1rem',
          zIndex: 9999
        }}
      >
        <AuthButton onLoggingEnabled={handleLoggingEnabled} />
      </div>

      {/* Zoom Controls - Google Maps Style (hidden on mobile) */}
      <div
        className="fixed z-20 bg-white rounded-lg shadow-lg border border-gray-200 hidden md:block"
        style={{
          bottom: '5rem',
          right: '1rem'
        }}
      >
        <div className="flex flex-col">
          <button
            onClick={zoomIn}
            className="p-2 hover:bg-gray-100 transition-colors rounded-t-lg border-b border-gray-200"
            title="Zoom in"
          >
            <PlusIcon className="w-5 h-5 text-gray-700" />
          </button>
          <button
            onClick={zoomOut}
            className="p-2 hover:bg-gray-100 transition-colors border-b border-gray-200"
            title="Zoom out"
          >
            <MinusIcon className="w-5 h-5 text-gray-700" />
          </button>
          <button
            onClick={zoomToFit}
            className="p-2 hover:bg-gray-100 transition-colors rounded-b-lg"
            title="Fit to page (Ctrl+0)"
          >
            <ArrowsPointingOutIcon className="w-5 h-5 text-gray-700" />
          </button>
        </div>
      </div>

      {/* JSON Dropdown Footer - Fixed at bottom */}
      <div
        className={`fixed bottom-0 z-30 transition-all duration-300 ${
          isLeftPanelCollapsed
            ? 'left-0 md:left-12'
            : 'left-0 md:left-[280px] lg:left-[25%]'
        } right-0`}
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

      {/* Privacy Policy Popup */}
      <PrivacyPolicyPopup onAccept={handlePrivacyAccept} />
    </div>
  )
}

function Auth0RedirectHandler() {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, isLoading } = useAuth0();

  useEffect(() => {
    // Check if we just returned from Auth0 (has code and state params)
    const searchParams = new URLSearchParams(location.search);
    const hasAuthParams = searchParams.has('code') && searchParams.has('state');

    if (hasAuthParams && !isLoading && isAuthenticated) {
      // Get the intended destination from localStorage (set before login)
      const returnTo = localStorage.getItem('auth0_returnTo');
      localStorage.removeItem('auth0_returnTo');

      // Navigate to the intended page
      if (returnTo && returnTo !== '/') {
        navigate(returnTo, { replace: true });
      } else {
        // Clean up the URL by removing auth params
        navigate(location.pathname, { replace: true });
      }
    }
  }, [isAuthenticated, isLoading, location, navigate]);

  return null;
}

function App() {
  return (
    <ApiKeyProvider>
      <Auth0RedirectHandler />
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
