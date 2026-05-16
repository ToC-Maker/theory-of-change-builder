// ShareDialog — the redesigned share modal (PR 2).
//
// Layout per plan §709:
//   - Header
//   - GeneralAccessSelector (3-mode radio group, always inline)
//   - LinkCopyRow ×2 (view, edit)
//   - Conditional embed-code expander (hidden under 'restricted')
//   - PermissionsList (always inline for owners)
//
// Notable design choices, per user-direction stickies:
//   - The Share button lives in the TopBar; this dialog is opened by
//     the parent passing `open` + `onClose`. There is no internal
//     trigger.
//   - Delete-chart is NOT in the dialog (it moved to FileMenu in PR 1).
//   - Chart ID is NOT displayed.
//   - Embed code is hidden when `linkSharingLevel === 'restricted'`.
//   - Permissions list is inline (no collapse toggle).
//
// L1 mitigation: this dialog wires `usePermissionsRefresh` so opening
// it always fetches the freshest `linkSharingLevel`, and a banner
// surfaces if the server's state diverges from local state (e.g. a
// sibling tab toggled the mode).
//
// L6 mitigation: `LinkCopyRow` for the edit variant renders "Anyone
// with this link can edit" subtext only when mode is 'editor'.
//
// Auto-generation: when `currentEditToken` is null, the dialog
// auto-creates the chart on open (matches the legacy shim behaviour).
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth0 } from '@auth0/auth0-react';
import { useNavigate } from 'react-router-dom';
import { ChevronDownIcon, XMarkIcon } from '@heroicons/react/24/outline';
import {
  ChartService,
  type CreateChartResponse,
  type Permission,
} from '../../services/chartService';
import type { ToCData } from '../../types';
import { usePermissionsRefresh } from '../../hooks/usePermissionsRefresh';
import { GeneralAccessSelector } from './GeneralAccessSelector';
import type { LinkSharingLevel } from './GeneralAccessSelector';
import { LinkCopyRow } from './LinkCopyRow';
import { PermissionsList, type PermissionRow } from './PermissionsList';

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  data: ToCData;
  currentEditToken: string | null;
  /** Width/height for the embed iframe aspect ratio. */
  containerSize?: { width: number; height: number };
  onChartCreated?: (token: string, chartId: string) => void;
}

const STORAGE_PING_KEY = 'toc:permissions';

export function ShareDialog({
  open,
  onClose,
  data,
  currentEditToken,
  containerSize,
  onChartCreated,
}: ShareDialogProps) {
  const { user, isAuthenticated } = useAuth0();
  const navigate = useNavigate();

  const [shareData, setShareData] = useState<CreateChartResponse | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [permissions, setPermissions] = useState<PermissionRow[]>([]);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [loadingPermissions, setLoadingPermissions] = useState(false);
  const [linkSharingLevel, setLinkSharingLevel] = useState<LinkSharingLevel>('restricted');
  const [showEmbed, setShowEmbed] = useState(false);
  const [copiedEmbed, setCopiedEmbed] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);

  // ESC key closes the dialog. We don't trap focus (the dialog content
  // is small and non-modal compared to a true modal), but Escape is a
  // standard expectation.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Click-outside dismiss.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, onClose]);

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

  const createNewChart = useCallback(async () => {
    setShareLoading(true);
    setShareError(null);
    try {
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
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Failed to share chart');
    } finally {
      setShareLoading(false);
    }
  }, [data, isAuthenticated, navigate, onChartCreated]);

  // Auto-bootstrap when the dialog opens.
  useEffect(() => {
    if (!open) return;
    if (shareData || shareLoading) return;
    if (currentEditToken) {
      void loadExistingShareData();
    } else {
      void createNewChart();
    }
  }, [open, shareData, shareLoading, currentEditToken, loadExistingShareData, createNewChart]);

  const loadPermissions = useCallback(async () => {
    if (!shareData?.chartId || !isAuthenticated || !isOwner) return;
    setLoadingPermissions(true);
    setPermissionError(null);
    try {
      const result = await ChartService.getChartPermissions(shareData.chartId);
      // Server returns either an array or { permissions, linkSharingLevel }.
      const permRows = Array.isArray(result) ? (result as Permission[]) : result.permissions;
      setPermissions(permRows as PermissionRow[]);
      if (!Array.isArray(result) && result.linkSharingLevel) {
        setLinkSharingLevel(result.linkSharingLevel);
      }
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to load permissions');
    } finally {
      setLoadingPermissions(false);
    }
  }, [shareData?.chartId, isAuthenticated, isOwner]);

  // L1 mitigation: refresh on dialog open + cross-tab storage event.
  // The hook owns the actual fetch shape; we wire it via a thin
  // adapter so it returns just the `linkSharingLevel`.
  const fetchPermissionsLevel = useCallback(async (chartId: string) => {
    const result = await ChartService.getChartPermissions(chartId);
    // Side-effect: also refresh the permissions list since we have
    // the response in hand. Don't duplicate the round-trip.
    const permRows = Array.isArray(result) ? (result as Permission[]) : result.permissions;
    setPermissions(permRows as PermissionRow[]);
    const level =
      Array.isArray(result) || !result.linkSharingLevel ? undefined : result.linkSharingLevel;
    return { linkSharingLevel: level };
  }, []);

  const { serverLevel, divergedFromLocal } = usePermissionsRefresh({
    open,
    chartId: shareData?.chartId ?? null,
    localLevel: linkSharingLevel,
    fetcher: fetchPermissionsLevel,
  });

  // When the L1 hook observes a server-side change, fold it into local
  // state (so the dropdown reflects the latest). The banner is rendered
  // off `divergedFromLocal` BEFORE this fold runs (the hook reports
  // divergence based on the previous local value).
  useEffect(() => {
    if (serverLevel && serverLevel !== linkSharingLevel) {
      setLinkSharingLevel(serverLevel);
    }
  }, [serverLevel, linkSharingLevel]);

  // Permissions polling — owner-gated, kicks off on first owner-confirmed
  // load and refreshes every 30s (the actual correctness guarantee per
  // the L1 doc comment in usePermissionsRefresh.ts).
  useEffect(() => {
    if (!open || !shareData?.chartId || !isAuthenticated || !isOwner) return;
    void loadPermissions();
    const interval = setInterval(() => {
      void loadPermissions();
    }, 30000);
    return () => clearInterval(interval);
  }, [open, shareData?.chartId, isAuthenticated, isOwner, loadPermissions]);

  const handleUpdateLinkSharing = async (newLevel: LinkSharingLevel) => {
    if (!shareData?.chartId || !isAuthenticated) return;
    setPermissionError(null);
    const previousLevel = linkSharingLevel;
    setLinkSharingLevel(newLevel);
    try {
      await ChartService.updateLinkSharing(shareData.chartId, newLevel);
      // Sibling-tab signal: bumping a sentinel key fires the `storage`
      // event in other tabs, which kicks their usePermissionsRefresh.
      try {
        localStorage.setItem(STORAGE_PING_KEY, String(Date.now()));
      } catch {
        // localStorage may be unavailable (privacy mode, quota); the
        // 30s poll catches the divergence regardless.
      }
    } catch (err) {
      setLinkSharingLevel(previousLevel);
      setPermissionError(err instanceof Error ? err.message : 'Failed to update link sharing');
    }
  };

  const handleApprove = async (targetUserId: string) => {
    if (!shareData?.chartId) return;
    setPermissionError(null);
    try {
      await ChartService.approveAccessRequest(shareData.chartId, targetUserId);
      await loadPermissions();
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to approve access');
    }
  };

  const handleReject = async (targetUserId: string) => {
    if (!shareData?.chartId) return;
    setPermissionError(null);
    try {
      await ChartService.rejectAccessRequest(shareData.chartId, targetUserId);
      await loadPermissions();
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to reject access');
    }
  };

  const handleRemove = async (targetUserId: string) => {
    if (!shareData?.chartId) return;
    setPermissionError(null);
    try {
      await ChartService.removePermission(shareData.chartId, targetUserId);
      await loadPermissions();
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to remove permission');
    }
  };

  const handleUpdateLevel = async (targetUserId: string, level: 'owner' | 'edit') => {
    if (!shareData?.chartId) return;
    setPermissionError(null);
    try {
      await ChartService.updatePermissionLevel(shareData.chartId, targetUserId, level);
      await loadPermissions();
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to update permission');
    }
  };

  const copyEmbedCode = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedEmbed(true);
      setTimeout(() => setCopiedEmbed(false), 2000);
    } catch (err) {
      console.error('Failed to copy embed:', err);
    }
  };

  if (!open) return null;

  const aspectW = containerSize?.width || 16;
  const aspectH = containerSize?.height || 9;
  const embedCode =
    shareData?.viewUrl &&
    `<iframe src="${shareData.viewUrl}" width="100%" height="unset" frameborder="0" style="border: none; aspect-ratio: ${aspectW} / ${aspectH};" allowfullscreen></iframe>`;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Share chart"
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4 bg-black/30"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md bg-white rounded-lg shadow-xl border border-gray-200 max-h-[80vh] overflow-y-auto"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">Share chart</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close share dialog"
            className="text-gray-400 hover:text-gray-600 transition-colors"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </header>

        <div className="p-4 space-y-4">
          {shareLoading && !shareData && (
            <div className="text-center py-4">
              <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600" />
              <p className="mt-2 text-gray-600 text-sm">
                {currentEditToken ? 'Loading share links...' : 'Creating shareable links...'}
              </p>
            </div>
          )}

          {shareError && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3">
              <p className="text-red-600 text-sm">{shareError}</p>
              <button
                type="button"
                onClick={() => {
                  setShareError(null);
                  if (currentEditToken) {
                    void loadExistingShareData();
                  } else {
                    void createNewChart();
                  }
                }}
                className="mt-2 text-sm text-red-700 underline hover:no-underline"
              >
                Try again
              </button>
            </div>
          )}

          {shareData && (
            <>
              {/* L1 divergence banner — server changed under our feet. */}
              {divergedFromLocal && (
                <div className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded p-2">
                  Permissions were changed by another tab — reloaded latest.
                </div>
              )}

              {/* Authenticated owners get the access selector. Anonymous
                  edits keep the chart as restricted (the backend treats
                  anon-owned charts as edit-token-gated regardless). */}
              {isAuthenticated && isOwner && (
                <section aria-label="General access">
                  <h3 className="text-xs font-medium text-gray-700 mb-2">General access</h3>
                  <GeneralAccessSelector
                    value={linkSharingLevel}
                    onChange={(next) => void handleUpdateLinkSharing(next)}
                  />
                </section>
              )}

              <LinkCopyRow
                variant="view"
                url={shareData.viewUrl}
                linkSharingLevel={linkSharingLevel}
              />
              <LinkCopyRow
                variant="edit"
                url={shareData.editUrl}
                linkSharingLevel={linkSharingLevel}
              />

              {/* Embed expander — hidden under Restricted mode (plan
                  §99 + §170: a Restricted chart that gets embedded
                  silently breaks for anonymous viewers; hide the
                  affordance to make the failure mode unreachable from
                  here). */}
              {linkSharingLevel !== 'restricted' && embedCode && (
                <section>
                  <button
                    type="button"
                    onClick={() => setShowEmbed((s) => !s)}
                    aria-expanded={showEmbed}
                    className="w-full flex items-center justify-between px-2 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded transition-colors"
                  >
                    <span>Embed code</span>
                    <ChevronDownIcon
                      className={`w-4 h-4 transition-transform ${showEmbed ? 'rotate-180' : ''}`}
                    />
                  </button>
                  {showEmbed && (
                    <div className="mt-2 space-y-2">
                      <textarea
                        readOnly
                        value={embedCode}
                        rows={5}
                        className="w-full px-2 py-1 border border-gray-300 rounded text-xs bg-blue-50 font-mono resize-none overflow-hidden"
                        style={{ lineHeight: '1.5' }}
                      />
                      <button
                        type="button"
                        onClick={() => void copyEmbedCode(embedCode)}
                        className="px-2 py-1 text-xs font-medium bg-blue-100 text-blue-800 rounded hover:bg-blue-200 transition-colors"
                      >
                        {copiedEmbed ? 'Copied' : 'Copy embed code'}
                      </button>
                      <p className="text-xs text-gray-600">
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
                  )}
                </section>
              )}

              {/* Permission Management — owners only. Always inline
                  (no collapse) per user-direction. */}
              {isAuthenticated && isOwner && (
                <section className="pt-3 border-t border-gray-200">
                  <h3 className="text-xs font-medium text-gray-700 mb-2">People</h3>
                  <PermissionsList
                    permissions={permissions}
                    isOwner={isOwner}
                    currentUserEmail={user?.email}
                    onApprove={(id) => void handleApprove(id)}
                    onReject={(id) => void handleReject(id)}
                    onRemove={(id) => void handleRemove(id)}
                    onUpdateLevel={(id, level) => void handleUpdateLevel(id, level)}
                    errorMessage={permissionError}
                    loading={loadingPermissions}
                  />
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
