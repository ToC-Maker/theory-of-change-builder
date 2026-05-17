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
// State ownership (PR 2 fix-pass):
//   - App.tsx owns `permissions`, `linkSharingLevel`, `permissionsLoading`,
//     and `permissionsFetchError`. It polls every 30s and reacts to
//     cross-tab storage events. ShareDialog is a presentational consumer.
//   - Write handlers (approve/reject/remove/updateLevel/updateLinkSharing)
//     call ChartService directly, then call `onPermissionsChanged()` so
//     App refetches.
//   - `linkSharingLevel` writes go through `onOptimisticLinkSharingLevel`
//     so the App-level state updates immediately; on failure ShareDialog
//     rolls back via the same channel.
//   - Divergence banner: when the prop level changes to something other
//     than what we last acknowledged AND no local write is in flight —
//     i.e. a sibling tab flipped it — surface the banner until acked.
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
import { ChartService, type CreateChartResponse } from '../../services/chartService';
import type { Permission, LinkSharingLevel } from '../../../shared/permissions';
import type { ToCData } from '../../types';
import { GeneralAccessSelector } from './GeneralAccessSelector';
import { LinkCopyRow } from './LinkCopyRow';
import { PermissionsList } from './PermissionsList';

export interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  data: ToCData;
  currentEditToken: string | null;
  /** Width/height for the embed iframe aspect ratio. */
  containerSize?: { width: number; height: number };
  onChartCreated?: (token: string, chartId: string) => void;
  /** App-owned permissions array (single source of truth). */
  permissions: Permission[];
  /** App-owned current link-sharing level (single source of truth). */
  linkSharingLevel: LinkSharingLevel;
  /** True while App is fetching permissions; surfaces loading UI. */
  permissionsLoading: boolean;
  /** Last permissions-fetch error, if any (surfaced as a warning banner). */
  permissionsFetchError: string | null;
  /** Tell App to refetch permissions (e.g. after a write). */
  onPermissionsChanged: () => Promise<void> | void;
  /**
   * Optimistic-update channel: ShareDialog calls this with the next
   * level *before* the network write resolves so the App-level state
   * updates instantly. On success the next poll confirms; on failure
   * ShareDialog calls this again with the previous level to roll back.
   */
  onOptimisticLinkSharingLevel: (level: LinkSharingLevel) => void;
}

const STORAGE_PING_KEY = 'toc:permissions';

export function ShareDialog({
  open,
  onClose,
  data,
  currentEditToken,
  containerSize,
  onChartCreated,
  permissions,
  linkSharingLevel,
  permissionsLoading,
  permissionsFetchError,
  onPermissionsChanged,
  onOptimisticLinkSharingLevel,
}: ShareDialogProps) {
  const { user, isAuthenticated } = useAuth0();
  const navigate = useNavigate();

  const [shareData, setShareData] = useState<CreateChartResponse | null>(null);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [showEmbed, setShowEmbed] = useState(false);
  const [copiedEmbed, setCopiedEmbed] = useState(false);
  // Divergence-banner acknowledgement. Reset whenever the dialog opens
  // or a fresh divergence is observed; cleared by the user clicking
  // "Got it".
  const [bannerAcked, setBannerAcked] = useState(false);

  // Track the last level we believe both sides agree on. When the prop
  // moves to something different and no write is in flight, that's a
  // genuine cross-tab divergence to surface.
  const ackedLevelRef = useRef<LinkSharingLevel>(linkSharingLevel);
  // True from `onOptimisticLinkSharingLevel` call until the write
  // resolves. Prop changes during this window are assumed to be the
  // App's confirmation of our write, not a sibling-tab change.
  const writeInFlightRef = useRef(false);

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

  // Reset the banner-ack flag each time the dialog opens, and snapshot
  // the prop as the acked baseline. We only want to surface divergence
  // observed *while* the dialog is open.
  useEffect(() => {
    if (open) {
      setBannerAcked(false);
      ackedLevelRef.current = linkSharingLevel;
    }
    // Snapshot-on-open only. Re-running on prop changes would erase
    // a genuine divergence before the user sees it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Detect divergence: when the prop level changes to something other
  // than what we last acknowledged AND no local write is in flight,
  // unack the banner.
  useEffect(() => {
    if (writeInFlightRef.current) return;
    if (linkSharingLevel !== ackedLevelRef.current) {
      setBannerAcked(false);
    }
  }, [linkSharingLevel]);

  const showDivergenceBanner =
    !writeInFlightRef.current && linkSharingLevel !== ackedLevelRef.current && !bannerAcked;

  const handleAcknowledgeDivergence = () => {
    ackedLevelRef.current = linkSharingLevel;
    setBannerAcked(true);
  };

  const handleUpdateLinkSharing = async (newLevel: LinkSharingLevel) => {
    if (!shareData?.chartId || !isAuthenticated) return;
    setPermissionError(null);
    const previousLevel = linkSharingLevel;
    writeInFlightRef.current = true;
    onOptimisticLinkSharingLevel(newLevel);
    ackedLevelRef.current = newLevel;
    try {
      await ChartService.updateLinkSharing(shareData.chartId, newLevel);
      // Sibling-tab signal: bumping a sentinel key fires the `storage`
      // event in other tabs, which kicks App's usePermissionsRefresh.
      try {
        localStorage.setItem(STORAGE_PING_KEY, String(Date.now()));
      } catch {
        // localStorage may be unavailable (privacy mode, quota); the
        // 30s poll catches the divergence regardless.
      }
      await onPermissionsChanged();
    } catch (err) {
      onOptimisticLinkSharingLevel(previousLevel);
      ackedLevelRef.current = previousLevel;
      setPermissionError(err instanceof Error ? err.message : 'Failed to update link sharing');
    } finally {
      writeInFlightRef.current = false;
    }
  };

  const handleApprove = async (targetUserId: string) => {
    if (!shareData?.chartId) return;
    setPermissionError(null);
    try {
      await ChartService.approveAccessRequest(shareData.chartId, targetUserId);
      await onPermissionsChanged();
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to approve access');
    }
  };

  const handleReject = async (targetUserId: string) => {
    if (!shareData?.chartId) return;
    setPermissionError(null);
    try {
      await ChartService.rejectAccessRequest(shareData.chartId, targetUserId);
      await onPermissionsChanged();
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to reject access');
    }
  };

  const handleRemove = async (targetUserId: string) => {
    if (!shareData?.chartId) return;
    setPermissionError(null);
    try {
      await ChartService.removePermission(shareData.chartId, targetUserId);
      await onPermissionsChanged();
    } catch (err) {
      setPermissionError(err instanceof Error ? err.message : 'Failed to remove permission');
    }
  };

  const handleUpdateLevel = async (targetUserId: string, level: 'owner' | 'edit') => {
    if (!shareData?.chartId) return;
    setPermissionError(null);
    try {
      await ChartService.updatePermissionLevel(shareData.chartId, targetUserId, level);
      await onPermissionsChanged();
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
              {/* L1 divergence banner — server changed under our feet.
                  Persists until the user clicks "Got it". */}
              {showDivergenceBanner && (
                <div
                  role="status"
                  className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded p-2 flex items-start justify-between gap-2"
                >
                  <span>Permissions were changed by another tab — reloaded latest.</span>
                  <button
                    type="button"
                    onClick={handleAcknowledgeDivergence}
                    className="text-blue-700 underline hover:no-underline font-medium flex-shrink-0"
                  >
                    Got it
                  </button>
                </div>
              )}

              {/* L1 fetch-error banner — the App-level poller couldn't
                  verify the server's current sharing level (transient
                  401 during Auth0 silent refresh, 5xx blip, offline).
                  Surfacing it prevents the divergence mitigation from
                  silently no-op'ing on first failure. */}
              {permissionsFetchError && (
                <div
                  role="status"
                  className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2"
                >
                  Couldn't verify current sharing level — actions may use stale state.
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
                    loading={permissionsLoading}
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
