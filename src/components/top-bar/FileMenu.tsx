// FileMenu — File dropdown in the new TopBar.
//
// Items (per plan §1.2):
//   - New ToC (opens "/")
//   - Open recent (anchors a recent-charts list; reuses ChartService)
//   - Import → JSON (placeholder until PR 6)
//   - Export → JSON / PNG / PDF (placeholders until PR 6)
//   - Delete chart (owner-gated)
//
// Owner-gating rules for Delete (mirrors the rule used by the old
// EditToolbar share dropdown):
//   - Anonymous user with an edit token: shown. Anyone holding the edit
//     token is treated as the de-facto owner for anonymous charts (the
//     edit token IS the credential).
//   - Authenticated user: shown only when `isOwner=true`.
//   - No edit token / no chart ID: hidden (nothing to delete).
import { useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, TrashIcon, ClockIcon, PlusIcon } from '@heroicons/react/24/outline';
import { useAuth0 } from '@auth0/auth0-react';
import { ChartService, type UserChart } from '../../services/chartService';
import { ConfirmModal } from '../ConfirmModal';

interface Props {
  isAuthenticated: boolean;
  /** Server-verified `isOwner` from getChart response, when available. */
  isOwner: boolean;
  currentEditToken: string | null;
  currentChartId: string | null;
  onDeleteChart: (chartId: string) => void;
}

type Submenu = 'main' | 'import' | 'export' | 'recent';

export function FileMenu({
  isAuthenticated,
  isOwner,
  currentEditToken,
  currentChartId,
  onDeleteChart,
}: Props) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<Submenu>('main');
  const [recent, setRecent] = useState<UserChart[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(false);
  // errorRecent: distinguishes "load failed" from "empty list". Without
  // this, network/5xx/auth/localStorage failures collapse to the same
  // "No charts" copy and the user concludes their data was lost.
  const [errorRecent, setErrorRecent] = useState<string | null>(null);
  // Bumping this counter re-triggers the load effect (used by the
  // Retry button). Avoids manual re-implementing the effect body.
  const [retryNonce, setRetryNonce] = useState(0);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { user } = useAuth0();

  // Anyone holding an edit token can delete an anonymous chart. For
  // authenticated callers, gate on isOwner (the server-verified flag).
  const canDelete = Boolean(
    currentEditToken && currentChartId && (isAuthenticated ? isOwner : true),
  );

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSubmenu('main');
      }
    };
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  // Lazy-load recent charts when the submenu opens.
  useEffect(() => {
    if (submenu !== 'recent') return;
    const load = async () => {
      setErrorRecent(null);
      if (isAuthenticated && user?.sub) {
        setLoadingRecent(true);
        try {
          const charts = await ChartService.getUserCharts(user.sub);
          setRecent(charts);
        } catch (err) {
          console.error('[FileMenu] failed to load user charts', err);
          setErrorRecent(err instanceof Error ? err.message : 'Failed to load charts');
        } finally {
          setLoadingRecent(false);
        }
      } else {
        // Anonymous: pull from localStorage (same shape as the old
        // EditToolbar Open dropdown).
        try {
          const stored = localStorage.getItem('recentEditCharts');
          if (!stored) {
            setRecent([]);
            return;
          }
          interface StoredEntry {
            chartId?: string;
            title?: string;
            editUrl: string;
            timestamp: number;
          }
          const parsed = JSON.parse(stored) as StoredEntry[];
          parsed.sort((a, b) => b.timestamp - a.timestamp);
          const mapped: UserChart[] = parsed.slice(0, 10).map((c) => ({
            chartId: c.chartId || '',
            title: c.title || 'Theory of Change',
            editUrl: c.editUrl,
            viewUrl: '',
            updatedAt: new Date(c.timestamp).toISOString(),
            createdAt: new Date(c.timestamp).toISOString(),
            permissionLevel: 'owner' as const,
          }));
          setRecent(mapped);
        } catch (err) {
          console.error('[FileMenu] failed to load anon recent charts', err);
          setErrorRecent(err instanceof Error ? err.message : 'Failed to load charts');
        }
      }
    };
    void load();
  }, [submenu, isAuthenticated, user?.sub, retryNonce]);

  // PR 5: replace `window.confirm()` with the shared ConfirmModal
  // primitive. The dropdown closes immediately so the modal anchors
  // to the page instead of being clipped by the click-outside handler
  // attached to this menu.
  const handleDeleteClick = () => {
    if (!currentChartId) return;
    setConfirmDeleteOpen(true);
    setOpen(false);
    setSubmenu('main');
  };

  const handleConfirmDelete = () => {
    if (currentChartId) {
      onDeleteChart(currentChartId);
    }
    setConfirmDeleteOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="px-2 sm:px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded transition-colors flex items-center gap-1"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        File
        <ChevronDownIcon className="w-3 h-3" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full mt-1 left-0 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50"
        >
          {submenu === 'main' && (
            <>
              <a
                href="/"
                className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                role="menuitem"
              >
                <PlusIcon className="w-4 h-4 text-gray-500" />
                New ToC
              </a>
              <button
                type="button"
                onClick={() => setSubmenu('recent')}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                role="menuitem"
              >
                <span className="flex items-center gap-2">
                  <ClockIcon className="w-4 h-4 text-gray-500" />
                  Open recent
                </span>
                <ChevronDownIcon className="w-3 h-3 -rotate-90" />
              </button>
              <button
                type="button"
                onClick={() => setSubmenu('import')}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                role="menuitem"
              >
                Import
                <ChevronDownIcon className="w-3 h-3 -rotate-90" />
              </button>
              <button
                type="button"
                onClick={() => setSubmenu('export')}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                role="menuitem"
              >
                Export
                <ChevronDownIcon className="w-3 h-3 -rotate-90" />
              </button>

              {canDelete && (
                <>
                  <div className="my-1 h-px bg-gray-100" />
                  <button
                    type="button"
                    onClick={handleDeleteClick}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                    role="menuitem"
                  >
                    <TrashIcon className="w-4 h-4" />
                    Delete chart
                  </button>
                </>
              )}
            </>
          )}

          {submenu === 'import' && (
            <>
              <button
                type="button"
                onClick={() => setSubmenu('main')}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:bg-gray-100"
              >
                ← Back
              </button>
              <button
                type="button"
                disabled
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-400 cursor-not-allowed"
                role="menuitem"
                title="Coming soon"
              >
                <span>JSON</span>
                <span className="text-xs italic">Soon</span>
              </button>
            </>
          )}

          {submenu === 'export' && (
            <>
              <button
                type="button"
                onClick={() => setSubmenu('main')}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:bg-gray-100"
              >
                ← Back
              </button>
              {(['JSON', 'PNG', 'PDF'] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  disabled
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-400 cursor-not-allowed"
                  role="menuitem"
                  title="Coming soon"
                >
                  <span>{fmt}</span>
                  <span className="text-xs italic">Soon</span>
                </button>
              ))}
            </>
          )}

          {submenu === 'recent' && (
            <>
              <button
                type="button"
                onClick={() => setSubmenu('main')}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-gray-500 hover:bg-gray-100"
              >
                ← Back
              </button>
              {loadingRecent ? (
                <div className="px-3 py-4 text-center text-xs text-gray-500">Loading…</div>
              ) : errorRecent ? (
                <div className="px-3 py-3 text-xs text-red-700">
                  <div>Couldn’t load recent charts.</div>
                  <button
                    type="button"
                    onClick={() => setRetryNonce((n) => n + 1)}
                    className="mt-1 underline text-red-700 hover:text-red-800"
                  >
                    Retry
                  </button>
                </div>
              ) : recent.length === 0 ? (
                <div className="px-3 py-3 text-xs text-gray-500">
                  {isAuthenticated ? 'No saved charts yet.' : 'No local charts found.'}
                </div>
              ) : (
                <div className="max-h-72 overflow-y-auto py-1">
                  {recent.map((chart, idx) => (
                    <a
                      key={chart.chartId || idx}
                      href={chart.editUrl}
                      className="block px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                    >
                      <div className="font-medium truncate">{chart.title}</div>
                      <div className="text-xs text-gray-500">
                        {new Date(chart.updatedAt).toLocaleDateString()}
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
      <ConfirmModal
        open={confirmDeleteOpen}
        title="Delete chart?"
        body="Are you sure you want to delete this chart? This cannot be undone."
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
    </div>
  );
}
