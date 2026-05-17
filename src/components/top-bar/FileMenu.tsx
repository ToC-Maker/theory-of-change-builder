// FileMenu — File dropdown in the new TopBar.
//
// Items (per plan §1.2):
//   - New ToC (opens "/")
//   - Open recent (anchors a recent-charts list; reuses ChartService)
//   - Import → JSON (PR 6 Task 6.2: wired to a hidden file picker)
//   - Export → JSON / PNG / PDF (PR 6 Task 6.2: wired to `exportChart.ts`)
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
import {
  ChevronDownIcon,
  TrashIcon,
  ClockIcon,
  PlusIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
} from '@heroicons/react/24/outline';
import { useAuth0 } from '@auth0/auth0-react';
import { ChartService, type UserChart } from '../../services/chartService';
import { ConfirmModal } from '../ConfirmModal';
import type { ToCData } from '../../types';
import { validateToCShape } from '../../utils/validateToCShape';
// `src/utils/exportChart.ts` is dynamic-imported inside handlers, not
// statically imported here. The library it pulls in (html-to-image,
// jspdf) is large; Vite chunks it into its own bundle so the user
// only downloads it when they click Export. Doing the dynamic import
// once at click time also keeps JSON / PNG / PDF on the same import
// path so all three live in the same chunk.

interface Props {
  isAuthenticated: boolean;
  /** Server-verified `isOwner` from getChart response, when available. */
  isOwner: boolean;
  currentEditToken: string | null;
  currentChartId: string | null;
  onDeleteChart: (chartId: string) => void;

  // PR 6 (Task 6.2) — export + import wiring.
  /**
   * Current graph state. Used as the source for Export → JSON, and to
   * (a) derive the export filename from `data.title` and (b) check
   * whether Import should warn about overwriting existing nodes.
   *
   * Optional so existing call sites (some tests) don't break; when
   * absent the export entries are disabled and the import shows a
   * generic confirm. App.tsx and MobileMenu both pass the live `data`.
   */
  data?: ToCData;
  /**
   * Replace the current graph with imported JSON. Called after the
   * file picker resolves, the file is JSON-parsed, and (if existing
   * graph has nodes) the user has confirmed the overwrite.
   */
  onImportJson?: (next: ToCData) => void;
}

type Submenu = 'main' | 'import' | 'export' | 'recent';

/**
 * Lowercase, slugify, trim. Used to derive a sane filename from a
 * (possibly empty or fancy-Unicode) chart title. Falls back to
 * 'theory-of-change' when the slug is empty.
 */
function slugify(title: string | undefined): string {
  const slug = (title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    // `\p{M}` matches every Unicode combining mark across all blocks
    // (not just the basic "Combining Diacritical Marks" range). After
    // NFKD decomposition we want every combining mark stripped.
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'theory-of-change';
}

/**
 * Count nodes across all sections + columns. Used to decide whether
 * Import should warn about overwriting. Anything > 0 triggers the
 * confirm flow.
 */
function totalNodeCount(data: ToCData | undefined): number {
  if (!data?.sections) return 0;
  let n = 0;
  for (const s of data.sections) {
    for (const c of s.columns ?? []) {
      n += c.nodes?.length ?? 0;
    }
  }
  return n;
}

export function FileMenu({
  isAuthenticated,
  isOwner,
  currentEditToken,
  currentChartId,
  onDeleteChart,
  data,
  onImportJson,
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
  // Pending-import state: holds the parsed graph while the
  // confirmation modal is open. `null` means no import pending.
  const [pendingImport, setPendingImport] = useState<ToCData | null>(null);
  // Generating-export indicator. The Export → PNG/PDF actions can take
  // a few hundred ms because they dynamic-import their libraries and
  // walk the layout tree. Disabling the button + showing a label
  // gives the user feedback so they don't double-click and queue
  // two captures.
  const [busyFormat, setBusyFormat] = useState<'PNG' | 'PDF' | null>(null);
  // Separate error states for export vs import so the modal title can
  // accurately describe what failed. Both states render via the same
  // ConfirmModal primitive below — only one is open at a time.
  const [exportError, setExportError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { user } = useAuth0();

  // Anyone holding an edit token can delete an anonymous chart. For
  // authenticated callers, gate on isOwner (the server-verified flag).
  const canDelete = Boolean(
    currentEditToken && currentChartId && (isAuthenticated ? isOwner : true),
  );

  // Export entries are only meaningful when there's a graph to export.
  // FileMenu callers without `data` (tests, viewer mode) keep the
  // entries inert.
  const canExport = Boolean(data);
  const canImport = Boolean(onImportJson);

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

  // PR 6 (Task 6.2): export actions. Closes the dropdown immediately
  // so the user sees the click was registered, then runs the export.
  const closeAndReset = () => {
    setOpen(false);
    setSubmenu('main');
  };

  const handleExportJson = async () => {
    if (!data) return;
    const filename = slugify(data.title);
    closeAndReset();
    try {
      const mod = await import('../../utils/exportChart');
      mod.exportToJson(data, filename);
    } catch (err) {
      console.error('[FileMenu] JSON export failed', err);
      setExportError('JSON export failed. See console for details.');
    }
  };

  const handleExportImage = async (format: 'PNG' | 'PDF') => {
    if (!data) return;
    const root = document.querySelector<HTMLElement>('[data-export-root]');
    if (!root) {
      console.error('[FileMenu] no [data-export-root] element found in DOM');
      setExportError('Could not find the canvas to export. Reload the page and try again.');
      return;
    }
    const filename = slugify(data.title);
    setBusyFormat(format);
    setExportError(null);
    closeAndReset();
    try {
      // Dynamic-import inside the handler keeps the library out of
      // the main bundle until the user clicks (Vite chunk-split).
      const mod = await import('../../utils/exportChart');
      if (format === 'PNG') {
        await mod.exportToPng(root, filename);
      } else {
        await mod.exportToPdf(root, filename);
      }
    } catch (err) {
      console.error(`[FileMenu] ${format} export failed`, err);
      // Surface the underlying message when available so the user (or
      // a maintainer reading a bug report) gets a real signal instead
      // of a generic "may be too large" guess.
      const detail = err instanceof Error ? err.message : String(err);
      setExportError(`${format} export failed: ${detail} (see console for details).`);
    } finally {
      setBusyFormat(null);
    }
  };

  // PR 6 (Task 6.2): import.
  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input *before* the early-return so a subsequent import
    // of the same file still fires `change` (browsers suppress the
    // event for an identical-named file otherwise). Unconditional on
    // purpose so cancelling and reselecting works.
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      // Deep shape validation — walk sections/columns/nodes and any
      // optional connections/waypoints. `validateToCShape` covers
      // waypoint validation (rejects NaN/string/null/non-array
      // shapes), so PR 7's adversarial / corrupted imports can't
      // NaN-poison the SVG path.
      const result = validateToCShape(parsed);
      if (!result.ok) {
        // Heuristic: prefer the most-likely-recognizable framing when
        // the top-level keys themselves are wrong (a JSON file from a
        // different app entirely), vs a specific "looks like a ToC
        // chart but malformed at path X" framing when the shape is
        // recognizable but corrupt.
        const isTopLevelMissing =
          result.reason === 'top-level is not an object' ||
          result.reason === 'sections is not an array';
        setImportError(
          isTopLevelMissing
            ? 'That file does not look like a Theory of Change chart (missing `sections` array).'
            : `Imported file is malformed: ${result.reason}.`,
        );
        return;
      }
      const validData = result.data;
      closeAndReset();
      if (totalNodeCount(data) > 0) {
        // Existing graph is non-empty; require confirmation before
        // overwriting.
        setPendingImport(validData);
      } else {
        // Empty graph: apply immediately, no confirm.
        onImportJson?.(validData);
      }
    } catch (err) {
      console.error('[FileMenu] import failed', err);
      setImportError(
        err instanceof SyntaxError
          ? 'Could not parse that file as JSON. Is it the right format?'
          : 'Could not read the file. Please try again.',
      );
    }
  };

  const handleConfirmImport = () => {
    if (pendingImport) {
      onImportJson?.(pendingImport);
    }
    setPendingImport(null);
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
        {busyFormat && (
          <span className="ml-1 text-xs text-gray-500" aria-live="polite">
            ({busyFormat}…)
          </span>
        )}
        <ChevronDownIcon className="w-3 h-3" />
      </button>

      {/* Hidden file input used by Import → JSON. Lives outside the
        dropdown subtree so clicking it doesn't fire the dropdown's
        click-outside handler and unmount us mid-pick. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleFileChosen}
        className="hidden"
        data-testid="file-menu-import-input"
      />

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
                <span className="flex items-center gap-2">
                  <ArrowUpTrayIcon className="w-4 h-4 text-gray-500" />
                  Import
                </span>
                <ChevronDownIcon className="w-3 h-3 -rotate-90" />
              </button>
              <button
                type="button"
                onClick={() => setSubmenu('export')}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
                role="menuitem"
              >
                <span className="flex items-center gap-2">
                  <ArrowDownTrayIcon className="w-4 h-4 text-gray-500" />
                  Export
                </span>
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
                onClick={handleImportClick}
                disabled={!canImport}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm ${
                  canImport ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-400 cursor-not-allowed'
                }`}
                role="menuitem"
                data-testid="file-menu-import-json"
              >
                <span>JSON</span>
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
              <button
                type="button"
                onClick={() => void handleExportJson()}
                disabled={!canExport}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm ${
                  canExport ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-400 cursor-not-allowed'
                }`}
                role="menuitem"
                data-testid="file-menu-export-json"
              >
                <span>JSON</span>
              </button>
              <button
                type="button"
                onClick={() => void handleExportImage('PNG')}
                disabled={!canExport || busyFormat !== null}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm ${
                  canExport && busyFormat === null
                    ? 'text-gray-700 hover:bg-gray-100'
                    : 'text-gray-400 cursor-not-allowed'
                }`}
                role="menuitem"
                data-testid="file-menu-export-png"
              >
                <span>PNG</span>
                {busyFormat === 'PNG' && <span className="text-xs italic">Generating…</span>}
              </button>
              <button
                type="button"
                onClick={() => void handleExportImage('PDF')}
                disabled={!canExport || busyFormat !== null}
                className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-sm ${
                  canExport && busyFormat === null
                    ? 'text-gray-700 hover:bg-gray-100'
                    : 'text-gray-400 cursor-not-allowed'
                }`}
                role="menuitem"
                data-testid="file-menu-export-pdf"
              >
                <span>PDF</span>
                {busyFormat === 'PDF' && <span className="text-xs italic">Generating…</span>}
              </button>
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
      <ConfirmModal
        open={pendingImport !== null}
        title="Replace current chart?"
        body={`Importing this file will replace the current chart (${totalNodeCount(data)} ${
          totalNodeCount(data) === 1 ? 'node' : 'nodes'
        }). This action can be undone.`}
        confirmLabel="Replace"
        confirmVariant="danger"
        onConfirm={handleConfirmImport}
        onCancel={() => setPendingImport(null)}
      />
      <ConfirmModal
        open={exportError !== null}
        title="Export failed"
        body={exportError ?? ''}
        confirmLabel="OK"
        confirmVariant="primary"
        onConfirm={() => setExportError(null)}
        onCancel={() => setExportError(null)}
      />
      <ConfirmModal
        open={importError !== null}
        title="Import failed"
        body={importError ?? ''}
        confirmLabel="OK"
        confirmVariant="primary"
        onConfirm={() => setImportError(null)}
        onCancel={() => setImportError(null)}
      />
    </div>
  );
}
