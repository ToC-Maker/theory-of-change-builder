// TopBar — main horizontal navigation bar mounted at the top of the app.
//
// Layout (per plan §1.1):
//   left:    [FileMenu] [FormatMenu] [HelpPanel] | [Undo] [Redo]
//   right:   [SaveIndicator] [Share] [Profile]
//
// Below the `md` breakpoint (`window.innerWidth < 768`) the bar
// collapses to a hamburger which opens `MobileMenu` carrying the same
// surface. The breakpoint is decided here so the children stay simple
// (no per-component matchMedia).
//
// The `breakpoint` prop is for tests — they pass `"sm"`/`"md"` to skip
// the matchMedia path. In production the prop is left undefined and the
// component decides at runtime.
//
// L2 button-focus mitigation: undo/redo buttons get
// `onMouseDown={(e) => e.preventDefault()}` so clicking them while a
// text input has focus doesn't shift focus to the button before
// `handleUndo`/`handleRedo` read `document.activeElement`. (PR 0
// applied this to the old EditToolbar; the new TopBar must keep it.)
//
// Menubar hover-switch (PR 7 feedback (37)): TopBar lifts the
// "which top-level menu is open" state (`openMenuId`) so siblings
// can switch on hover once any menu is already open. The three menu
// triggers also sit edge-to-edge in their own no-gap flex wrapper
// (the parent's `gap-3` was creating a 12px dead zone between menu
// buttons that broke `pointerenter` switching). See `handleHoverOpen`
// below for the standard menubar rule: hover only switches when a
// sibling is already open — a casual mouse-over does NOT open menus.
import { useEffect, useState } from 'react';
import { ShareIcon } from '@heroicons/react/24/outline';
import type { ToCData } from '../../types';
import { FileMenu } from './FileMenu';
import { FormatMenu } from './FormatMenu';
import { HelpPanel } from './HelpPanel';
import { MobileMenu } from './MobileMenu';
import { SaveIndicator, type SaveError } from './SaveIndicator';
import { shortcuts } from '../../utils/keyboardShortcuts';

type Breakpoint = 'sm' | 'md';

export interface TopBarProps {
  // Mode + selection (PR 1 strips the in-bar mode toggle; viewer mode
  // shows a read-only badge instead).
  editMode: boolean;
  showEditButton: boolean;

  // Undo / redo.
  undoHistory: ToCData[];
  redoHistory: ToCData[];
  handleUndo: () => void;
  handleRedo: () => void;

  // Save status.
  isSaving: boolean;
  saveError: SaveError | null;
  currentEditToken: string | null;

  // Format menu pass-through.
  fontFamily: string;
  setFontFamily: (next: string) => void;
  textSize: number;
  setTextSize: (next: number) => void;
  curvature: number;
  setCurvature: (next: number) => void;
  columnPadding: number;
  setColumnPadding: (next: number) => void;
  sectionPadding: number;
  setSectionPadding: (next: number) => void;

  // File menu pass-through.
  isAuthenticated?: boolean;
  isOwner?: boolean;
  currentChartId?: string | null;
  onDeleteChart?: (chartId: string) => void;
  // PR 6 Task 6.2: Export + Import wiring. `data` feeds the export
  // entries (filename from data.title, payload from current state) and
  // also lets Import warn before overwriting existing nodes. Both
  // optional so the viewer route can omit them; FileMenu disables the
  // affordances when absent.
  data?: ToCData;
  onImportJson?: (next: ToCData) => void;

  // Share button click handler. The dialog lives at App level
  // (PR 2's `ShareDialog`); TopBar just exposes the affordance.
  onShareClick?: () => void;

  // PR 2 §769: notification badge for the Share button. Counts pending
  // access requests the current user (owner) can approve. 0 = hidden.
  pendingRequestCount?: number;

  // When the pending-request poll has been failing repeatedly, the
  // displayed count is the last-successful one — flag the badge so the
  // owner has a visible cue that it may be stale (otherwise the poll
  // failing silently lets pending requests pile up unseen).
  pendingRequestCountStale?: boolean;

  // Profile slot rendered on the far right (typically <AuthButton />).
  profileSlot?: React.ReactNode;

  // Test override. Production code leaves this undefined.
  breakpoint?: Breakpoint;
}

const MD_PX = 768;

function useBreakpoint(forced?: Breakpoint): Breakpoint {
  // Initial state from `window.innerWidth` if available. SSR (no window)
  // falls back to `'md'` because indexable HTML should be desktop-first.
  // jsdom uses 1024px by default, so tests also see `'md'` unless the
  // test sets `window.innerWidth` explicitly.
  const initial: Breakpoint =
    forced ?? (typeof window !== 'undefined' && window.innerWidth < MD_PX ? 'sm' : 'md');
  const [bp, setBp] = useState<Breakpoint>(initial);

  useEffect(() => {
    if (forced) return;
    const update = () => setBp(window.innerWidth < MD_PX ? 'sm' : 'md');
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [forced]);

  return bp;
}

type MenuId = 'file' | 'format' | 'help';

export function TopBar(props: TopBarProps) {
  const bp = useBreakpoint(props.breakpoint);

  // Default these for the viewer route where the parent doesn't pass them.
  const isAuthenticated = props.isAuthenticated ?? false;
  const isOwner = props.isOwner ?? false;
  const currentChartId = props.currentChartId ?? null;
  const onDeleteChart = props.onDeleteChart ?? (() => {});
  const onShareClick = props.onShareClick ?? (() => {});

  const isViewer = !props.showEditButton;

  // PR 7 feedback (37): lifted "which menu is open" state. `null`
  // means no menu is open; setting it to a different id closes the
  // previously open menu (the controlled-`isOpen` prop on each menu
  // becomes false) and opens the new one. Hover-switch only fires
  // when this is already non-null — a stray hover with everything
  // closed does NOT open menus (would be obnoxious otherwise).
  const [openMenuId, setOpenMenuId] = useState<MenuId | null>(null);
  const handleHoverOpen = (id: MenuId) => {
    // Only switch on hover when a sibling menu is already open;
    // otherwise the user's intent on a bare hover is unclear and
    // we'd be opening menus they didn't ask for.
    if (openMenuId !== null && openMenuId !== id) setOpenMenuId(id);
  };
  // Escape closes whatever menu is open. Kept centralized here (rather
  // than per-menu) because TopBar already owns the open state. The
  // per-menu click-outside handlers continue to fire for mouse
  // dismissal; this only adds keyboard parity for menubar items.
  useEffect(() => {
    if (openMenuId === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenuId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openMenuId]);

  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-white border-b border-gray-300 shadow-sm">
      {/* PR 7 feedback (43): no vertical padding on the container —
        the menubar triggers must reach the bar's top and bottom edges
        (native-menubar hit target). The row keeps the previous visual
        height via min-h (36px content + 2×8px former py-2 = 52px);
        non-menubar children re-center through their own
        `items-center` wrappers. */}
      <div className="mx-auto px-2 sm:px-4">
        <div className="flex items-stretch justify-between gap-2 min-h-[52px]">
          {/* Left cluster */}
          <div className="flex items-center gap-1 sm:gap-3 min-w-0">
            {bp === 'md' && !isViewer && (
              // Menubar group: the three top-level menus sit edge-to-
              // edge (no `gap-*`) so `pointerenter` on a sibling fires
              // without the cursor traversing dead space in between.
              // Visual separation comes from each button's `px-2/3`
              // padding rather than parent gap.
              // `self-stretch items-stretch` (43): the group escapes
              // the cluster's `items-center` and passes the full row
              // height down to the trigger buttons (`h-full`).
              <div className="flex items-stretch self-stretch">
                <FileMenu
                  isAuthenticated={isAuthenticated}
                  isOwner={isOwner}
                  currentEditToken={props.currentEditToken}
                  currentChartId={currentChartId}
                  onDeleteChart={onDeleteChart}
                  data={props.data}
                  onImportJson={props.onImportJson}
                  isOpen={openMenuId === 'file'}
                  onOpenChange={(next) => setOpenMenuId(next ? 'file' : null)}
                  onHoverOpen={() => handleHoverOpen('file')}
                />
                <FormatMenu
                  editMode={props.editMode}
                  fontFamily={props.fontFamily}
                  setFontFamily={props.setFontFamily}
                  textSize={props.textSize}
                  setTextSize={props.setTextSize}
                  curvature={props.curvature}
                  setCurvature={props.setCurvature}
                  columnPadding={props.columnPadding}
                  setColumnPadding={props.setColumnPadding}
                  sectionPadding={props.sectionPadding}
                  setSectionPadding={props.setSectionPadding}
                  isOpen={openMenuId === 'format'}
                  onOpenChange={(next) => setOpenMenuId(next ? 'format' : null)}
                  onHoverOpen={() => handleHoverOpen('format')}
                />
                <HelpPanel
                  isOpen={openMenuId === 'help'}
                  onOpenChange={(next) => setOpenMenuId(next ? 'help' : null)}
                  onHoverOpen={() => handleHoverOpen('help')}
                />
              </div>
            )}
            {bp === 'md' && isViewer && (
              <>
                {/* Same full-height stretch treatment as the
                  edit-mode menubar group (43). */}
                <div className="flex items-stretch self-stretch">
                  <HelpPanel
                    isOpen={openMenuId === 'help'}
                    onOpenChange={(next) => setOpenMenuId(next ? 'help' : null)}
                    // Viewer mode has only one menu — no sibling to
                    // switch from. `onHoverOpen` is omitted (no-op).
                  />
                </div>
                <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded">
                  View-only
                </span>
              </>
            )}

            {/* Undo / redo (edit mode only) */}
            {!isViewer && (
              <div className="flex items-center gap-1 ml-1 sm:ml-2">
                <button
                  type="button"
                  // L2 mitigation: preserve focus on the active text
                  // input so handleUndo's isInputFocused() check sees
                  // the truth.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={props.handleUndo}
                  disabled={props.undoHistory.length === 0}
                  className="p-1.5 sm:p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title={`Undo (${shortcuts.undoDisplay()})`}
                  aria-label="Undo"
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
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={props.handleRedo}
                  disabled={props.redoHistory.length === 0}
                  className="p-1.5 sm:p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  title={`Redo (${shortcuts.redoDisplay()})`}
                  aria-label="Redo"
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
              </div>
            )}
          </div>

          {/* Right cluster */}
          <div className="flex items-center gap-1 sm:gap-2">
            {bp === 'md' && (
              <>
                <SaveIndicator
                  isSaving={props.isSaving}
                  hasEditToken={Boolean(props.currentEditToken)}
                  saveError={props.saveError}
                />
                {!isViewer && (
                  <button
                    type="button"
                    onClick={onShareClick}
                    className="relative px-2 sm:px-4 py-1.5 sm:py-2 bg-blue-600 text-white text-sm font-medium rounded hover:bg-blue-700 transition-colors flex items-center gap-1 sm:gap-2"
                  >
                    <ShareIcon className="w-4 h-4" />
                    Share
                    {(props.pendingRequestCount ?? 0) > 0 && (
                      <span
                        aria-label={
                          props.pendingRequestCountStale
                            ? `${props.pendingRequestCount} pending access request${
                                (props.pendingRequestCount ?? 0) === 1 ? '' : 's'
                              } (count may be stale — refresh failed)`
                            : `${props.pendingRequestCount} pending access request${
                                (props.pendingRequestCount ?? 0) === 1 ? '' : 's'
                              }`
                        }
                        title={
                          props.pendingRequestCountStale
                            ? 'Pending-request count may be stale (refresh failed)'
                            : undefined
                        }
                        className={`absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full text-white text-[10px] font-semibold flex items-center justify-center ${
                          props.pendingRequestCountStale ? 'bg-gray-400' : 'bg-red-500'
                        }`}
                      >
                        {(props.pendingRequestCount ?? 0) > 9 ? '9+' : props.pendingRequestCount}
                      </span>
                    )}
                  </button>
                )}
                {props.profileSlot}
              </>
            )}

            {bp === 'sm' && (
              <MobileMenu
                isSaving={props.isSaving}
                hasEditToken={Boolean(props.currentEditToken)}
                saveError={props.saveError}
                isAuthenticated={isAuthenticated}
                isOwner={isOwner}
                currentEditToken={props.currentEditToken}
                currentChartId={currentChartId}
                onDeleteChart={onDeleteChart}
                data={props.data}
                onImportJson={props.onImportJson}
                editMode={props.editMode}
                fontFamily={props.fontFamily}
                setFontFamily={props.setFontFamily}
                textSize={props.textSize}
                setTextSize={props.setTextSize}
                curvature={props.curvature}
                setCurvature={props.setCurvature}
                columnPadding={props.columnPadding}
                setColumnPadding={props.setColumnPadding}
                sectionPadding={props.sectionPadding}
                setSectionPadding={props.setSectionPadding}
                onShareClick={onShareClick}
                profileSlot={props.profileSlot}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
