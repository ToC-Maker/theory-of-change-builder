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
import { useEffect, useRef, useState } from 'react';
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
}: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const currentPx = Math.round(textSize * 18);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => editMode && setOpen((s) => !s)}
        disabled={!editMode}
        className={`px-2 sm:px-3 py-1.5 text-sm font-medium rounded transition-colors flex items-center gap-1 ${
          editMode ? 'text-gray-700 hover:bg-gray-100' : 'text-gray-400 cursor-not-allowed'
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
          className="absolute top-full mt-1 left-0 w-72 bg-white rounded-lg shadow-lg border border-gray-200 py-3 px-4 z-50 space-y-4"
        >
          {/* Font family */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Font family</label>
            <select
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)}
              className="w-full text-sm text-gray-700 border border-gray-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-500"
              style={{ fontFamily }}
            >
              {FONT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value} style={{ fontFamily: opt.value }}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Text size */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Text size</label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setTextSize(Math.max(9, currentPx - 1) / 18)}
                className="p-1 rounded hover:bg-gray-100"
                aria-label="Decrease text size"
              >
                <MinusIcon className="w-4 h-4 text-gray-600" />
              </button>
              <input
                type="number"
                min={9}
                max={36}
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
