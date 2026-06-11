// FileMenu — File dropdown in the new TopBar.
//
// Items (per plan §1.2 + PR 7 feedback (10)/(11)/(12)/(38)/(39)):
//   - New ToC (opens "/")
//   - Open recent → side flyout listing recent charts. Opens on hover
//     after a 200ms delay; click is an immediate fallback.
//   - Import JSON (PR 7 feedback (11): direct action, no submenu —
//     opens the hidden JSON file picker on click).
//   - Export → side flyout with JSON / PNG / PDF entries (wired to
//     `exportChart.ts`). Same hover-with-delay treatment.
//   - Delete chart (owner-gated)
//
// Layout (PR 7 feedback (38)): submenus are side flyouts anchored to
// the right edge of the main menu (`absolute top-full left-56 ml-1`,
// where `left-56` mirrors the main menu's `w-56`).
// The main menu stays visible alongside the flyout — both panels are
// children of the same `relative` container, so click-outside (which
// dismisses everything) and Escape continue to work without a back
// button. macOS Finder / Windows context-menu UX.
//
// Hover-area handling: the main menu items schedule open/close on
// pointerenter/leave. The flyout panel itself also clears the close
// timer on pointerenter and re-arms it on pointerleave, so the user
// can move diagonally from "Open recent" into the flyout without it
// snapping shut as the cursor crosses the 4px gap (a "generous
// hover-leave delay" — 250ms — substitutes for a triangular safe
// area, which would be heavier code than the UX benefit warrants).
//
// Open recent flyout width (PR 7 feedback (39)): `w-80` (320px) gives
// chart titles + timestamps comfortable room. Export keeps `w-44`
// because its items are short ("JSON" / "PNG" / "PDF").
//
// Owner-gating rules for Delete (mirrors the rule used by the old
// EditToolbar share dropdown):
//   - Anonymous user with an edit token: shown. Anyone holding the edit
//     token is treated as the de-facto owner for anonymous charts (the
//     edit token IS the credential).
//   - Authenticated user: shown only when `isOwner=true`.
//   - No edit token / no chart ID: hidden (nothing to delete).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { validateChartImport } from '../../utils/validateChartImport';
import { computeFlyoutTop } from './flyoutPosition';
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

  // PR 7 feedback (37) — menubar hover-switch. When the parent
  // (TopBar) lifts the "which top-level menu is open" state, it
  // passes `isOpen` / `onOpenChange` to make this menu controlled,
  // and `onHoverOpen` for the pointerenter handler on the trigger
  // button. When the parent omits these (e.g. MobileMenu, which
  // stacks the menus vertically and doesn't need hover-switching),
  // the component falls back to its internal `useState(open)` and
  // behaves exactly as it did before.
  isOpen?: boolean;
  onOpenChange?: (next: boolean) => void;
  /**
   * Called on `pointerenter` over the trigger button. The parent is
   * responsible for deciding whether to actually open this menu —
   * the standard menubar rule is "switch only when another menu is
   * already open" so a casual mouse-over doesn't open menus.
   */
  onHoverOpen?: () => void;
}

// PR 7 feedback (38): submenus are now side flyouts that render
// alongside the main menu rather than replacing it. `null` = no
// flyout visible; the main menu shows whenever `open === true`. The
// previous `'main'` discriminator is no longer needed (back button
// is gone too).
type Flyout = 'export' | 'recent' | null;

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
  isOpen,
  onOpenChange,
  onHoverOpen,
}: Props) {
  // Controlled vs uncontrolled. When the parent passes `isOpen` the
  // component is fully controlled (this is the menubar-with-hover-
  // switch path used by TopBar). When it doesn't (MobileMenu, tests),
  // we fall back to internal state.
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isOpen ?? internalOpen;
  // `setOpen` is memoized so it can be a stable dep for any effect
  // that needs it (the click-outside effect, currently). Reading the
  // latest `open` via the function-form keeps it correct even when
  // the wrapper closure is stale.
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      if (onOpenChange) {
        // Controlled path: parent owns the value, so just notify.
        // The function-form needs the latest value from props; pass
        // the current `isOpen` (defaults to false if unset, but in
        // controlled mode `isOpen` is always provided).
        const resolved = typeof next === 'function' ? next(isOpen ?? false) : next;
        onOpenChange(resolved);
      } else {
        // Uncontrolled path: React's setState supports both forms.
        setInternalOpen(next);
      }
    },
    [onOpenChange, isOpen],
  );
  const [flyout, setFlyout] = useState<Flyout>(null);
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
  // PR 7 feedback (62): refs used to measure flyout alignment — the
  // main panel, the two flyout-parent items, and the open flyout
  // panel (only one flyout renders at a time, so a single ref).
  const menuPanelRef = useRef<HTMLDivElement>(null);
  const recentItemRef = useRef<HTMLButtonElement>(null);
  const exportItemRef = useRef<HTMLButtonElement>(null);
  const flyoutPanelRef = useRef<HTMLDivElement>(null);
  // Resolved `top` (px) for the open flyout, within the `relative`
  // containing block. `null` until the layout effect below measures —
  // the effect runs before paint, so the unmeasured frame is never
  // visible.
  const [flyoutTop, setFlyoutTop] = useState<number | null>(null);
  // PR 7 feedback (10)/(12)/(38): hover open/close timers for the
  // side-flyout submenus. At most one of each is pending at any
  // moment, so a single ref per direction is enough — moving from
  // Open recent to Export cancels both and re-arms the open timer.
  const hoverOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Delay before a hovered parent item opens its flyout. 200ms is the
  // standard menu-flyout delay (matches Radix UI's NavigationMenu
  // default) — short enough to feel responsive on intentional hover,
  // long enough to ignore the cursor merely passing over en route to
  // another item.
  const HOVER_OPEN_DELAY_MS = 200;
  // Delay before an open flyout closes when the cursor leaves both
  // the parent item and the flyout panel. Generous (250ms) because
  // the cursor has to cross a 4px gap between the main menu and the
  // flyout — this serves as a simple substitute for a triangular
  // safe-area calculation.
  const HOVER_CLOSE_DELAY_MS = 250;
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

  // Latest `flyout` value, available to keydown handler via ref
  // rather than via the useEffect dep list. Keeps the document-
  // listener useEffect dep at `[open]` so flyout transitions don't
  // churn listeners — the tear-down/re-add timing on every flyout
  // change was suspect for flakes in Export click tests under
  // heavy parallel load (see commit b789fa9).
  const flyoutRef = useRef<Flyout>(null);
  useEffect(() => {
    flyoutRef.current = flyout;
  }, [flyout]);

  // When the menu closes (including via parent switching to a sibling
  // menu via menubar hover-switch), drop any open flyout so reopening
  // shows the main view.
  useEffect(() => {
    if (!open) setFlyout(null);
  }, [open]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setFlyout(null);
      }
    };
    // Escape closes the dropdown (accessibility). If a flyout is
    // showing, first Esc closes the flyout; second Esc closes the
    // menu. This mirrors the keyboard pattern used by common menu
    // primitives (Radix UI, Headless UI).
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (flyoutRef.current !== null) {
        setFlyout(null);
        cancelHoverOpen();
        cancelHoverClose();
      } else {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
        document.removeEventListener('keydown', handleKeyDown);
      };
    }
  }, [open, setOpen]);

  // Cancel any pending hover-open/close timers on unmount. Prevents
  // a fire-after-unmount setState (React warns about that, and it'd
  // be a memory leak if the user navigated away mid-hover).
  useEffect(() => {
    return () => {
      if (hoverOpenTimerRef.current !== null) {
        clearTimeout(hoverOpenTimerRef.current);
        hoverOpenTimerRef.current = null;
      }
      if (hoverCloseTimerRef.current !== null) {
        clearTimeout(hoverCloseTimerRef.current);
        hoverCloseTimerRef.current = null;
      }
    };
  }, []);

  // Cancel a pending hover-open. Used by `pointerleave` on a parent
  // item and at the top of `pointerenter` on a different parent item
  // (so moving between parents doesn't queue two simultaneous opens).
  const cancelHoverOpen = () => {
    if (hoverOpenTimerRef.current !== null) {
      clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = null;
    }
  };

  // Cancel a pending hover-close. Used by `pointerenter` on the
  // flyout panel (the cursor reached the panel, so the "leave"
  // intent is over) and by `pointerenter` on the same parent item
  // (cursor returned before the close timer fired).
  const cancelHoverClose = () => {
    if (hoverCloseTimerRef.current !== null) {
      clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
    }
  };

  // Queue a delayed flyout open. Cancels any prior pending open
  // timer and any pending close timer (the user just expressed
  // intent to open, so a stale close from a previous flyout would
  // race and immediately undo this).
  const scheduleHoverOpen = (target: Exclude<Flyout, null>) => {
    cancelHoverOpen();
    cancelHoverClose();
    hoverOpenTimerRef.current = setTimeout(() => {
      setFlyout(target);
      hoverOpenTimerRef.current = null;
    }, HOVER_OPEN_DELAY_MS);
  };

  // Queue a delayed flyout close. Cancels any prior pending open
  // (the cursor moved off the parent before the open fired, so the
  // open is no longer wanted) before arming the close.
  const scheduleHoverClose = () => {
    cancelHoverOpen();
    cancelHoverClose();
    hoverCloseTimerRef.current = setTimeout(() => {
      setFlyout(null);
      hoverCloseTimerRef.current = null;
    }, HOVER_CLOSE_DELAY_MS);
  };

  // PR 7 feedback (62): align the open flyout with its parent item.
  // Layout effect (not plain effect) so the measured position lands
  // before paint. Re-runs when the flyout's content changes (the
  // recent list loads async and changes the flyout's height, which
  // feeds the viewport-bottom clamp).
  useLayoutEffect(() => {
    if (flyout === null) {
      setFlyoutTop(null);
      return;
    }
    const panel = menuPanelRef.current;
    const item = flyout === 'recent' ? recentItemRef.current : exportItemRef.current;
    const flyoutEl = flyoutPanelRef.current;
    const root = ref.current;
    if (!panel || !item || !flyoutEl || !root) return;
    setFlyoutTop(
      computeFlyoutTop({
        panelOffsetTop: panel.offsetTop,
        itemOffsetTop: item.offsetTop,
        flyoutHeight: flyoutEl.getBoundingClientRect().height,
        anchorTop: root.getBoundingClientRect().top,
        viewportHeight: window.innerHeight,
      }),
    );
  }, [flyout, recent, loadingRecent, errorRecent]);

  // Lazy-load recent charts when the flyout opens.
  useEffect(() => {
    if (flyout !== 'recent') return;
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
  }, [flyout, isAuthenticated, user?.sub, retryNonce]);

  // PR 5: replace `window.confirm()` with the shared ConfirmModal
  // primitive. The dropdown closes immediately so the modal anchors
  // to the page instead of being clipped by the click-outside handler
  // attached to this menu.
  const handleDeleteClick = () => {
    if (!currentChartId) return;
    setConfirmDeleteOpen(true);
    setOpen(false);
    setFlyout(null);
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
    setFlyout(null);
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
      // optional connections/waypoints. `validateChartImport` covers
      // waypoint validation (rejects NaN/string/null/non-array
      // shapes), so PR 7's adversarial / corrupted imports can't
      // NaN-poison the SVG path.
      const result = validateChartImport(parsed);
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
        onPointerEnter={onHoverOpen}
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
          ref={menuPanelRef}
          className="absolute top-full mt-1 left-0 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50"
        >
          <a
            href="/"
            onPointerEnter={cancelHoverOpen}
            className="flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
            role="menuitem"
          >
            <PlusIcon className="w-4 h-4 text-gray-500" />
            New ToC
          </a>
          <button
            type="button"
            ref={recentItemRef}
            onClick={() => {
              // Click is the immediate-open path. Cancel any pending
              // open/close so the click doesn't race with a stale
              // timer (e.g. user hovered briefly then clicked).
              cancelHoverOpen();
              cancelHoverClose();
              setFlyout('recent');
            }}
            onPointerEnter={() => scheduleHoverOpen('recent')}
            onPointerLeave={() => {
              // If the flyout for this item is already open, don't
              // cancel hover-open — instead arm the close timer so
              // the cursor crossing the 4px gap to the flyout has
              // time to land before we dismiss.
              cancelHoverOpen();
              if (flyout === 'recent') scheduleHoverClose();
            }}
            onFocus={() => scheduleHoverOpen('recent')}
            // aria-haspopup + aria-expanded reflect the side flyout
            // for assistive tech (announce "submenu, expanded").
            aria-haspopup="menu"
            aria-expanded={flyout === 'recent'}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
            role="menuitem"
            data-testid="file-menu-open-recent"
          >
            <span className="flex items-center gap-2">
              <ClockIcon className="w-4 h-4 text-gray-500" />
              Open recent
            </span>
            <ChevronDownIcon className="w-3 h-3 -rotate-90" />
          </button>
          <button
            type="button"
            onClick={handleImportClick}
            disabled={!canImport}
            onPointerEnter={() => {
              // Import JSON is a leaf action — entering it should
              // cancel any pending open AND close any visible flyout
              // (the cursor moved away from Open recent / Export).
              cancelHoverOpen();
              if (flyout !== null) scheduleHoverClose();
            }}
            className={`w-full flex items-center gap-2 px-3 py-2 text-sm ${
              canImport ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-400 cursor-not-allowed'
            }`}
            role="menuitem"
            data-testid="file-menu-import-json"
          >
            <ArrowUpTrayIcon className="w-4 h-4 text-gray-500" />
            Import JSON
          </button>
          <button
            type="button"
            ref={exportItemRef}
            onClick={() => {
              cancelHoverOpen();
              cancelHoverClose();
              setFlyout('export');
            }}
            onPointerEnter={() => scheduleHoverOpen('export')}
            onPointerLeave={() => {
              cancelHoverOpen();
              if (flyout === 'export') scheduleHoverClose();
            }}
            onFocus={() => scheduleHoverOpen('export')}
            aria-haspopup="menu"
            aria-expanded={flyout === 'export'}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100"
            role="menuitem"
            data-testid="file-menu-export"
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
                onPointerEnter={() => {
                  cancelHoverOpen();
                  if (flyout !== null) scheduleHoverClose();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50"
                role="menuitem"
              >
                <TrashIcon className="w-4 h-4" />
                Delete chart
              </button>
            </>
          )}
        </div>
      )}

      {/* Side flyout: Export. Rendered as a sibling to the main menu
        so both panels are visible simultaneously and the outer
        `relative` ref still encloses the click-outside hit-test.
        Positioning: `left-56` matches the main menu's `w-56` so the
        flyout starts at the menu's right edge; `ml-1` adds a 4px
        gap. We can't use `left-full` here because the `relative`
        container is sized by the File trigger button (not the
        absolute-positioned menu), so `left-full` would put the
        flyout on top of the menu's right half. Vertical position is
        the measured `flyoutTop` (PR 7 feedback (62)): aligned with
        the parent "Export" item, clamped to the viewport. Until the
        pre-paint measurement lands, `top` is unset for one unpainted
        frame. */}
      {open && flyout === 'export' && (
        <div
          role="menu"
          ref={flyoutPanelRef}
          // Re-enter cancels the pending close (cursor reached the
          // flyout). Leave arms a delayed close, giving the user time
          // to move back to the parent or another flyout-targeted
          // item.
          onPointerEnter={cancelHoverClose}
          onPointerLeave={scheduleHoverClose}
          style={{ top: flyoutTop !== null ? `${flyoutTop}px` : undefined }}
          className="absolute left-56 ml-1 w-44 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50"
          data-testid="file-menu-export-flyout"
        >
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
        </div>
      )}

      {/* Side flyout: Open recent. Wider (w-80) than Export because
        chart titles + timestamps need horizontal room (PR 7
        feedback (39)). */}
      {open && flyout === 'recent' && (
        <div
          role="menu"
          ref={flyoutPanelRef}
          onPointerEnter={cancelHoverClose}
          onPointerLeave={scheduleHoverClose}
          style={{ top: flyoutTop !== null ? `${flyoutTop}px` : undefined }}
          className="absolute left-56 ml-1 w-80 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50"
          data-testid="file-menu-recent-flyout"
        >
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
