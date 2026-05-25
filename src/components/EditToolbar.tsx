import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ToCData, Node as GraphNode } from '../types';
import {
  ShareIcon,
  AdjustmentsHorizontalIcon,
  EyeIcon,
  PencilIcon,
  ChevronDownIcon,
  TrashIcon,
  MinusIcon,
  PlusIcon,
  QuestionMarkCircleIcon,
  ClockIcon,
  Bars3Icon,
} from '@heroicons/react/24/outline';
import { ChartService, CreateChartResponse, UserChart } from '../services/chartService';
import { shortcuts } from '../utils/keyboardShortcuts';
import { Tooltip } from 'react-tooltip';
import { useAuth0 } from '@auth0/auth0-react';
import { useNavigate } from 'react-router-dom';
import { clearChartSpend } from '../utils/byokSpend';

interface EditToolbarProps {
  editMode: boolean;
  setEditMode: React.Dispatch<React.SetStateAction<boolean>>;
  showEditButton: boolean;
  highlightedNodes: Set<string>;
  setHighlightedNodes: React.Dispatch<React.SetStateAction<Set<string>>>;
  layoutMode: boolean;
  setLayoutMode: React.Dispatch<React.SetStateAction<boolean>>;
  curvature: number;
  setCurvature: React.Dispatch<React.SetStateAction<number>>;
  textSize: number;
  setTextSize: React.Dispatch<React.SetStateAction<number>>;
  fontFamily: string;
  setFontFamily: React.Dispatch<React.SetStateAction<string>>;
  nodeWidth: number;
  setNodeWidth: React.Dispatch<React.SetStateAction<number>>;
  nodeColor: string;
  setNodeColor: React.Dispatch<React.SetStateAction<string>>;
  columnPadding: number;
  setColumnPadding: React.Dispatch<React.SetStateAction<number>>;
  sectionPadding: number;
  setSectionPadding: React.Dispatch<React.SetStateAction<number>>;
  straightenEdges: () => void;
  setData: React.Dispatch<React.SetStateAction<ToCData>>;
  // Header controls props
  undoHistory: ToCData[];
  redoHistory: ToCData[];
  handleUndo: () => void;
  handleRedo: () => void;
  isSaving: boolean;
  currentEditToken: string | null;
  lastSyncTime: Date | null;
  isManualSyncing: boolean;
  handleManualSync: () => void;
  getTimeAgo: (date: Date) => string;
  data: ToCData;
  onDeleteNode?: (nodeId: string) => void;
  nodePopup?: unknown;
  edgePopup?: unknown;
  // Camera props for toolbar positioning
  camera?: { x: number; y: number; z: number };
  // Callback to notify parent when chart is created/saved
  onChartCreated?: (token: string, chartId: string) => void;
  // Container size for embed code generation
  containerSize?: { width: number; height: number };
}

export function EditToolbar({
  editMode,
  setEditMode,
  showEditButton,
  highlightedNodes,
  setHighlightedNodes,
  layoutMode,
  setLayoutMode,
  curvature,
  setCurvature,
  textSize,
  setTextSize,
  fontFamily,
  setFontFamily,
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
  isSaving,
  currentEditToken,
  lastSyncTime,
  isManualSyncing,
  handleManualSync,
  getTimeAgo,
  data,
  onDeleteNode,
  nodePopup,
  edgePopup,
  camera,
  onChartCreated,
  containerSize,
}: EditToolbarProps) {
  const [showWidthDropdown, setShowWidthDropdown] = useState(false);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [showShareDropdown, setShowShareDropdown] = useState(false);
  const [showRecentDropdown, setShowRecentDropdown] = useState(false);
  const [showAlignmentSuggestion, setShowAlignmentSuggestion] = useState(false);
  const [showHelpModal, setShowHelpModal] = useState(false);
  const [toolbarPosition, setToolbarPosition] = useState({ x: 0, y: 0 });
  const [recentCharts, setRecentCharts] = useState<UserChart[]>([]);
  const [loadingRecentCharts, setLoadingRecentCharts] = useState(false);

  // Auth0 hook
  const { user, isAuthenticated, isLoading: authLoading } = useAuth0();
  const navigate = useNavigate();

  // Tooltip state
  const [showLayoutTooltip, setShowLayoutTooltip] = useState(true);

  // Mobile menu state
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);

  // Share functionality state
  const [shareData, setShareData] = useState<CreateChartResponse | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  // Whether the signed-in user owns the current chart. Comes from the server's
  // getChart response (verified against the JWT sub). Gates the
  // managePermissions fetches below so we don't spam 403s for non-owned
  // charts. Anonymous/view-only: always false.
  const [isOwner, setIsOwner] = useState(false);

  // Permission management state
  const [showPermissionsSection, setShowPermissionsSection] = useState(false);
  const [permissions, setPermissions] = useState<
    Array<{
      user_id: string;
      user_email: string;
      permission_level: string;
      status?: string;
      granted_at: string;
    }>
  >([]);
  const [loadingPermissions, setLoadingPermissions] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [linkSharingLevel, setLinkSharingLevel] = useState<'restricted' | 'viewer' | 'editor'>(
    'restricted',
  );
  const [showGeneralAccessDropdown, setShowGeneralAccessDropdown] = useState(false);

  const dropdownRef = useRef<HTMLDivElement>(null);
  const modeDropdownRef = useRef<HTMLDivElement>(null);
  const shareDropdownRef = useRef<HTMLDivElement>(null);
  const recentDropdownRef = useRef<HTMLDivElement>(null);
  const generalAccessDropdownRef = useRef<HTMLDivElement>(null);
  const prevHighlightedNodesRef = useRef<Set<string>>(new Set());
  const hasAutoGeneratedRef = useRef(false);

  // Load recent charts from API (for authenticated users) or localStorage (for anonymous)
  const loadRecentCharts = useCallback(async () => {
    if (!isAuthenticated || !user?.sub) {
      // For anonymous users, still use localStorage
      try {
        const stored = localStorage.getItem('recentEditCharts');
        if (stored) {
          interface StoredRecentChart {
            chartId?: string;
            title?: string;
            editUrl: string;
            timestamp: number;
          }
          const charts = JSON.parse(stored) as StoredRecentChart[];
          charts.sort((a, b) => b.timestamp - a.timestamp);
          // Map to UserChart format
          const mappedCharts: UserChart[] = charts.slice(0, 10).map((c) => ({
            chartId: c.chartId || '',
            title: c.title || 'Theory of Change',
            editUrl: c.editUrl,
            viewUrl: '',
            updatedAt: new Date(c.timestamp).toISOString(),
            createdAt: new Date(c.timestamp).toISOString(),
            permissionLevel: 'owner' as const,
          }));
          setRecentCharts(mappedCharts);
        }
      } catch (error) {
        console.error('Failed to load recent charts from localStorage:', error);
      }
      return;
    }

    // For authenticated users, fetch from API
    setLoadingRecentCharts(true);
    try {
      const charts = await ChartService.getUserCharts(user.sub);
      setRecentCharts(charts);
    } catch (error) {
      console.error('Failed to load user charts:', error);
    } finally {
      setLoadingRecentCharts(false);
    }
  }, [isAuthenticated, user?.sub]);

  // Load recent charts when component mounts or dropdown opens
  useEffect(() => {
    if (showRecentDropdown) {
      loadRecentCharts();
    }
  }, [showRecentDropdown, loadRecentCharts]);

  // Smart detection for misaligned nodes
  const detectMisalignedNodes = useCallback((): boolean => {
    if (!editMode) return false;

    const allNodes: { node: GraphNode; centerY: number }[] = [];

    // Collect all nodes with their Y positions
    data.sections.forEach((section) => {
      section.columns.forEach((column) => {
        column.nodes.forEach((node) => {
          const centerY = node.yPosition ?? 0;
          allNodes.push({ node, centerY });
        });
      });
    });

    if (allNodes.length < 2) return false;

    // Group nodes by similar Y positions (within tolerance)
    const tolerance = 40; // Same as straightenEdges function
    const groups: (typeof allNodes)[] = [];

    allNodes.forEach((nodeData) => {
      let addedToGroup = false;
      for (const group of groups) {
        const avgCenterY = group.reduce((sum, n) => sum + n.centerY, 0) / group.length;
        if (Math.abs(nodeData.centerY - avgCenterY) <= tolerance) {
          group.push(nodeData);
          addedToGroup = true;
          break;
        }
      }
      if (!addedToGroup) {
        groups.push([nodeData]);
      }
    });

    // Find misaligned groups
    const misalignedGroups = groups.filter((group) => {
      if (group.length < 2) return false;
      const positions = group.map((n) => n.centerY);
      const min = Math.min(...positions);
      const max = Math.max(...positions);
      return max - min > 0; // Any difference = misaligned
    });

    return misalignedGroups.length > 0;
  }, [editMode, data]);

  // Share functionality functions
  const loadExistingShareData = useCallback(async () => {
    if (!currentEditToken) return;

    setShareLoading(true);
    setShareError(null);

    try {
      // Use the full getChart response so we can pick up isOwner alongside
      // chartId in a single round trip. The chartId-only helper used to fire
      // here dropped the rest of the payload on the floor.
      const result = await ChartService.getChartByEditToken(currentEditToken);
      setIsOwner(Boolean(result.isOwner));
      setShareData({
        chartId: result.chartId,
        editToken: currentEditToken,
        viewUrl: `${window.location.origin}/chart/${result.chartId}`,
        editUrl: `${window.location.origin}/edit/${currentEditToken}`,
      });
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Failed to load share data');
    } finally {
      setShareLoading(false);
    }
  }, [currentEditToken]);

  const handleShare = useCallback(async () => {
    setShareLoading(true);
    setShareError(null);

    try {
      // If we already have an edit token, just update; otherwise create new
      if (currentEditToken) {
        await ChartService.updateChart(currentEditToken, data);
        // Fetch the full getChart result so we can pick up isOwner; the
        // chartId-only helper (getChartIdFromEditToken) used to throw away
        // the rest.
        const result = await ChartService.getChartByEditToken(currentEditToken);
        setIsOwner(Boolean(result.isOwner));
        setShareData({
          chartId: result.chartId,
          editToken: currentEditToken,
          viewUrl: `${window.location.origin}/chart/${result.chartId}`,
          editUrl: `${window.location.origin}/edit/${currentEditToken}`,
        });
      } else {
        // Create chart - auth token is sent automatically by ChartService.
        // An authenticated caller owns the freshly-created chart (see
        // worker/api/createChart.ts). Anonymous charts have no owner, so
        // nobody is "the owner" and permissions stay hidden.
        const response = await ChartService.createChart(data);
        setIsOwner(isAuthenticated);
        setShareData(response);
        // Store the edit token locally
        ChartService.saveEditToken(response.chartId, response.editToken);

        // For anonymous users, also save to recent charts localStorage
        if (!isAuthenticated) {
          const stored = localStorage.getItem('recentEditCharts');
          const charts = stored ? JSON.parse(stored) : [];

          // Add this chart to recent charts
          charts.unshift({
            chartId: response.chartId,
            title: data.title || 'Theory of Change',
            editUrl: response.editUrl,
            timestamp: Date.now(),
          });

          // Keep only the 10 most recent
          const recentCharts = charts.slice(0, 10);
          localStorage.setItem('recentEditCharts', JSON.stringify(recentCharts));
        }

        // Update the URL to the edit URL. Use navigate (not raw
        // replaceState) so React Router's useParams()/useLocation() pick
        // up the new editToken — otherwise the per-chart localStorage
        // keys (chat history, etc.) stay stuck at their pre-navigation
        // values until a full reload.
        //
        // state.skipChartReload tells App.tsx's load effect not to re-fetch
        // the chart we just created — the data is already in memory and
        // re-fetching produces a visible UI flash ("looks like a refresh")
        // after the URL change. Mirrors ChatInterface's ensureChartExists.
        navigate(`/edit/${response.editToken}`, {
          replace: true,
          state: { skipChartReload: true },
        });
        // Notify parent component about the new chart
        if (onChartCreated) {
          onChartCreated(response.editToken, response.chartId);
        }
      }
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Failed to share chart');
    } finally {
      setShareLoading(false);
    }
  }, [currentEditToken, data, isAuthenticated, navigate, onChartCreated]);

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Load permissions for the current chart. Only fires when the caller is
  // the verified owner — managePermissions returns 403 for anyone else, and
  // calling it on a polling schedule for non-owned charts used to spam 300+
  // identical 403s per session.
  const loadPermissions = useCallback(async () => {
    if (!shareData?.chartId || !isAuthenticated || !isOwner) return;

    setLoadingPermissions(true);
    setPermissionError(null);
    try {
      const result = await ChartService.getChartPermissions(shareData.chartId);
      setPermissions(result.permissions || result); // Handle both new and old response format
      if (result.linkSharingLevel) {
        setLinkSharingLevel(result.linkSharingLevel);
      }
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to load permissions');
    } finally {
      setLoadingPermissions(false);
    }
  }, [shareData?.chartId, isAuthenticated, isOwner]);

  // Update user's permission level
  const handleUpdatePermission = async (targetUserId: string, newLevel: 'owner' | 'edit') => {
    if (!shareData?.chartId || !isAuthenticated) return;

    setPermissionError(null);
    try {
      await ChartService.updatePermissionLevel(shareData.chartId, targetUserId, newLevel);
      await loadPermissions();
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to update permission');
    }
  };

  // Remove permission from a user
  const handleRemovePermission = async (targetUserId: string) => {
    if (!shareData?.chartId || !isAuthenticated) return;

    setPermissionError(null);
    try {
      await ChartService.removePermission(shareData.chartId, targetUserId);
      await loadPermissions();
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to remove permission');
    }
  };

  // Update link sharing settings
  const handleUpdateLinkSharing = async (newLevel: 'restricted' | 'viewer' | 'editor') => {
    if (!shareData?.chartId || !isAuthenticated) return;

    setPermissionError(null);
    try {
      await ChartService.updateLinkSharing(shareData.chartId, newLevel);
      setLinkSharingLevel(newLevel);
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to update link sharing');
    }
  };

  // Approve access request
  const handleApproveAccess = async (targetUserId: string) => {
    if (!shareData?.chartId || !isAuthenticated) return;

    setPermissionError(null);
    try {
      await ChartService.approveAccessRequest(shareData.chartId, targetUserId);
      await loadPermissions();
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to approve access');
    }
  };

  // Reject access request
  const handleRejectAccess = async (targetUserId: string) => {
    if (!shareData?.chartId || !isAuthenticated) return;

    setPermissionError(null);
    try {
      await ChartService.rejectAccessRequest(shareData.chartId, targetUserId);
      await loadPermissions();
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to reject access');
    }
  };

  // Delete chart
  const handleDeleteChart = async (chartId: string) => {
    try {
      await ChartService.deleteChart(chartId, currentEditToken ?? undefined);
      // Remove the BYOK spend counter for this chart so it doesn't leak into
      // localStorage forever. The key-lifetime counter is unaffected — the
      // user's total for their key persists across chart deletions.
      clearChartSpend(chartId);

      // For anonymous users, remove from localStorage
      if (!isAuthenticated) {
        const stored = localStorage.getItem('recentEditCharts');
        if (stored) {
          const charts = JSON.parse(stored) as { chartId?: string }[];
          // Filter out the deleted chart by chartId
          const filtered = charts.filter((c) => c.chartId !== chartId);
          localStorage.setItem('recentEditCharts', JSON.stringify(filtered));
        }
        // Reload the recent charts list
        await loadRecentCharts();
      } else {
        // For authenticated users, reload recent charts from API
        await loadRecentCharts();
      }

      // If we deleted the current chart, redirect to home
      if (shareData?.chartId === chartId) {
        window.location.href = '/';
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete chart');
    }
  };

  // Load permissions when share dropdown is shown. Gated on isOwner so we
  // don't fire managePermissions against charts the caller doesn't own (the
  // previous comment said "to check if user is owner", but we now know
  // ownership cheaply from the getChart response and don't need to burn an
  // owner-only endpoint to discover it).
  useEffect(() => {
    if (showShareDropdown && shareData?.chartId && isAuthenticated && isOwner) {
      loadPermissions();
    }
  }, [showShareDropdown, shareData?.chartId, isAuthenticated, isOwner, loadPermissions]);

  // Load permissions periodically to check for pending requests (for
  // notification badge). Two guardrails:
  //
  // 1. Only polls when `isOwner === true` — managePermissions 403s for
  //    everyone else, and pre-fix this fired ~300 times per session on
  //    non-owned charts. For non-owners we still need the chartId for the
  //    rest of the share panel, so we fetch it via getChartByEditToken
  //    and bail before touching managePermissions.
  //
  // 2. Depends on `shareData?.chartId`, not the full `shareData` reference.
  //    Every sync tick (or any other setShareData call with an otherwise-
  //    equivalent payload) used to remount this effect and restart the
  //    whole bootstrap cycle, which is how the 403s accumulated in the
  //    first place.
  useEffect(() => {
    if (!currentEditToken || !isAuthenticated) return;

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const stopInterval = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const fetchPermissions = async (chartId: string) => {
      try {
        const result = await ChartService.getChartPermissions(chartId);
        if (cancelled) return;
        setPermissions(result.permissions || result);
        if (result.linkSharingLevel) {
          setLinkSharingLevel(result.linkSharingLevel);
        }
      } catch (err) {
        // Belt-and-suspenders: isOwner gating should prevent 403s entirely,
        // but if we hit one (e.g. ownership changed server-side mid-session)
        // stop polling rather than loop.
        console.error('Failed to poll permissions (stopping poll):', err);
        stopInterval();
      }
    };

    if (!shareData?.chartId) {
      // Bootstrap path: we have an edit token but don't know the chartId
      // or isOwner yet. Fetch the chart once so we can decide whether to
      // poll. For non-owners this is the only network call — no
      // managePermissions fetch fires at all.
      void (async () => {
        try {
          const result = await ChartService.getChartByEditToken(currentEditToken);
          if (cancelled) return;
          setIsOwner(Boolean(result.isOwner));
          setShareData({
            chartId: result.chartId,
            editToken: currentEditToken,
            viewUrl: `${window.location.origin}/chart/${result.chartId}`,
            editUrl: `${window.location.origin}/edit/${currentEditToken}`,
          });
          // State updates will re-run this effect with the fresh
          // chartId/isOwner; the arming branch below takes it from there.
        } catch (err) {
          console.error('Failed to bootstrap permissions poll:', err);
        }
      })();
    } else if (isOwner) {
      // chartId + ownership known: fetch permissions once immediately, then
      // poll every 30s. Anyone who isn't the owner simply never reaches
      // this branch.
      fetchPermissions(shareData.chartId);
      interval = setInterval(() => {
        fetchPermissions(shareData.chartId);
      }, 30000);
    }

    return () => {
      cancelled = true;
      stopInterval();
    };
  }, [currentEditToken, isAuthenticated, isOwner, shareData?.chartId]);

  // Auto-expand permissions section if there are pending requests
  useEffect(() => {
    if (showShareDropdown && permissions.filter((p) => p.status === 'pending').length > 0) {
      setShowPermissionsSection(true);
    }
  }, [showShareDropdown, permissions]);

  // Update/add localStorage entry for anonymous users (when title changes or chart is accessed)
  useEffect(() => {
    if (!isAuthenticated && currentEditToken && shareData?.chartId) {
      const stored = localStorage.getItem('recentEditCharts');
      interface StoredRecentChartEntry {
        chartId: string;
        title: string;
        editUrl: string;
        timestamp: number;
      }
      const charts: StoredRecentChartEntry[] = stored ? JSON.parse(stored) : [];
      const chartIndex = charts.findIndex((c) => c.chartId === shareData.chartId);

      const newTitle = data.title || 'Theory of Change';
      const editUrl = shareData.editUrl || `${window.location.origin}/edit/${currentEditToken}`;

      if (chartIndex !== -1) {
        // Update existing entry
        charts[chartIndex].title = newTitle;
        charts[chartIndex].timestamp = Date.now();
      } else {
        // Add new entry if this chart isn't in localStorage yet
        charts.unshift({
          chartId: shareData.chartId,
          title: newTitle,
          editUrl: editUrl,
          timestamp: Date.now(),
        });
      }

      // Keep only the 10 most recent
      const recentCharts = charts.slice(0, 10);
      localStorage.setItem('recentEditCharts', JSON.stringify(recentCharts));
    }
  }, [data.title, isAuthenticated, currentEditToken, shareData?.chartId, shareData?.editUrl]);

  // Check for misalignment when data changes
  useEffect(() => {
    const hasMisaligned = detectMisalignedNodes();
    if (editMode && hasMisaligned) {
      setShowAlignmentSuggestion(true);
    } else {
      setShowAlignmentSuggestion(false);
    }
  }, [editMode, detectMisalignedNodes]);

  // Auto-generate share links on first edit (without opening dropdown)
  // Wait for auth to complete to ensure proper user association
  useEffect(() => {
    // Only auto-generate after:
    // 1. Auth has finished loading
    // 2. We don't already have an edit token
    // 3. We haven't already auto-generated
    // 4. User has made an edit (undo history exists)
    if (
      !authLoading &&
      !currentEditToken &&
      !hasAutoGeneratedRef.current &&
      undoHistory.length > 0
    ) {
      // Add a small delay to ensure the token has been set on ChartService
      // The token setting happens in App.tsx's useEffect which runs around the same time
      const timer = setTimeout(() => {
        hasAutoGeneratedRef.current = true;
        console.log(
          'Auto-generating share links. Authenticated:',
          isAuthenticated,
          'User:',
          user?.sub,
        );
        handleShare();
      }, 100); // 100ms delay to ensure token is set

      return () => clearTimeout(timer);
    }
  }, [currentEditToken, undoHistory.length, authLoading, isAuthenticated, user, handleShare]);

  // Keep refs to the latest handleShare / loadExistingShareData so the
  // auto-generate-on-open effect doesn't have to list them as deps. Both
  // callbacks close over `data` (handleShare forwards it to createChart/
  // updateChart), so their identity churns on every keystroke. If the
  // effect below were keyed on them, every edit would re-fire the effect
  // while the dropdown is closed, hit the close branch, null out shareData,
  // and cascade into a fresh getChartByEditToken from the polling effect —
  // a ~10s background /api/getChart loop for no user-visible reason.
  const handleShareRef = useRef(handleShare);
  useEffect(() => {
    handleShareRef.current = handleShare;
  });
  const loadExistingShareDataRef = useRef(loadExistingShareData);
  useEffect(() => {
    loadExistingShareDataRef.current = loadExistingShareData;
  });

  // Auto-generate or load share data when dropdown opens. Don't reset
  // shareData on close: the permissions-poll bootstrap effect re-fills it
  // for owners regardless of dropdown state, and a "reset on close" branch
  // here was producing a tight loop with that bootstrap (~400ms cadence,
  // visible as a getChart spam after login). Stale shareData is fine — it's
  // overwritten on the next open via loadExistingShareData.
  useEffect(() => {
    if (showShareDropdown && !shareData && !shareLoading) {
      if (currentEditToken) {
        void loadExistingShareDataRef.current();
      } else {
        void handleShareRef.current();
      }
    }
  }, [showShareDropdown, shareData, shareLoading, currentEditToken]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowWidthDropdown(false);
      }
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(event.target as Node)) {
        setShowModeDropdown(false);
      }
      if (shareDropdownRef.current && !shareDropdownRef.current.contains(event.target as Node)) {
        setShowShareDropdown(false);
      }
      if (recentDropdownRef.current && !recentDropdownRef.current.contains(event.target as Node)) {
        setShowRecentDropdown(false);
      }
      if (
        generalAccessDropdownRef.current &&
        !generalAccessDropdownRef.current.contains(event.target as Node)
      ) {
        setShowGeneralAccessDropdown(false);
      }
      if (mobileMenuRef.current && !mobileMenuRef.current.contains(event.target as Node)) {
        setShowMobileMenu(false);
      }
    };

    if (
      showWidthDropdown ||
      showModeDropdown ||
      showShareDropdown ||
      showRecentDropdown ||
      showGeneralAccessDropdown ||
      showMobileMenu
    ) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [
    showWidthDropdown,
    showModeDropdown,
    showShareDropdown,
    showRecentDropdown,
    showGeneralAccessDropdown,
    showMobileMenu,
  ]);

  // Update toolbar position when selection changes or camera changes
  useEffect(() => {
    if (highlightedNodes.size === 0) return;

    // Calculate new position
    const nodeElements = Array.from(highlightedNodes)
      .map((nodeId) => document.getElementById(`node-${nodeId}`))
      .filter((el): el is HTMLElement => el !== null);

    if (nodeElements.length > 0) {
      const rects = nodeElements.map((el) => el.getBoundingClientRect());
      const avgX = rects.reduce((sum, rect) => sum + rect.left + rect.width / 2, 0) / rects.length;
      const topY = Math.min(...rects.map((rect) => rect.top));

      setToolbarPosition({ x: avgX, y: topY - 80 });
    }

    prevHighlightedNodesRef.current = new Set(highlightedNodes);
  }, [highlightedNodes, camera?.x, camera?.y, camera?.z]);

  if (!showEditButton) return null;

  return (
    <>
      <div className="fixed top-0 left-0 right-0 z-50 bg-white border-b border-gray-300 shadow-sm">
        <div className="max-w-none mx-auto py-2 px-2 sm:px-4" style={{ maxWidth: '100%' }}>
          <div className="flex items-center justify-between gap-2">
            {/* Left side - Header controls and main tools */}
            <div className="flex items-center gap-1 sm:gap-4 flex-shrink-0">
              {/* Open Dropdown - Far Left */}
              <div className="relative" ref={recentDropdownRef}>
                <button
                  onClick={() => setShowRecentDropdown(!showRecentDropdown)}
                  className="px-2 sm:px-3 py-2 text-gray-600 hover:bg-gray-100 text-sm font-medium rounded transition-all duration-200 flex items-center gap-1 sm:gap-2"
                  title="Open charts"
                >
                  <ClockIcon className="w-4 h-4" />
                  <span className="hidden sm:inline">Open</span>
                  <ChevronDownIcon className="w-3 h-3" />
                </button>

                {/* Charts Dropdown */}
                {showRecentDropdown && (
                  <div className="absolute top-full mt-2 left-0 w-[calc(100vw-1rem)] sm:w-96 max-w-96 bg-white rounded-lg shadow-lg border border-gray-200 z-50 max-h-[80vh] overflow-y-auto">
                    <div className="p-2">
                      {/* New Chart Card - Always visible at top */}
                      <a
                        href="/"
                        className="group flex items-start gap-3 px-3 py-2 rounded text-sm transition-colors hover:bg-green-50 border-2 border-dashed border-green-300 hover:border-green-400 mb-3"
                      >
                        <div className="flex items-center justify-center w-10 h-10 bg-green-100 text-green-600 rounded flex-shrink-0 group-hover:bg-green-200">
                          <PlusIcon className="w-6 h-6" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-green-700 group-hover:text-green-800">
                            Create New Chart
                          </div>
                          <div className="text-xs text-green-600 mt-0.5">Start from scratch</div>
                        </div>
                      </a>

                      {loadingRecentCharts ? (
                        <div className="px-3 py-4 text-sm text-gray-500 text-center border-t border-gray-200 pt-4">
                          <div className="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-gray-600 mb-2"></div>
                          <p>Loading your charts...</p>
                        </div>
                      ) : recentCharts.length === 0 ? (
                        <div className="px-3 py-4 text-sm text-gray-600 text-center border-t border-gray-200 pt-4">
                          {!isAuthenticated ? (
                            <>
                              <p className="mb-2">Sign in to see your charts across devices</p>
                              <p className="text-xs text-gray-500">No local charts found</p>
                            </>
                          ) : (
                            <p>No saved charts yet</p>
                          )}
                        </div>
                      ) : (
                        <div className="border-t border-gray-200 pt-2">
                          <div className="px-3 py-1 text-xs font-medium text-gray-500 uppercase tracking-wider flex items-center justify-between">
                            <span>Recent Charts</span>
                            {!isAuthenticated && (
                              <span className="text-xs font-normal text-gray-400 normal-case">
                                (Stored locally)
                              </span>
                            )}
                          </div>
                          <div className="space-y-1 mt-1">
                            {recentCharts.map((chart, index) => {
                              const isCurrentChart =
                                chart.editUrl ===
                                `${window.location.origin}/edit/${currentEditToken}`;
                              return (
                                <div
                                  key={chart.chartId || index}
                                  className={`group flex items-start gap-2 px-3 py-2 rounded text-sm transition-colors ${
                                    isCurrentChart ? 'bg-blue-50' : 'hover:bg-gray-100'
                                  }`}
                                >
                                  <a
                                    href={chart.editUrl}
                                    onClick={(e) => {
                                      if (isCurrentChart) {
                                        e.preventDefault();
                                        setShowRecentDropdown(false);
                                      }
                                    }}
                                    className={`flex-1 min-w-0 ${
                                      isCurrentChart
                                        ? 'text-blue-700 cursor-default'
                                        : 'text-gray-700'
                                    }`}
                                  >
                                    <div className="font-medium truncate">{chart.title}</div>
                                    <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
                                      <span>
                                        {new Date(chart.updatedAt).toLocaleDateString()} at{' '}
                                        {new Date(chart.updatedAt).toLocaleTimeString([], {
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </span>
                                      {isCurrentChart && (
                                        <span className="text-blue-600">(Current)</span>
                                      )}
                                      {chart.permissionLevel === 'edit' && (
                                        <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-xs">
                                          Shared
                                        </span>
                                      )}
                                    </div>
                                  </a>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Separator - hidden on mobile */}
              <div className="h-6 w-px bg-gray-300 hidden sm:block"></div>

              {/* Undo/Redo Group */}
              <div className="flex items-center gap-1 sm:gap-2">
                <span className="text-xs text-gray-500 hidden md:inline">
                  ({undoHistory.length})
                </span>
                <button
                  onClick={handleUndo}
                  disabled={undoHistory.length === 0}
                  className="p-1.5 sm:p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200"
                  title={`Undo (${shortcuts.undoDisplay()})`}
                >
                  <svg
                    className="w-4 h-4 sm:w-5 sm:h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
                    />
                  </svg>
                </button>
                <button
                  onClick={handleRedo}
                  disabled={redoHistory.length === 0}
                  className="p-1.5 sm:p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200"
                  title={`Redo (${shortcuts.redoDisplay()})`}
                >
                  <svg
                    className="w-4 h-4 sm:w-5 sm:h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M21 10H11a8 8 0 00-8 8v2m18-10l-6 6m6-6l-6-6"
                    />
                  </svg>
                </button>
                <span className="text-xs text-gray-500 hidden md:inline">
                  ({redoHistory.length})
                </span>
              </div>

              {/* Separator - hidden on mobile */}
              <div className="h-6 w-px bg-gray-300 mx-1 hidden md:block"></div>

              {/* Edit Tools - Hidden on mobile, shown on md+ */}
              <div className="hidden md:flex items-center gap-1">
                <button
                  onClick={() => editMode && setLayoutMode(!layoutMode)}
                  disabled={!editMode}
                  data-tooltip-id="layout-mode-tooltip"
                  className={`p-2 rounded transition-all duration-200 ${
                    !editMode
                      ? 'text-gray-400 cursor-not-allowed'
                      : layoutMode
                        ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-800'
                  }`}
                  title={`Layout Mode: ${layoutMode ? 'On' : 'Off'}`}
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
                    />
                  </svg>
                </button>

                {/* Text Size Control - Google Drive Style - Hidden on smaller screens */}
                <div
                  className={`hidden lg:flex items-center gap-1 px-1 py-1 rounded transition-colors ${
                    editMode ? 'hover:bg-gray-100' : 'opacity-50 cursor-not-allowed'
                  }`}
                >
                  <button
                    onClick={() => {
                      if (!editMode) return;
                      const currentPx = Math.round(textSize * 18);
                      const newPx = Math.max(9, currentPx - 1);
                      setTextSize(newPx / 18);
                    }}
                    disabled={!editMode}
                    className={`p-1 rounded transition-colors ${
                      editMode ? 'hover:bg-gray-200' : 'cursor-not-allowed'
                    }`}
                    title="Decrease text size"
                  >
                    <MinusIcon className="w-4 h-4 text-gray-600" />
                  </button>
                  <input
                    type="number"
                    value={Math.round(textSize * 18)}
                    onChange={(e) => {
                      if (!editMode) return;
                      const px = parseInt(e.target.value) || 18;
                      const clampedPx = Math.max(9, Math.min(36, px));
                      setTextSize(clampedPx / 18);
                    }}
                    disabled={!editMode}
                    className="w-10 text-sm text-gray-700 font-medium text-center border-0 focus:outline-none focus:ring-1 focus:ring-blue-500 rounded [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none disabled:cursor-not-allowed"
                    min="9"
                    max="36"
                  />
                  <button
                    onClick={() => {
                      if (!editMode) return;
                      const currentPx = Math.round(textSize * 18);
                      const newPx = Math.min(36, currentPx + 1);
                      setTextSize(newPx / 18);
                    }}
                    disabled={!editMode}
                    className={`p-1 rounded transition-colors ${
                      editMode ? 'hover:bg-gray-200' : 'cursor-not-allowed'
                    }`}
                    title="Increase text size"
                  >
                    <PlusIcon className="w-4 h-4 text-gray-600" />
                  </button>
                </div>

                {/* Font Family Dropdown - Hidden on smaller screens */}
                <div
                  className={`hidden xl:flex items-center gap-1 px-2 rounded transition-colors ${
                    editMode ? 'hover:bg-gray-100' : 'opacity-50 cursor-not-allowed'
                  }`}
                >
                  <select
                    value={fontFamily}
                    onChange={(e) => {
                      if (!editMode) return;
                      setFontFamily(e.target.value);
                    }}
                    disabled={!editMode}
                    className="text-sm text-gray-700 border-0 focus:outline-none focus:ring-1 focus:ring-blue-500 rounded px-1 disabled:cursor-not-allowed bg-transparent max-w-[110px]"
                    style={{ fontFamily: fontFamily }}
                    title="Font family"
                  >
                    <option
                      value="'Roboto', sans-serif"
                      style={{ fontFamily: "'Roboto', sans-serif" }}
                    >
                      Roboto
                    </option>
                    <option
                      value="'Open Sans', sans-serif"
                      style={{ fontFamily: "'Open Sans', sans-serif" }}
                    >
                      Open Sans
                    </option>
                    <option value="'Lato', sans-serif" style={{ fontFamily: "'Lato', sans-serif" }}>
                      Lato
                    </option>
                    <option
                      value="'Montserrat', sans-serif"
                      style={{ fontFamily: "'Montserrat', sans-serif" }}
                    >
                      Montserrat
                    </option>
                    <option
                      value="'Oswald', sans-serif"
                      style={{ fontFamily: "'Oswald', sans-serif" }}
                    >
                      Oswald
                    </option>
                    <option
                      value="'Source Sans Pro', sans-serif"
                      style={{ fontFamily: "'Source Sans Pro', sans-serif" }}
                    >
                      Source Sans Pro
                    </option>
                    <option
                      value="'Raleway', sans-serif"
                      style={{ fontFamily: "'Raleway', sans-serif" }}
                    >
                      Raleway
                    </option>
                    <option
                      value="'Poppins', sans-serif"
                      style={{ fontFamily: "'Poppins', sans-serif" }}
                    >
                      Poppins
                    </option>
                    <option
                      value="'Merriweather', serif"
                      style={{ fontFamily: "'Merriweather', serif" }}
                    >
                      Merriweather
                    </option>
                    <option
                      value="'PT Sans', sans-serif"
                      style={{ fontFamily: "'PT Sans', sans-serif" }}
                    >
                      PT Sans
                    </option>
                    <option
                      value="'Ubuntu', sans-serif"
                      style={{ fontFamily: "'Ubuntu', sans-serif" }}
                    >
                      Ubuntu
                    </option>
                    <option
                      value="'Playfair Display', serif"
                      style={{ fontFamily: "'Playfair Display', serif" }}
                    >
                      Playfair Display
                    </option>
                    <option
                      value="'Noto Sans', sans-serif"
                      style={{ fontFamily: "'Noto Sans', sans-serif" }}
                    >
                      Noto Sans
                    </option>
                    <option
                      value="'Nunito', sans-serif"
                      style={{ fontFamily: "'Nunito', sans-serif" }}
                    >
                      Nunito
                    </option>
                    <option
                      value="'Mukta', sans-serif"
                      style={{ fontFamily: "'Mukta', sans-serif" }}
                    >
                      Mukta
                    </option>
                    <option
                      value="'Rubik', sans-serif"
                      style={{ fontFamily: "'Rubik', sans-serif" }}
                    >
                      Rubik
                    </option>
                    <option
                      value="'Work Sans', sans-serif"
                      style={{ fontFamily: "'Work Sans', sans-serif" }}
                    >
                      Work Sans
                    </option>
                    <option value="'Lora', serif" style={{ fontFamily: "'Lora', serif" }}>
                      Lora
                    </option>
                    <option
                      value="'Noto Serif', serif"
                      style={{ fontFamily: "'Noto Serif', serif" }}
                    >
                      Noto Serif
                    </option>
                    <option
                      value="'Roboto Condensed', sans-serif"
                      style={{ fontFamily: "'Roboto Condensed', sans-serif" }}
                    >
                      Roboto Condensed
                    </option>
                    <option value="'PT Serif', serif" style={{ fontFamily: "'PT Serif', serif" }}>
                      PT Serif
                    </option>
                    <option
                      value="'Quicksand', sans-serif"
                      style={{ fontFamily: "'Quicksand', sans-serif" }}
                    >
                      Quicksand
                    </option>
                    <option
                      value="'Roboto Slab', serif"
                      style={{ fontFamily: "'Roboto Slab', serif" }}
                    >
                      Roboto Slab
                    </option>
                    <option
                      value="'Oxygen', sans-serif"
                      style={{ fontFamily: "'Oxygen', sans-serif" }}
                    >
                      Oxygen
                    </option>
                    <option
                      value="'Slabo 27px', serif"
                      style={{ fontFamily: "'Slabo 27px', serif" }}
                    >
                      Slabo 27px
                    </option>
                    <option
                      value="'Fira Sans', sans-serif"
                      style={{ fontFamily: "'Fira Sans', sans-serif" }}
                    >
                      Fira Sans
                    </option>
                    <option
                      value="'Karla', sans-serif"
                      style={{ fontFamily: "'Karla', sans-serif" }}
                    >
                      Karla
                    </option>
                    <option
                      value="'Titillium Web', sans-serif"
                      style={{ fontFamily: "'Titillium Web', sans-serif" }}
                    >
                      Titillium Web
                    </option>
                    <option
                      value="'Arimo', sans-serif"
                      style={{ fontFamily: "'Arimo', sans-serif" }}
                    >
                      Arimo
                    </option>
                    <option
                      value="'Cabin', sans-serif"
                      style={{ fontFamily: "'Cabin', sans-serif" }}
                    >
                      Cabin
                    </option>
                  </select>
                </div>

                {/* More Tools Dropdown */}
                <div className="relative" ref={dropdownRef}>
                  <button
                    onClick={() => editMode && setShowWidthDropdown(!showWidthDropdown)}
                    disabled={!editMode}
                    className={`p-2 rounded transition-all duration-200 ${
                      editMode
                        ? 'text-gray-600 hover:bg-gray-100 hover:text-gray-800'
                        : 'text-gray-400 cursor-not-allowed'
                    }`}
                    title="More formatting options"
                  >
                    <AdjustmentsHorizontalIcon className="w-5 h-5" />
                  </button>

                  {/* Dropdown Menu */}
                  {showWidthDropdown && (
                    <div className="absolute top-full mt-2 left-0 w-64 bg-white rounded-lg shadow-lg border border-gray-200 py-2 z-50">
                      <div className="px-4 py-3 border-b border-gray-100">
                        <h4 className="text-sm font-medium text-gray-700">Formatting Options</h4>
                      </div>

                      <div className="p-4 space-y-4">
                        {/* Curve Control */}
                        <div>
                          <label className="text-sm text-gray-600">Connection Curve</label>
                          <div className="flex items-center gap-2 mt-2">
                            <input
                              type="range"
                              min="0"
                              max="1"
                              step="0.1"
                              value={curvature}
                              onChange={(e) => setCurvature(parseFloat(e.target.value))}
                              className="flex-1 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
                            />
                            <span className="text-xs text-gray-500 w-12">
                              {Math.round(curvature * 100)}%
                            </span>
                          </div>
                        </div>

                        {/* Spacing Controls */}
                        <div>
                          <label className="text-sm text-gray-600">Column Spacing</label>
                          <div className="flex items-center gap-2 mt-2">
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
                          <div className="flex items-center gap-2 mt-2">
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

            {/* Center - Share Dropdown */}
            <div className="flex-shrink-0" ref={shareDropdownRef}>
              <button
                onClick={() => setShowShareDropdown(!showShareDropdown)}
                className="px-2 sm:px-4 py-1.5 sm:py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition-all duration-200 flex items-center gap-1 sm:gap-2 relative"
                title="Share"
              >
                <ShareIcon className="w-4 h-4" />
                Share
                {/* Notification badge for pending requests */}
                {permissions.filter((p) => p.status === 'pending').length > 0 && (
                  <span className="absolute -top-1 -right-1 flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-red-500 rounded-full animate-pulse">
                    {permissions.filter((p) => p.status === 'pending').length}
                  </span>
                )}
              </button>

              {/* Share Dropdown */}
              {showShareDropdown && (
                <div className="absolute top-full mt-2 right-0 sm:right-auto sm:left-1/2 sm:transform sm:-translate-x-1/2 w-[calc(100vw-1rem)] sm:w-96 max-w-96 bg-white rounded-lg shadow-lg border border-gray-200 p-4 z-50 max-h-[80vh] overflow-y-auto">
                  <div>
                    {shareLoading && (
                      <div className="text-center py-4">
                        <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600"></div>
                        <p className="mt-2 text-gray-600 text-sm">
                          {currentEditToken
                            ? 'Loading share links...'
                            : 'Creating shareable links...'}
                        </p>
                      </div>
                    )}

                    {shareError && (
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4">
                        <p className="text-red-600 text-sm">{shareError}</p>
                        <button
                          onClick={() => {
                            setShareError(null);
                            if (currentEditToken) {
                              loadExistingShareData();
                            } else {
                              handleShare();
                            }
                          }}
                          className="mt-2 text-sm text-red-700 underline hover:no-underline"
                        >
                          Try again
                        </button>
                      </div>
                    )}

                    {shareData && !shareLoading && (
                      <div className="space-y-4">
                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            Share Link for Collaboration
                          </label>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              readOnly
                              value={shareData.editUrl}
                              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs bg-blue-50"
                            />
                            <button
                              onClick={() => copyToClipboard(shareData.editUrl, 'edit')}
                              className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors font-medium"
                            >
                              {copiedField === 'edit' ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                          <p className="text-xs text-blue-700 mt-2">
                            Share this link with collaborators to work together on your chart
                          </p>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            View-Only Link
                          </label>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              readOnly
                              value={shareData.viewUrl}
                              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs bg-gray-50"
                            />
                            <button
                              onClick={() => copyToClipboard(shareData.viewUrl, 'view')}
                              className="px-2 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
                            >
                              {copiedField === 'view' ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                          <p className="text-xs text-gray-500 mt-2">
                            Share this link to let others view your chart without editing
                          </p>
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-gray-700 mb-1">
                            Embed Code
                          </label>

                          <div className="flex items-start gap-2">
                            <textarea
                              readOnly
                              value={`<iframe src="${shareData.viewUrl}" width="100%" height="unset" frameborder="0" style="border: none; aspect-ratio: ${containerSize?.width || 16} / ${containerSize?.height || 9};" allowfullscreen></iframe>`}
                              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs bg-blue-50 font-mono resize-none overflow-hidden"
                              rows={6}
                              style={{ lineHeight: '1.5' }}
                            />
                            <button
                              onClick={() => {
                                copyToClipboard(
                                  `<iframe src="${shareData.viewUrl}" width="100%" height="unset" frameborder="0" style="border: none; aspect-ratio: ${containerSize?.width || 16} / ${containerSize?.height || 9};" allowfullscreen></iframe>`,
                                  'embed',
                                );
                              }}
                              className="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded hover:bg-blue-200 transition-colors whitespace-nowrap"
                            >
                              {copiedField === 'embed' ? 'Copied!' : 'Copy'}
                            </button>
                          </div>
                          <p className="text-xs text-gray-600 mt-2">
                            Embed instructions:{' '}
                            <a
                              href="https://wordpress.org/documentation/article/wordpress-block-editor/#custom-html"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 underline hover:text-blue-700"
                            >
                              WordPress
                            </a>
                            ,{' '}
                            <a
                              href="https://support.wix.com/en/article/studio-editor-adding-an-html-iframe-element"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 underline hover:text-blue-700"
                            >
                              Wix
                            </a>
                            ,{' '}
                            <a
                              href="https://support.squarespace.com/hc/en-us/articles/206543617-Code-Blocks"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 underline hover:text-blue-700"
                            >
                              Squarespace
                            </a>
                            ,{' '}
                            <a
                              href="https://university.webflow.com/lesson/custom-code-embed"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 underline hover:text-blue-700"
                            >
                              Webflow
                            </a>
                          </p>
                        </div>

                        {/* Permission Management Section - Only for owners */}
                        {isAuthenticated &&
                          user?.sub &&
                          permissions.some(
                            (p) => p.user_id === user.sub && p.permission_level === 'owner',
                          ) && (
                            <div className="pt-3 border-t border-gray-200">
                              <button
                                onClick={() => setShowPermissionsSection(!showPermissionsSection)}
                                className="w-full flex items-center justify-between px-2 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded transition-colors"
                              >
                                <span>Manage Permissions</span>
                                <ChevronDownIcon
                                  className={`w-4 h-4 transition-transform ${showPermissionsSection ? 'rotate-180' : ''}`}
                                />
                              </button>

                              {showPermissionsSection && (
                                <div className="mt-3 space-y-4">
                                  {/* Info box */}
                                  <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
                                    <p className="text-sm text-blue-800 font-medium mb-1">
                                      How to share this chart
                                    </p>
                                    <p className="text-xs text-blue-700">
                                      Copy the <strong>Edit Link</strong> above and send it to
                                      collaborators. When they open it while logged in, they'll
                                      request access and you can approve them below.
                                    </p>
                                  </div>

                                  {permissionError && (
                                    <div className="text-xs text-red-600 bg-red-50 p-2 rounded">
                                      {permissionError}
                                    </div>
                                  )}

                                  {/* People with access */}
                                  <div>
                                    {loadingPermissions ? (
                                      <div className="text-center py-4">
                                        <div className="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-gray-600"></div>
                                      </div>
                                    ) : permissions.length === 0 ? (
                                      <p className="text-sm text-gray-500 py-2">
                                        No collaborators yet
                                      </p>
                                    ) : (
                                      <>
                                        {/* Pending requests */}
                                        {permissions.filter((p) => p.status === 'pending').length >
                                          0 && (
                                          <div className="mb-4">
                                            <label className="block text-sm font-medium text-gray-900 mb-2">
                                              Pending requests
                                            </label>
                                            <div className="space-y-2">
                                              {permissions
                                                .filter((p) => p.status === 'pending')
                                                .map((perm) => {
                                                  const displayName = perm.user_email;
                                                  const initials = displayName
                                                    ? displayName.substring(0, 2).toUpperCase()
                                                    : '?';

                                                  return (
                                                    <div
                                                      key={perm.user_id}
                                                      className="flex items-center justify-between py-2 px-3 bg-yellow-50 border border-yellow-200 rounded-md"
                                                    >
                                                      <div className="flex items-center gap-3 flex-1 min-w-0">
                                                        {/* Avatar */}
                                                        <div className="w-8 h-8 rounded-full bg-yellow-600 text-white flex items-center justify-center text-xs font-medium flex-shrink-0">
                                                          {initials}
                                                        </div>
                                                        {/* Name and email */}
                                                        <div className="flex-1 min-w-0">
                                                          <div className="text-sm font-medium text-gray-900 truncate">
                                                            {displayName}
                                                          </div>
                                                          <div className="text-xs text-yellow-700">
                                                            Requesting access
                                                          </div>
                                                        </div>
                                                      </div>
                                                      {/* Approve/Reject buttons */}
                                                      <div className="flex items-center gap-2">
                                                        <button
                                                          onClick={() =>
                                                            handleApproveAccess(perm.user_id)
                                                          }
                                                          className="px-3 py-1 text-xs font-medium text-green-700 bg-green-100 rounded hover:bg-green-200 transition-colors"
                                                        >
                                                          Approve
                                                        </button>
                                                        <button
                                                          onClick={() =>
                                                            handleRejectAccess(perm.user_id)
                                                          }
                                                          className="px-3 py-1 text-xs font-medium text-red-700 bg-red-100 rounded hover:bg-red-200 transition-colors"
                                                        >
                                                          Reject
                                                        </button>
                                                      </div>
                                                    </div>
                                                  );
                                                })}
                                            </div>
                                          </div>
                                        )}

                                        {/* Approved users */}
                                        {permissions.filter(
                                          (p) => p.status === 'approved' || !p.status,
                                        ).length > 0 && (
                                          <div>
                                            <label className="block text-sm font-medium text-gray-900 mb-2">
                                              People with access
                                            </label>
                                            <div className="space-y-2">
                                              {permissions
                                                .filter((p) => p.status === 'approved' || !p.status)
                                                .map((perm) => {
                                                  const isOwner = perm.permission_level === 'owner';
                                                  const displayName = perm.user_email;
                                                  const initials = displayName
                                                    ? displayName.substring(0, 2).toUpperCase()
                                                    : '?';

                                                  return (
                                                    <div
                                                      key={perm.user_id}
                                                      className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0"
                                                    >
                                                      <div className="flex items-center gap-3 flex-1 min-w-0">
                                                        {/* Avatar */}
                                                        <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-medium flex-shrink-0">
                                                          {initials}
                                                        </div>
                                                        {/* Name and email */}
                                                        <div className="flex-1 min-w-0">
                                                          <div className="text-sm font-medium text-gray-900 truncate">
                                                            {displayName}
                                                            {isOwner &&
                                                              user?.email === perm.user_email && (
                                                                <span className="text-gray-500 font-normal">
                                                                  {' '}
                                                                  (you)
                                                                </span>
                                                              )}
                                                          </div>
                                                        </div>
                                                      </div>
                                                      {/* Permission dropdown */}
                                                      <div className="flex items-center gap-2">
                                                        {isOwner ? (
                                                          <span className="text-sm text-gray-700 px-3 py-1">
                                                            Owner
                                                          </span>
                                                        ) : (
                                                          <>
                                                            <select
                                                              value={perm.permission_level}
                                                              onChange={(e) =>
                                                                handleUpdatePermission(
                                                                  perm.user_id,
                                                                  e.target.value as
                                                                    | 'owner'
                                                                    | 'edit',
                                                                )
                                                              }
                                                              className="text-sm border-0 bg-transparent text-gray-700 focus:ring-0 pr-8 cursor-pointer"
                                                            >
                                                              <option value="edit">Editor</option>
                                                              <option value="owner">Owner</option>
                                                            </select>
                                                            <button
                                                              onClick={() =>
                                                                handleRemovePermission(perm.user_id)
                                                              }
                                                              className="text-gray-400 hover:text-red-600 transition-colors"
                                                              title="Remove access"
                                                            >
                                                              <svg
                                                                className="w-5 h-5"
                                                                fill="none"
                                                                stroke="currentColor"
                                                                viewBox="0 0 24 24"
                                                              >
                                                                <path
                                                                  strokeLinecap="round"
                                                                  strokeLinejoin="round"
                                                                  strokeWidth={2}
                                                                  d="M6 18L18 6M6 6l12 12"
                                                                />
                                                              </svg>
                                                            </button>
                                                          </>
                                                        )}
                                                      </div>
                                                    </div>
                                                  );
                                                })}
                                            </div>
                                          </div>
                                        )}
                                      </>
                                    )}
                                  </div>

                                  {/* General access */}
                                  <div className="pt-3 border-t border-gray-200">
                                    <label className="block text-xs font-medium text-gray-700 mb-2">
                                      General access
                                    </label>
                                    <div className="relative" ref={generalAccessDropdownRef}>
                                      <button
                                        onClick={() =>
                                          setShowGeneralAccessDropdown(!showGeneralAccessDropdown)
                                        }
                                        className="w-full flex items-center justify-between py-2 px-3 hover:bg-gray-50 rounded transition-colors"
                                      >
                                        <div className="flex items-center gap-3">
                                          {/* Icon - changes based on access level */}
                                          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                                            {linkSharingLevel === 'restricted' ? (
                                              <svg
                                                className="w-5 h-5 text-gray-600"
                                                fill="none"
                                                stroke="currentColor"
                                                viewBox="0 0 24 24"
                                              >
                                                <path
                                                  strokeLinecap="round"
                                                  strokeLinejoin="round"
                                                  strokeWidth={2}
                                                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                                                />
                                              </svg>
                                            ) : (
                                              <svg
                                                className="w-5 h-5 text-gray-600"
                                                fill="none"
                                                stroke="currentColor"
                                                viewBox="0 0 24 24"
                                              >
                                                <path
                                                  strokeLinecap="round"
                                                  strokeLinejoin="round"
                                                  strokeWidth={2}
                                                  d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                                />
                                              </svg>
                                            )}
                                          </div>
                                          <div className="text-left">
                                            <div className="text-sm font-medium text-gray-900">
                                              {linkSharingLevel === 'restricted'
                                                ? 'Restricted'
                                                : 'Anyone with the link'}
                                            </div>
                                            <div className="text-xs text-gray-500">
                                              {linkSharingLevel === 'restricted' &&
                                                'Only people with explicit permission can access'}
                                              {linkSharingLevel === 'editor' &&
                                                'Anyone with the edit link can edit'}
                                              {linkSharingLevel === 'viewer' &&
                                                'Anyone with the link can view'}
                                            </div>
                                          </div>
                                        </div>
                                        <ChevronDownIcon
                                          className={`w-4 h-4 text-gray-500 flex-shrink-0 transition-transform ${showGeneralAccessDropdown ? 'rotate-180' : ''}`}
                                        />
                                      </button>

                                      {/* Dropdown menu */}
                                      {showGeneralAccessDropdown && (
                                        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
                                          <button
                                            onClick={() => {
                                              handleUpdateLinkSharing('restricted');
                                              setShowGeneralAccessDropdown(false);
                                            }}
                                            className="w-full flex items-start gap-3 px-3 py-2 hover:bg-gray-50 transition-colors text-left border-b border-gray-100 last:border-0"
                                          >
                                            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                                              <svg
                                                className="w-5 h-5 text-gray-600"
                                                fill="none"
                                                stroke="currentColor"
                                                viewBox="0 0 24 24"
                                              >
                                                <path
                                                  strokeLinecap="round"
                                                  strokeLinejoin="round"
                                                  strokeWidth={2}
                                                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                                                />
                                              </svg>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                              <div className="text-sm font-medium text-gray-900">
                                                Restricted
                                              </div>
                                              <div className="text-xs text-gray-500">
                                                Only people with explicit permission can access
                                              </div>
                                            </div>
                                          </button>
                                          <button
                                            onClick={() => {
                                              handleUpdateLinkSharing('editor');
                                              setShowGeneralAccessDropdown(false);
                                            }}
                                            className="w-full flex items-start gap-3 px-3 py-2 hover:bg-gray-50 transition-colors text-left border-b border-gray-100 last:border-0"
                                          >
                                            <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 mt-0.5">
                                              <svg
                                                className="w-5 h-5 text-gray-600"
                                                fill="none"
                                                stroke="currentColor"
                                                viewBox="0 0 24 24"
                                              >
                                                <path
                                                  strokeLinecap="round"
                                                  strokeLinejoin="round"
                                                  strokeWidth={2}
                                                  d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                                />
                                              </svg>
                                            </div>
                                            <div className="flex-1 min-w-0">
                                              <div className="text-sm font-medium text-gray-900">
                                                Anyone with the link
                                              </div>
                                              <div className="text-xs text-gray-500">
                                                Anyone with the edit link can edit
                                              </div>
                                            </div>
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}

                        <div className="pt-3 border-t border-gray-200 space-y-3">
                          <p className="text-xs text-gray-600">
                            Chart ID:{' '}
                            <code className="bg-gray-100 px-1 rounded text-xs">
                              {shareData.chartId}
                            </code>
                          </p>

                          {/* Delete Chart Button */}
                          <button
                            onClick={() => {
                              if (
                                confirm(
                                  `Are you sure you want to delete "${data.title || 'this chart'}"? This action cannot be undone.`,
                                )
                              ) {
                                handleDeleteChart(shareData.chartId);
                              }
                            }}
                            className="w-full px-4 py-2 text-sm font-medium text-red-600 border border-red-300 rounded-lg hover:bg-red-50 transition-colors flex items-center justify-center gap-2"
                          >
                            <TrashIcon className="w-4 h-4" />
                            Delete Chart
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Right side - Visual Controls and Actions */}
            <div className="flex items-center gap-1 flex-shrink-0">
              {/* Save Status - Hidden on very small screens */}
              <div className="hidden sm:flex items-center gap-1 sm:gap-2">
                {isSaving && (
                  <div className="flex items-center gap-1 px-1 sm:px-2 py-1 text-gray-600 text-sm">
                    <svg
                      className="animate-spin w-4 h-4"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    <span className="hidden md:inline">Saving...</span>
                  </div>
                )}
                {!isSaving && currentEditToken && (
                  <div className="flex items-center gap-1 px-1 sm:px-2 py-1 text-gray-600 text-sm">
                    <svg className="w-4 h-4 text-green-600" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <span className="hidden md:inline">Saved</span>
                  </div>
                )}
                {currentEditToken && (
                  <div className="hidden lg:flex items-center gap-2">
                    <button
                      onClick={handleManualSync}
                      disabled={isManualSyncing}
                      className="p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200"
                      title="Sync with server"
                    >
                      <svg
                        className={`w-5 h-5 ${isManualSyncing ? 'animate-spin' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                        />
                      </svg>
                    </button>
                    {lastSyncTime && (
                      <span className="hidden xl:inline text-gray-600 text-sm">
                        Last synced: {getTimeAgo(lastSyncTime)}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Separator - hidden on mobile */}
              <div className="h-6 w-px bg-gray-300 mx-1 sm:mx-2 hidden sm:block"></div>

              {/* Help Button - hidden on mobile */}
              <button
                onClick={() => setShowHelpModal(true)}
                className="hidden sm:block p-1.5 sm:p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded transition-all duration-200"
                title="Help & Keyboard Shortcuts"
              >
                <QuestionMarkCircleIcon className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>

              {/* Separator - hidden on mobile */}
              <div className="h-6 w-px bg-gray-300 mx-1 sm:mx-2 hidden sm:block"></div>

              {/* Mode Switcher Dropdown (Google Docs style) - Compact on mobile */}
              <div className="relative hidden sm:block" ref={modeDropdownRef}>
                <button
                  onClick={() => setShowModeDropdown(!showModeDropdown)}
                  className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 rounded transition-all duration-200"
                >
                  {editMode ? (
                    <>
                      <PencilIcon className="w-4 h-4" />
                      <span className="hidden md:inline">Editing</span>
                    </>
                  ) : (
                    <>
                      <EyeIcon className="w-4 h-4" />
                      <span className="hidden md:inline">Viewing</span>
                    </>
                  )}
                  <ChevronDownIcon className="w-4 h-4 text-gray-500" />
                </button>

                {showModeDropdown && (
                  <div className="absolute top-full right-0 mt-2 w-48 bg-white rounded-md shadow-lg border border-gray-200 py-1 z-50">
                    <button
                      onClick={() => {
                        setEditMode(true);
                        setShowModeDropdown(false);
                      }}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                        editMode ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <PencilIcon className="w-4 h-4" />
                      <span>Editing</span>
                      {editMode && (
                        <svg
                          className="w-4 h-4 ml-auto text-blue-700"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={() => {
                        setEditMode(false);
                        setHighlightedNodes(new Set());
                        setLayoutMode(false);
                        setShowModeDropdown(false);
                      }}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                        !editMode ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-100'
                      }`}
                    >
                      <EyeIcon className="w-4 h-4" />
                      <span>Viewing</span>
                      {!editMode && (
                        <svg
                          className="w-4 h-4 ml-auto text-blue-700"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      )}
                    </button>
                  </div>
                )}
              </div>

              {/* Mobile Menu Button - Shown when edit tools are hidden (below md breakpoint) */}
              <div className="relative md:hidden" ref={mobileMenuRef}>
                <button
                  onClick={() => setShowMobileMenu(!showMobileMenu)}
                  className="p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded transition-all duration-200"
                  title="Menu"
                >
                  <Bars3Icon className="w-5 h-5" />
                </button>

                {/* Mobile Menu Dropdown */}
                {showMobileMenu && (
                  <div className="absolute top-full right-0 mt-2 w-64 bg-white rounded-lg shadow-lg border border-gray-200 py-2 z-50">
                    {/* Mode Switcher */}
                    <div className="px-4 py-2 border-b border-gray-100">
                      <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                        Mode
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setEditMode(true);
                            setShowMobileMenu(false);
                          }}
                          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded text-sm ${
                            editMode
                              ? 'bg-blue-100 text-blue-700'
                              : 'text-gray-700 hover:bg-gray-100'
                          }`}
                        >
                          <PencilIcon className="w-4 h-4" />
                          Edit
                        </button>
                        <button
                          onClick={() => {
                            setEditMode(false);
                            setHighlightedNodes(new Set());
                            setLayoutMode(false);
                            setShowMobileMenu(false);
                          }}
                          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded text-sm ${
                            !editMode
                              ? 'bg-blue-100 text-blue-700'
                              : 'text-gray-700 hover:bg-gray-100'
                          }`}
                        >
                          <EyeIcon className="w-4 h-4" />
                          View
                        </button>
                      </div>
                    </div>

                    {/* Edit Tools */}
                    {editMode && (
                      <div className="px-4 py-2 border-b border-gray-100">
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                          Edit Tools
                        </div>
                        <button
                          onClick={() => {
                            setLayoutMode(!layoutMode);
                            setShowMobileMenu(false);
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm ${
                            layoutMode
                              ? 'bg-blue-100 text-blue-700'
                              : 'text-gray-700 hover:bg-gray-100'
                          }`}
                        >
                          <svg
                            className="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
                            />
                          </svg>
                          Layout Mode {layoutMode ? '(On)' : '(Off)'}
                        </button>

                        {/* Text Size */}
                        <div className="mt-2">
                          <div className="text-xs text-gray-600 mb-1">Text Size</div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => {
                                const currentPx = Math.round(textSize * 18);
                                const newPx = Math.max(9, currentPx - 2);
                                setTextSize(newPx / 18);
                              }}
                              className="p-2 rounded hover:bg-gray-200"
                            >
                              <MinusIcon className="w-4 h-4 text-gray-600" />
                            </button>
                            <span className="flex-1 text-center text-sm text-gray-700">
                              {Math.round(textSize * 18)}px
                            </span>
                            <button
                              onClick={() => {
                                const currentPx = Math.round(textSize * 18);
                                const newPx = Math.min(36, currentPx + 2);
                                setTextSize(newPx / 18);
                              }}
                              className="p-2 rounded hover:bg-gray-200"
                            >
                              <PlusIcon className="w-4 h-4 text-gray-600" />
                            </button>
                          </div>
                        </div>

                        {/* Font Family */}
                        <div className="mt-2">
                          <div className="text-xs text-gray-600 mb-1">Font</div>
                          <select
                            value={fontFamily}
                            onChange={(e) => setFontFamily(e.target.value)}
                            className="w-full text-sm text-gray-700 border border-gray-300 rounded px-2 py-1.5"
                            style={{ fontFamily: fontFamily }}
                          >
                            <option value="'Roboto', sans-serif">Roboto</option>
                            <option value="'Open Sans', sans-serif">Open Sans</option>
                            <option value="'Lato', sans-serif">Lato</option>
                            <option value="'Montserrat', sans-serif">Montserrat</option>
                            <option value="'Poppins', sans-serif">Poppins</option>
                            <option value="'Merriweather', serif">Merriweather</option>
                          </select>
                        </div>
                      </div>
                    )}

                    {/* Sync Controls */}
                    {currentEditToken && (
                      <div className="px-4 py-2 border-b border-gray-100">
                        <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                          Sync
                        </div>
                        <button
                          onClick={() => {
                            handleManualSync();
                            setShowMobileMenu(false);
                          }}
                          disabled={isManualSyncing}
                          className="w-full flex items-center gap-2 px-3 py-2 rounded text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-50"
                        >
                          <svg
                            className={`w-4 h-4 ${isManualSyncing ? 'animate-spin' : ''}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.5}
                              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                            />
                          </svg>
                          Sync Now
                        </button>
                        {lastSyncTime && (
                          <div className="text-xs text-gray-500 mt-1 px-3">
                            Last synced: {getTimeAgo(lastSyncTime)}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Help */}
                    <button
                      onClick={() => {
                        setShowHelpModal(true);
                        setShowMobileMenu(false);
                      }}
                      className="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    >
                      <QuestionMarkCircleIcon className="w-4 h-4" />
                      Help & Shortcuts
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Help Modal */}
      {showHelpModal && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black bg-opacity-50 p-4"
          onClick={() => setShowHelpModal(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white border-b border-gray-200 px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between">
              <h2 className="text-lg sm:text-xl font-semibold text-gray-800">
                Help & Keyboard Shortcuts
              </h2>
              <button
                onClick={() => setShowHelpModal(false)}
                className="p-1 text-gray-400 hover:text-gray-600 rounded transition-colors"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="px-4 sm:px-6 py-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                <div>
                  <h3 className="font-semibold text-gray-800 mb-3">Basic Navigation</h3>
                  <ul className="space-y-2 text-sm text-gray-700">
                    <li>
                      • <strong>Click nodes</strong> to select
                    </li>
                    <li>
                      • <strong>Hover</strong> to highlight connections
                    </li>
                    <li>
                      • <strong>Tab</strong> to navigate nodes
                    </li>
                    <li>
                      • <strong>Escape</strong> to clear selections
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-800 mb-3">Node Selection</h3>
                  <ul className="space-y-2 text-sm text-gray-700">
                    <li>
                      • <strong>Click:</strong> Select single node
                    </li>
                    <li>
                      • <strong>{shortcuts.multiSelect()}:</strong> Multi-select
                    </li>
                    <li>
                      • <strong>Shift+Click:</strong> Select column
                    </li>
                    <li>
                      • <strong>{shortcuts.selectAllDisplay()}:</strong> Select all (edit mode)
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-800 mb-3">Edit Mode</h3>
                  <ul className="space-y-2 text-sm text-gray-700">
                    <li>
                      • <strong>Double-click:</strong> Create node
                    </li>
                    <li>
                      • <strong>Drag nodes</strong> to reposition
                    </li>
                    <li>
                      • <strong>Select 2 nodes:</strong> Connect/disconnect
                    </li>
                    <li>
                      • <strong>Delete:</strong> Remove selected
                    </li>
                    <li>
                      • <strong>Arrow keys:</strong> Fine-tune position
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-800 mb-3">Keyboard Shortcuts</h3>
                  <ul className="space-y-2 text-sm text-gray-700">
                    <li>
                      • <strong>{shortcuts.undoDisplay()}:</strong> Undo
                    </li>
                    <li>
                      • <strong>{shortcuts.redoDisplay()}:</strong> Redo
                    </li>
                    <li>
                      • <strong>↑↓:</strong> Move vertically
                    </li>
                    <li>
                      • <strong>←→:</strong> Move between columns
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-800 mb-3">Connections</h3>
                  <ul className="space-y-2 text-sm text-gray-700">
                    <li>
                      • <strong>Solid:</strong> High confidence (75-100%)
                    </li>
                    <li>
                      • <strong>Dashed:</strong> Medium (25-75%)
                    </li>
                    <li>
                      • <strong>Dotted:</strong> Low (0-25%)
                    </li>
                    <li>
                      • <strong>Click line:</strong> Edit confidence
                    </li>
                  </ul>
                </div>

                <div>
                  <h3 className="font-semibold text-gray-800 mb-3">AI Assistant</h3>
                  <ul className="space-y-2 text-sm text-gray-700">
                    <li>
                      • <strong>Chat panel</strong> on the left
                    </li>
                    <li>
                      • <strong>Ask questions</strong> about ToC
                    </li>
                    <li>
                      • <strong>Request edits</strong> to nodes
                    </li>
                    <li>
                      • <strong>Generate content</strong> for sections
                    </li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 px-6 py-3">
              <button
                onClick={() => setShowHelpModal(false)}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Smart Alignment Suggestion Popup */}
      {showAlignmentSuggestion && (
        <div
          className="absolute z-50 bg-white rounded-lg shadow-lg border border-gray-200 px-2 py-2 max-w-xs transition-all duration-300 ease-out"
          style={{
            right: '20px',
            bottom: '20px',
          }}
        >
          <div className="flex flex-col items-center text-center gap-3">
            <div className="flex items-center justify-center gap-3 w-full">
              {/* Misaligned nodes */}
              <svg
                className="w-12 h-12 text-blue-600"
                fill="currentColor"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <rect x="2" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
                <rect x="8" y="10" width="3" height="8" rx="1.5" opacity="0.7" />
                <rect x="14" y="7" width="3" height="8" rx="1.5" opacity="0.7" />
              </svg>

              {/* Arrow */}
              <svg
                className="w-8 h-8 text-blue-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M8 12h8m0 0l-3-3m3 3l-3 3"
                />
              </svg>

              {/* Aligned nodes */}
              <svg
                className="w-12 h-12 text-blue-600"
                fill="currentColor"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <rect x="2" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
                <rect x="8" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
                <rect x="14" y="8" width="3" height="8" rx="1.5" opacity="0.7" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-medium text-gray-900 mb-1">Clean up alignment?</div>
              <div className="text-xs text-gray-600 mb-3">
                Some nodes are close but not perfectly aligned
              </div>
              <div className="flex gap-2 justify-center">
                <button
                  onClick={() => {
                    straightenEdges();
                    setShowAlignmentSuggestion(false);
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
      {editMode && highlightedNodes.size > 0 && !showHelpModal && !nodePopup && !edgePopup && (
        <div
          className="fixed z-[60] bg-white rounded-lg shadow-lg border border-gray-200 px-2 sm:px-4 py-2 sm:py-3"
          style={{
            left: Math.min(Math.max(toolbarPosition.x, 150), window.innerWidth - 150),
            top: Math.max(toolbarPosition.y, 60),
            transform: 'translateX(-50%)',
            minWidth: 'auto',
            maxWidth: 'calc(100vw - 1rem)',
          }}
        >
          <div className="flex items-center gap-2 sm:gap-6 flex-wrap">
            {/* Node Count */}
            <div className="flex items-center gap-2">
              <span className="text-xs sm:text-sm font-medium text-gray-700">
                {highlightedNodes.size === 1 ? '' : `${highlightedNodes.size} nodes`}
              </span>
            </div>

            {/* Separator if more than 1 node - hidden on mobile */}
            {highlightedNodes.size > 1 && (
              <div className="h-4 w-px bg-gray-300 hidden sm:block"></div>
            )}

            {/* Width Control */}
            <div className="flex items-center gap-1 sm:gap-2">
              <span className="text-xs sm:text-sm text-gray-600 hidden sm:inline">Width</span>
              <input
                type="range"
                min="128"
                max="320"
                step="16"
                value={nodeWidth}
                onChange={(e) => {
                  const newWidth = parseInt(e.target.value);
                  setNodeWidth(newWidth);
                  if (highlightedNodes.size > 0) {
                    setData((prevData) => ({
                      ...prevData,
                      sections: prevData.sections.map((section) => ({
                        ...section,
                        columns: section.columns.map((column) => ({
                          ...column,
                          nodes: column.nodes.map((node) => {
                            if (highlightedNodes.has(node.id)) {
                              return { ...node, width: newWidth };
                            }
                            return node;
                          }),
                        })),
                      })),
                    }));
                  }
                }}
                className="w-16 sm:w-20 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
              />
              <span className="text-xs text-gray-500 w-8 sm:w-10 text-right">{nodeWidth}</span>
            </div>

            {/* Separator */}
            <div className="h-4 w-px bg-gray-300 hidden sm:block"></div>

            {/* Color Control */}
            <div className="flex items-center gap-1 sm:gap-2">
              <span className="text-xs sm:text-sm text-gray-600 hidden sm:inline">Color</span>
              <input
                type="color"
                value={nodeColor}
                onChange={(e) => {
                  const newColor = e.target.value;
                  setNodeColor(newColor);
                  if (highlightedNodes.size > 0) {
                    setData((prevData) => ({
                      ...prevData,
                      sections: prevData.sections.map((section) => ({
                        ...section,
                        columns: section.columns.map((column) => ({
                          ...column,
                          nodes: column.nodes.map((node) => {
                            if (highlightedNodes.has(node.id)) {
                              return { ...node, color: newColor };
                            }
                            return node;
                          }),
                        })),
                      })),
                    }));
                  }
                }}
                className="w-6 h-6 sm:w-8 sm:h-8 rounded border border-gray-300 cursor-pointer"
              />
            </div>

            {/* Delete Button - only in edit mode */}
            {editMode && onDeleteNode && (
              <>
                {/* Separator - hidden on mobile */}
                <div className="h-4 w-px bg-gray-300 hidden sm:block"></div>

                <button
                  onClick={() => {
                    // Delete all selected nodes
                    highlightedNodes.forEach((nodeId) => {
                      onDeleteNode(nodeId);
                    });
                    // Clear selection after deleting
                    setHighlightedNodes(new Set());
                  }}
                  className="p-1.5 sm:p-2 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-all duration-200"
                  title={`Delete ${highlightedNodes.size === 1 ? 'node' : 'nodes'}`}
                >
                  <TrashIcon className="w-4 h-4 sm:w-5 sm:h-5" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Layout Mode Tooltip */}
      {editMode && (
        <Tooltip
          id="layout-mode-tooltip"
          place="bottom"
          isOpen={showLayoutTooltip}
          clickable
          style={{ zIndex: 9999 }}
        >
          <div>
            <div>Add/remove columns & sections</div>
            <button
              onClick={() => setShowLayoutTooltip(false)}
              className="text-xs underline hover:no-underline mt-2"
            >
              Got it
            </button>
          </div>
        </Tooltip>
      )}
    </>
  );
}
