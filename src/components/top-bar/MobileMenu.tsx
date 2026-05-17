// MobileMenu — drawer that the hamburger opens below the `md` breakpoint.
//
// Plan §1.1 acceptance: contents are
//   FileMenu (full) + FormatMenu (full) + HelpPanel (full) +
//   Save indicator (read-only) + Share button (full) + Profile.
// Excludes: Mode toggle (deleted in PR 1), Layout Mode toggle (deleted
// in PR 5), Sync button (deleted in PR 1).
//
// Re-uses FileMenu / FormatMenu / HelpPanel as their full popovers,
// stacked vertically under section headings. The Share / Save indicator
// / Profile sit at the bottom for one-tap reach.
import { useState } from 'react';
import { Bars3Icon, XMarkIcon, ShareIcon } from '@heroicons/react/24/outline';
import { FileMenu } from './FileMenu';
import { FormatMenu } from './FormatMenu';
import { HelpPanel } from './HelpPanel';
import { SaveIndicator, type SaveError } from './SaveIndicator';

interface Props {
  // Save indicator.
  isSaving: boolean;
  hasEditToken: boolean;
  saveError: SaveError | null;
  // File menu pass-through.
  isAuthenticated: boolean;
  isOwner: boolean;
  currentEditToken: string | null;
  currentChartId: string | null;
  onDeleteChart: (chartId: string) => void;
  // Format menu pass-through.
  editMode: boolean;
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
  // Share.
  onShareClick: () => void;
  // Profile slot (e.g. <AuthButton />).
  profileSlot?: React.ReactNode;
}

export function MobileMenu(props: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="p-2 text-gray-600 hover:bg-gray-100 hover:text-gray-800 rounded transition-colors"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
      >
        {open ? <XMarkIcon className="w-5 h-5" /> : <Bars3Icon className="w-5 h-5" />}
      </button>

      {open && (
        // No `overflow-y-auto` here: the drawer hosts nested dropdowns
        // (FileMenu, FormatMenu, HelpPanel) whose `absolute` popovers
        // would be clipped by the scroll container otherwise. Mobile
        // screens are short and the drawer rarely exceeds the viewport.
        <div className="absolute top-full right-0 mt-2 w-72 bg-white rounded-lg shadow-lg border border-gray-200 z-50">
          <div className="p-3 space-y-3">
            {/* File */}
            <section>
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                File
              </div>
              <FileMenu
                isAuthenticated={props.isAuthenticated}
                isOwner={props.isOwner}
                currentEditToken={props.currentEditToken}
                currentChartId={props.currentChartId}
                onDeleteChart={props.onDeleteChart}
              />
            </section>

            {/* Format */}
            <section>
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                Format
              </div>
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
              />
            </section>

            {/* Help */}
            <section>
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                Help
              </div>
              <HelpPanel />
            </section>

            {/* Save status (read-only). */}
            <section>
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                Save
              </div>
              <SaveIndicator
                isSaving={props.isSaving}
                hasEditToken={props.hasEditToken}
                saveError={props.saveError}
              />
            </section>

            {/* Share */}
            <section>
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                Share
              </div>
              <button
                type="button"
                onClick={() => {
                  props.onShareClick();
                  setOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 transition-colors"
              >
                <ShareIcon className="w-4 h-4" />
                Share
              </button>
            </section>

            {/* Profile */}
            {props.profileSlot && (
              <section>
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                  Profile
                </div>
                <div>{props.profileSlot}</div>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
