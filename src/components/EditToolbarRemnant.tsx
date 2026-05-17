// EditToolbarRemnant — the floating overlays that survived the
// EditToolbar deletion in PR 1.
//
// The original EditToolbar was a 2,500-LoC mixed bag: a fixed top bar
// (now replaced by `top-bar/TopBar`), a share dialog, a smart-alignment
// suggestion banner, and a per-selection floating toolbar above the
// active nodes. The top-bar piece dies; the three overlays live here
// until PRs 2-3 move them to their permanent homes:
//
//   - `<ShareDialogShim>`  →  PR 2 redesigns it into ShareDialog +
//                              GeneralAccessSelector + PermissionsList.
//   - `<PerSelectionToolbar>` →  PR 3 folds it into the anchored
//                                 NodeEditor.
//   - `<AlignmentBanner>`  →  PR 3 renames the file to
//                              AlignmentSuggestionBanner.tsx once the
//                              other two are gone.
//
// =====================================================================
// State / ref map (per plan §1.6 acceptance — "explicit state map")
// =====================================================================
//
// Each sub-component owns its own state copy. The remnant lifts NOTHING.
//
// ShareDialogShim:
//   useState  open, showPermissionsSection, showGeneralAccessDropdown
//   useState  shareData, shareLoading, shareError, copiedField
//   useState  isOwner (local — local mirror of App's isOwner; both are
//             populated from getChartByEditToken; redundant during the
//             PR 1 bridge phase, will collapse in PR 2)
//   useState  permissions, loadingPermissions, permissionError
//   useState  linkSharingLevel
//   useRef    shareDropdownRef, generalAccessDropdownRef
//   useRef    handleShareRef, loadExistingShareDataRef (stable handlers)
//
// PerSelectionToolbar:
//   useState  toolbarPosition (x, y)
//
// AlignmentBanner:
//   useState  show
//   (plus a `useCallback` named `detect` for the misalignment heuristic,
//    kept inside the component so its deps stay local)
//
// EditToolbarRemnant itself: no state. It just wires the three children.
//
// =====================================================================
// Why "Shim"
// =====================================================================
//
// `ShareDialogShim` keeps the *existing* visual layout (the centered
// floating dropdown card) but no longer renders a button trigger. The
// new TopBar carries the Share button; clicking it dispatches a
// `toc:open-share` CustomEvent which the shim listens for. PR 1 task
// 1.7 will replace the CustomEvent with a direct prop; PR 2 redesigns
// the entire dialog. Until then, it's a behaviour-preserving shim.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { useNavigate } from 'react-router-dom';
import { ChevronDownIcon, TrashIcon } from '@heroicons/react/24/outline';
import { ChartService, type CreateChartResponse } from '../services/chartService';
import type { Node as GraphNode, ToCData } from '../types';
import { clearChartSpend } from '../utils/byokSpend';

// =====================================================================
// AlignmentBanner — floating "Clean up alignment?" popup
// =====================================================================

interface AlignmentBannerProps {
  editMode: boolean;
  data: ToCData;
  straightenEdges: () => void;
}

function AlignmentBanner({ editMode, data, straightenEdges }: AlignmentBannerProps) {
  const [show, setShow] = useState(false);

  const detect = useCallback((): boolean => {
    if (!editMode) return false;
    const allNodes: { node: GraphNode; centerY: number }[] = [];
    data.sections.forEach((section) => {
      section.columns.forEach((column) => {
        column.nodes.forEach((node) => {
          allNodes.push({ node, centerY: node.yPosition ?? 0 });
        });
      });
    });
    if (allNodes.length < 2) return false;

    const tolerance = 40;
    const groups: (typeof allNodes)[] = [];
    allNodes.forEach((nd) => {
      let added = false;
      for (const group of groups) {
        const avgY = group.reduce((s, n) => s + n.centerY, 0) / group.length;
        if (Math.abs(nd.centerY - avgY) <= tolerance) {
          group.push(nd);
          added = true;
          break;
        }
      }
      if (!added) groups.push([nd]);
    });
    return groups.some((g) => {
      if (g.length < 2) return false;
      const ys = g.map((n) => n.centerY);
      return Math.max(...ys) - Math.min(...ys) > 0;
    });
  }, [editMode, data]);

  useEffect(() => {
    setShow(editMode && detect());
  }, [editMode, detect]);

  if (!show) return null;

  return (
    <div
      className="absolute z-50 bg-white rounded-lg shadow-lg border border-gray-200 px-2 py-2 max-w-xs transition-all duration-300 ease-out"
      style={{ right: '20px', bottom: '20px' }}
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
                setShow(false);
              }}
              className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-700 transition-colors"
            >
              Align nodes
            </button>
            <button
              onClick={() => setShow(false)}
              className="px-3 py-1.5 text-gray-600 text-xs rounded hover:bg-gray-100 transition-colors"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// PerSelectionToolbar — Miro-style horizontal bar above active nodes
// =====================================================================

interface PerSelectionToolbarProps {
  editMode: boolean;
  highlightedNodes: Set<string>;
  setHighlightedNodes: React.Dispatch<React.SetStateAction<Set<string>>>;
  nodeWidth: number;
  setNodeWidth: React.Dispatch<React.SetStateAction<number>>;
  nodeColor: string;
  setNodeColor: React.Dispatch<React.SetStateAction<string>>;
  setData: React.Dispatch<React.SetStateAction<ToCData>>;
  mutateDebounced?: (updater: React.SetStateAction<ToCData>, key: string) => void;
  commitMutation?: (key?: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  nodePopup?: unknown;
  edgePopup?: unknown;
  camera?: { x: number; y: number; z: number };
}

function PerSelectionToolbar({
  editMode,
  highlightedNodes,
  setHighlightedNodes,
  nodeWidth,
  setNodeWidth,
  nodeColor,
  setNodeColor,
  setData,
  mutateDebounced,
  commitMutation,
  onDeleteNode,
  nodePopup,
  edgePopup,
  camera,
}: PerSelectionToolbarProps) {
  const [toolbarPosition, setToolbarPosition] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (highlightedNodes.size === 0) return;
    const nodeElements = Array.from(highlightedNodes)
      .map((nodeId) => document.getElementById(`node-${nodeId}`))
      .filter((el): el is HTMLElement => el !== null);

    if (nodeElements.length > 0) {
      const rects = nodeElements.map((el) => el.getBoundingClientRect());
      const avgX = rects.reduce((sum, rect) => sum + rect.left + rect.width / 2, 0) / rects.length;
      const topY = Math.min(...rects.map((rect) => rect.top));
      setToolbarPosition({ x: avgX, y: topY - 80 });
    }
  }, [highlightedNodes, camera?.x, camera?.y, camera?.z]);

  if (!editMode || highlightedNodes.size === 0 || nodePopup || edgePopup) return null;

  return (
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
        <div className="flex items-center gap-2">
          <span className="text-xs sm:text-sm font-medium text-gray-700">
            {highlightedNodes.size === 1 ? '' : `${highlightedNodes.size} nodes`}
          </span>
        </div>

        {highlightedNodes.size > 1 && <div className="h-4 w-px bg-gray-300 hidden sm:block"></div>}

        {/* Width slider — streaming input via mutateDebounced/commit */}
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
              if (highlightedNodes.size === 0) return;
              const updater = (prevData: ToCData) => ({
                ...prevData,
                sections: prevData.sections.map((section) => ({
                  ...section,
                  columns: section.columns.map((column) => ({
                    ...column,
                    nodes: column.nodes.map((node) =>
                      highlightedNodes.has(node.id) ? { ...node, width: newWidth } : node,
                    ),
                  })),
                })),
              });
              if (mutateDebounced) {
                mutateDebounced(updater, 'width-multi');
              } else {
                setData(updater);
              }
            }}
            onPointerUp={() => commitMutation?.('width-multi')}
            onBlur={() => commitMutation?.('width-multi')}
            className="w-16 sm:w-20 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
          />
          <span className="text-xs text-gray-500 w-8 sm:w-10 text-right">{nodeWidth}</span>
        </div>

        <div className="h-4 w-px bg-gray-300 hidden sm:block"></div>

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
                      nodes: column.nodes.map((node) =>
                        highlightedNodes.has(node.id) ? { ...node, color: newColor } : node,
                      ),
                    })),
                  })),
                }));
              }
            }}
            className="w-6 h-6 sm:w-8 sm:h-8 rounded border border-gray-300 cursor-pointer"
          />
        </div>

        {onDeleteNode && (
          <>
            <div className="h-4 w-px bg-gray-300 hidden sm:block"></div>
            <button
              onClick={() => {
                highlightedNodes.forEach((nodeId) => onDeleteNode(nodeId));
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
  );
}

// =====================================================================
// ShareDialogShim — share dropdown card (no button trigger)
// =====================================================================

interface ShareDialogShimProps {
  data: ToCData;
  currentEditToken: string | null;
  onChartCreated?: (token: string, chartId: string) => void;
  containerSize?: { width: number; height: number };
}

function ShareDialogShim({
  data,
  currentEditToken,
  onChartCreated,
  containerSize,
}: ShareDialogShimProps) {
  const [open, setOpen] = useState(false);
  const [shareData, setShareData] = useState<CreateChartResponse | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  // Local mirror of App's isOwner. Re-fetched here for the polling loop;
  // PR 2 collapses the duplicate when the dialog is rebuilt.
  const [isOwner, setIsOwner] = useState(false);
  const [showPermissionsSection, setShowPermissionsSection] = useState(false);
  // FIXME (PR 2): `permission_level` and `status` are widened to `string`
  // here for identity-parity with PR 0's EditToolbar. The canonical
  // `ChartService.Permission` narrows `permission_level` to `'owner' |
  // 'edit'`; PR 2's ShareDialog rebuild should consume it directly and
  // add `status: 'pending' | 'approved' | 'rejected'` to the canonical
  // shape (the magic-string discriminator is read in 4 sites below).
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

  const shareDropdownRef = useRef<HTMLDivElement>(null);
  const generalAccessDropdownRef = useRef<HTMLDivElement>(null);

  const { user, isAuthenticated } = useAuth0();
  const navigate = useNavigate();

  // Listen for `toc:open-share` from TopBar's Share button.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('toc:open-share', onOpen);
    return () => window.removeEventListener('toc:open-share', onOpen);
  }, []);

  // Click-outside dismiss for the dropdown + nested general-access menu.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        generalAccessDropdownRef.current &&
        !generalAccessDropdownRef.current.contains(e.target as Node)
      ) {
        setShowGeneralAccessDropdown(false);
      }
      if (shareDropdownRef.current && !shareDropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  const loadExistingShareData = useCallback(async () => {
    if (!currentEditToken) return;
    setShareLoading(true);
    setShareError(null);
    try {
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
      if (currentEditToken) {
        await ChartService.updateChart(currentEditToken, data);
        const result = await ChartService.getChartByEditToken(currentEditToken);
        setIsOwner(Boolean(result.isOwner));
        setShareData({
          chartId: result.chartId,
          editToken: currentEditToken,
          viewUrl: `${window.location.origin}/chart/${result.chartId}`,
          editUrl: `${window.location.origin}/edit/${currentEditToken}`,
        });
      } else {
        const response = await ChartService.createChart(data);
        setIsOwner(isAuthenticated);
        setShareData(response);
        ChartService.saveEditToken(response.chartId, response.editToken);
        if (!isAuthenticated) {
          const stored = localStorage.getItem('recentEditCharts');
          const charts = stored ? JSON.parse(stored) : [];
          charts.unshift({
            chartId: response.chartId,
            title: data.title || 'Theory of Change',
            editUrl: response.editUrl,
            timestamp: Date.now(),
          });
          localStorage.setItem('recentEditCharts', JSON.stringify(charts.slice(0, 10)));
        }
        navigate(`/edit/${response.editToken}`, {
          replace: true,
          state: { skipChartReload: true },
        });
        if (onChartCreated) onChartCreated(response.editToken, response.chartId);
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

  const loadPermissions = useCallback(async () => {
    if (!shareData?.chartId || !isAuthenticated || !isOwner) return;
    setLoadingPermissions(true);
    setPermissionError(null);
    try {
      const result = await ChartService.getChartPermissions(shareData.chartId);
      setPermissions(result.permissions || result);
      if (result.linkSharingLevel) setLinkSharingLevel(result.linkSharingLevel);
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to load permissions');
    } finally {
      setLoadingPermissions(false);
    }
  }, [shareData?.chartId, isAuthenticated, isOwner]);

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

  const handleDeleteChart = async (chartId: string) => {
    try {
      await ChartService.deleteChart(chartId, currentEditToken ?? undefined);
      clearChartSpend(chartId);
      if (!isAuthenticated) {
        const stored = localStorage.getItem('recentEditCharts');
        if (stored) {
          const charts = JSON.parse(stored) as { chartId?: string }[];
          localStorage.setItem(
            'recentEditCharts',
            JSON.stringify(charts.filter((c) => c.chartId !== chartId)),
          );
        }
      }
      if (shareData?.chartId === chartId) {
        window.location.href = '/';
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete chart');
    }
  };

  // Load permissions when the share dropdown opens for the verified owner.
  useEffect(() => {
    if (open && shareData?.chartId && isAuthenticated && isOwner) {
      loadPermissions();
    }
  }, [open, shareData?.chartId, isAuthenticated, isOwner, loadPermissions]);

  // Pending-request polling. Same guardrails as the original
  // EditToolbar: isOwner-gated so non-owners don't 403; depends on
  // `shareData?.chartId` not the full object to avoid re-mount churn.
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
        if (result.linkSharingLevel) setLinkSharingLevel(result.linkSharingLevel);
      } catch (err) {
        console.error('Failed to poll permissions (stopping poll):', err);
        stopInterval();
      }
    };

    if (!shareData?.chartId) {
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
        } catch (err) {
          console.error('Failed to bootstrap permissions poll:', err);
        }
      })();
    } else if (isOwner) {
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

  useEffect(() => {
    if (open && permissions.filter((p) => p.status === 'pending').length > 0) {
      setShowPermissionsSection(true);
    }
  }, [open, permissions]);

  // Stable refs for the auto-generate-on-open effect (handler identity
  // churns on every keystroke because handleShare closes over `data`).
  const handleShareRef = useRef(handleShare);
  useEffect(() => {
    handleShareRef.current = handleShare;
  });
  const loadExistingShareDataRef = useRef(loadExistingShareData);
  useEffect(() => {
    loadExistingShareDataRef.current = loadExistingShareData;
  });

  // Auto-bootstrap share data when the dropdown opens.
  useEffect(() => {
    if (open && !shareData && !shareLoading) {
      if (currentEditToken) {
        void loadExistingShareDataRef.current();
      } else {
        void handleShareRef.current();
      }
    }
  }, [open, shareData, shareLoading, currentEditToken]);

  if (!open) return null;

  // The dropdown was previously anchored to the EditToolbar's centered
  // Share button. The new TopBar's Share button lives in the top-right.
  // Use a fixed positioning beneath the TopBar (~64px down + 1rem
  // right) so it lines up with the new affordance.
  return createPortal(
    <div
      ref={shareDropdownRef}
      className="fixed top-16 right-4 sm:right-6 w-[calc(100vw-2rem)] sm:w-96 max-w-96 bg-white rounded-lg shadow-lg border border-gray-200 p-4 z-50 max-h-[80vh] overflow-y-auto"
    >
      <div>
        {shareLoading && (
          <div className="text-center py-4">
            <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600"></div>
            <p className="mt-2 text-gray-600 text-sm">
              {currentEditToken ? 'Loading share links...' : 'Creating shareable links...'}
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
              <label className="block text-xs font-medium text-gray-700 mb-1">View-Only Link</label>
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
              <label className="block text-xs font-medium text-gray-700 mb-1">Embed Code</label>
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

            {/* Permission Management — owners only */}
            {isAuthenticated &&
              user?.sub &&
              permissions.some((p) => p.user_id === user.sub && p.permission_level === 'owner') && (
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
                      <div className="bg-blue-50 border border-blue-200 rounded-md p-3">
                        <p className="text-sm text-blue-800 font-medium mb-1">
                          How to share this chart
                        </p>
                        <p className="text-xs text-blue-700">
                          Copy the <strong>Edit Link</strong> above and send it to collaborators.
                          When they open it while logged in, they'll request access and you can
                          approve them below.
                        </p>
                      </div>

                      {permissionError && (
                        <div className="text-xs text-red-600 bg-red-50 p-2 rounded">
                          {permissionError}
                        </div>
                      )}

                      <div>
                        {loadingPermissions ? (
                          <div className="text-center py-4">
                            <div className="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-gray-600"></div>
                          </div>
                        ) : permissions.length === 0 ? (
                          <p className="text-sm text-gray-500 py-2">No collaborators yet</p>
                        ) : (
                          <>
                            {permissions.filter((p) => p.status === 'pending').length > 0 && (
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
                                            <div className="w-8 h-8 rounded-full bg-yellow-600 text-white flex items-center justify-center text-xs font-medium flex-shrink-0">
                                              {initials}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                              <div className="text-sm font-medium text-gray-900 truncate">
                                                {displayName}
                                              </div>
                                              <div className="text-xs text-yellow-700">
                                                Requesting access
                                              </div>
                                            </div>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            <button
                                              onClick={() => handleApproveAccess(perm.user_id)}
                                              className="px-3 py-1 text-xs font-medium text-green-700 bg-green-100 rounded hover:bg-green-200 transition-colors"
                                            >
                                              Approve
                                            </button>
                                            <button
                                              onClick={() => handleRejectAccess(perm.user_id)}
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

                            {permissions.filter((p) => p.status === 'approved' || !p.status)
                              .length > 0 && (
                              <div>
                                <label className="block text-sm font-medium text-gray-900 mb-2">
                                  People with access
                                </label>
                                <div className="space-y-2">
                                  {permissions
                                    .filter((p) => p.status === 'approved' || !p.status)
                                    .map((perm) => {
                                      const permIsOwner = perm.permission_level === 'owner';
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
                                            <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-medium flex-shrink-0">
                                              {initials}
                                            </div>
                                            <div className="flex-1 min-w-0">
                                              <div className="text-sm font-medium text-gray-900 truncate">
                                                {displayName}
                                                {permIsOwner && user?.email === perm.user_email && (
                                                  <span className="text-gray-500 font-normal">
                                                    {' '}
                                                    (you)
                                                  </span>
                                                )}
                                              </div>
                                            </div>
                                          </div>
                                          <div className="flex items-center gap-2">
                                            {permIsOwner ? (
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
                                                      e.target.value as 'owner' | 'edit',
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
                            onClick={() => setShowGeneralAccessDropdown(!showGeneralAccessDropdown)}
                            className="w-full flex items-center justify-between py-2 px-3 hover:bg-gray-50 rounded transition-colors"
                          >
                            <div className="flex items-center gap-3">
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
                                  {linkSharingLevel === 'viewer' && 'Anyone with the link can view'}
                                </div>
                              </div>
                            </div>
                            <ChevronDownIcon
                              className={`w-4 h-4 text-gray-500 flex-shrink-0 transition-transform ${showGeneralAccessDropdown ? 'rotate-180' : ''}`}
                            />
                          </button>

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
                <code className="bg-gray-100 px-1 rounded text-xs">{shareData.chartId}</code>
              </p>
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
    </div>,
    document.body,
  );
}

// =====================================================================
// EditToolbarRemnant — composes the three overlays
// =====================================================================

export interface EditToolbarRemnantProps {
  // Shared.
  editMode: boolean;
  showEditButton: boolean;
  data: ToCData;
  setData: React.Dispatch<React.SetStateAction<ToCData>>;
  // Alignment banner.
  straightenEdges: () => void;
  // Per-selection.
  highlightedNodes: Set<string>;
  setHighlightedNodes: React.Dispatch<React.SetStateAction<Set<string>>>;
  nodeWidth: number;
  setNodeWidth: React.Dispatch<React.SetStateAction<number>>;
  nodeColor: string;
  setNodeColor: React.Dispatch<React.SetStateAction<string>>;
  mutateDebounced?: (updater: React.SetStateAction<ToCData>, key: string) => void;
  commitMutation?: (key?: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  nodePopup?: unknown;
  edgePopup?: unknown;
  camera?: { x: number; y: number; z: number };
  // Share dialog.
  currentEditToken: string | null;
  onChartCreated?: (token: string, chartId: string) => void;
  containerSize?: { width: number; height: number };
}

export function EditToolbarRemnant(props: EditToolbarRemnantProps) {
  if (!props.showEditButton) return null;
  return (
    <>
      <AlignmentBanner
        editMode={props.editMode}
        data={props.data}
        straightenEdges={props.straightenEdges}
      />
      <PerSelectionToolbar
        editMode={props.editMode}
        highlightedNodes={props.highlightedNodes}
        setHighlightedNodes={props.setHighlightedNodes}
        nodeWidth={props.nodeWidth}
        setNodeWidth={props.setNodeWidth}
        nodeColor={props.nodeColor}
        setNodeColor={props.setNodeColor}
        setData={props.setData}
        mutateDebounced={props.mutateDebounced}
        commitMutation={props.commitMutation}
        onDeleteNode={props.onDeleteNode}
        nodePopup={props.nodePopup}
        edgePopup={props.edgePopup}
        camera={props.camera}
      />
      <ShareDialogShim
        data={props.data}
        currentEditToken={props.currentEditToken}
        onChartCreated={props.onChartCreated}
        containerSize={props.containerSize}
      />
    </>
  );
}
