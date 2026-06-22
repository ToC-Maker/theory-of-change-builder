// FormatMenu — Format dropdown in the new TopBar.
//
// Groups (per plan §1.2):
//   - Font family
//   - Text size
//   - Connection curvature
//   - Column / section padding (paddings)
//
// All controls feed back through the same setters the old EditToolbar
// used. The streaming-input handles (`mutateDebounced` / `commitMutation`)
// live with the parent that owns the canonical state; FormatMenu only
// reads/writes the surface-level values via the supplied setters.
//
// Disabled when not in edit mode (the parent decides what to pass).
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, MinusIcon, PlusIcon } from '@heroicons/react/24/outline';

interface Props {
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
  // PR 7 feedback (37): menubar hover-switch. See FileMenu.tsx for
  // details — when the parent (TopBar) controls open state, it
  // passes these so a hover from a sibling open menu can switch to
  // this one without a click. Optional so MobileMenu / tests still
  // work as uncontrolled.
  isOpen?: boolean;
  onOpenChange?: (next: boolean) => void;
  onHoverOpen?: () => void;
}

const FONT_OPTIONS: { value: string; label: string }[] = [
  { value: "'Roboto', sans-serif", label: 'Roboto' },
  { value: "'Open Sans', sans-serif", label: 'Open Sans' },
  { value: "'Lato', sans-serif", label: 'Lato' },
  { value: "'Montserrat', sans-serif", label: 'Montserrat' },
  { value: "'Poppins', sans-serif", label: 'Poppins' },
  { value: "'Source Sans Pro', sans-serif", label: 'Source Sans Pro' },
  { value: "'Raleway', sans-serif", label: 'Raleway' },
  { value: "'Oswald', sans-serif", label: 'Oswald' },
  { value: "'Nunito', sans-serif", label: 'Nunito' },
  { value: "'Rubik', sans-serif", label: 'Rubik' },
  { value: "'Work Sans', sans-serif", label: 'Work Sans' },
  { value: "'Merriweather', serif", label: 'Merriweather' },
  { value: "'Playfair Display', serif", label: 'Playfair Display' },
  { value: "'Lora', serif", label: 'Lora' },
];

export function FormatMenu({
  editMode,
  fontFamily,
  setFontFamily,
  textSize,
  setTextSize,
  curvature,
  setCurvature,
  columnPadding,
  setColumnPadding,
  sectionPadding,
  setSectionPadding,
  isOpen,
  onOpenChange,
  onHoverOpen,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isOpen ?? internalOpen;
  // Memoized so it's a stable dep for effects. See FileMenu.tsx for
  // the controlled-vs-uncontrolled rationale.
  const setOpen = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      if (onOpenChange) {
        const resolved = typeof next === 'function' ? next(isOpen ?? false) : next;
        onOpenChange(resolved);
      } else {
        setInternalOpen(next);
      }
    },
    [onOpenChange, isOpen],
  );
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    // Escape closes the menu. Handled per-menu (not in TopBar) so
    // FileMenu's two-step flyout ladder isn't raced by a parent-level
    // listener — see the note in TopBar.tsx.
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
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

  const currentPx = Math.round(textSize * 18);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => editMode && setOpen((s) => !s)}
        onPointerEnter={editMode ? onHoverOpen : undefined}
        disabled={!editMode}
        // PR 7 feedback (43): full-height native-menubar trigger with
        // a full-height fill (kept while open). See FileMenu.tsx.
        className={`h-full px-2 sm:px-3 py-1.5 text-sm font-medium transition-colors flex items-center gap-1 ${
          editMode
            ? `text-gray-700 hover:bg-gray-100 ${open ? 'bg-gray-100' : ''}`
            : 'text-gray-400 cursor-not-allowed'
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={editMode ? 'Format options' : 'Available in edit mode'}
      >
        Format
        <ChevronDownIcon className="w-3 h-3" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 w-72 bg-white rounded-lg shadow-lg border border-gray-200 py-3 px-4 z-50 space-y-4"
        >
          {/* Font family — styled to match the `Picker` trigger pattern
            used in `ChatInterface.tsx` (model + effort selectors):
              rounded-lg, slightly larger padding, hover border darken,
              ring-2 focus, smooth transition, custom ChevronDownIcon.
            Native `<select>` chevron is hidden via `appearance-none` +
            right padding for the overlaid icon. The popup option list
            is still browser-native (a full custom popover for 14
            options would be a much bigger change than the reviewer
            asked for); only the trigger styling is brought into line. */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Font family</label>
            <div className="relative">
              <select
                value={fontFamily}
                onChange={(e) => setFontFamily(e.target.value)}
                className="w-full text-sm text-gray-700 border border-gray-300 rounded-lg px-2.5 py-2 pr-8 bg-white appearance-none cursor-pointer hover:border-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-200"
                style={{ fontFamily }}
              >
                {FONT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} style={{ fontFamily: opt.value }}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <ChevronDownIcon
                className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-500"
                aria-hidden
              />
            </div>
          </div>

          {/* Text size */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Text size</label>
            {/* `justify-center` centers the stepper cluster in the menu
              column (the other rows use `flex-1` sliders that fill the
              width; the stepper has no flex-grow child, so without
              `justify-center` the buttons + input sit left-aligned and
              look off-axis). */}
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => setTextSize(Math.max(9, currentPx - 1) / 18)}
                className="p-1 rounded hover:bg-gray-100"
                aria-label="Decrease text size"
              >
                <MinusIcon className="w-4 h-4 text-gray-600" />
              </button>
              {/* `type="text"` (with `inputMode="numeric"` and a numeric
                `pattern`) avoids the native up/down spinner buttons
                that `type="number"` renders inside the field — they
                duplicate the [-]/[+] siblings (reviewer feedback 41).
                The handler already `parseInt`s + clamps, so a text
                input round-trips identically. `inputMode="numeric"`
                still surfaces the numeric soft keyboard on mobile. */}
              <input
                type="text"
                inputMode="numeric"
                pattern="\d*"
                aria-label="Text size in pixels"
                value={currentPx}
                onChange={(e) => {
                  const px = parseInt(e.target.value, 10) || 18;
                  setTextSize(Math.max(9, Math.min(36, px)) / 18);
                }}
                className="w-14 text-sm text-gray-700 border border-gray-300 rounded px-2 py-1 text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={() => setTextSize(Math.min(36, currentPx + 1) / 18)}
                className="p-1 rounded hover:bg-gray-100"
                aria-label="Increase text size"
              >
                <PlusIcon className="w-4 h-4 text-gray-600" />
              </button>
              <span className="text-xs text-gray-500">px</span>
            </div>
          </div>

          {/* Curvature */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Connection curve</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={curvature}
                onChange={(e) => setCurvature(parseFloat(e.target.value))}
                className="flex-1 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
              />
              <span className="text-xs text-gray-500 w-12 text-right">
                {Math.round(curvature * 100)}%
              </span>
            </div>
          </div>

          {/* Column padding */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Column spacing</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                step={4}
                value={columnPadding}
                onChange={(e) => setColumnPadding(parseInt(e.target.value, 10))}
                className="flex-1 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
              />
              <span className="text-xs text-gray-500 w-12 text-right">{columnPadding}px</span>
            </div>
          </div>

          {/* Section padding */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Section spacing</label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                step={4}
                value={sectionPadding}
                onChange={(e) => setSectionPadding(parseInt(e.target.value, 10))}
                className="flex-1 h-1 rounded-lg appearance-none cursor-pointer bg-gray-200"
              />
              <span className="text-xs text-gray-500 w-12 text-right">{sectionPadding}px</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
