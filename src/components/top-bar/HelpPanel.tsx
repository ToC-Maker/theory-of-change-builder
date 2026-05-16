// HelpPanel — Help dropdown in the new TopBar.
//
// Sections (per plan §1.2):
//   - Keyboard shortcuts (sourced from `src/data/keyboardShortcuts.ts`)
//   - View-mode tutorial — a button that resets the
//     `graph-tutorial-seen` localStorage flag and reloads so
//     `<GraphTutorial />` re-arms on the next render (no need to wire a
//     prop chain into TheoryOfChangeGraph for a one-shot affordance).
//   - Edit-mode tutorial — "Coming soon" placeholder (deferred to a
//     later PR; covers the new hover affordances + connection handles
//     introduced in PRs 5+7).
//   - External link to a Theory of Change explainer article.
//
// The previous EditToolbar's Help modal was a single dump of everything;
// the new HelpPanel keeps the same surface but groups it under explicit
// sections so the user knows where to look.
import { useEffect, useRef, useState } from 'react';
import {
  ChevronDownIcon,
  QuestionMarkCircleIcon,
  ArrowTopRightOnSquareIcon,
} from '@heroicons/react/24/outline';
import { keyboardShortcutGroups } from '../../data/keyboardShortcuts';

const TOC_EXPLAINER_URL = 'https://en.wikipedia.org/wiki/Theory_of_change';

export function HelpPanel() {
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

  const handleReplayTutorial = () => {
    try {
      localStorage.removeItem('graph-tutorial-seen');
    } catch {
      // ignore — private mode etc.
    }
    setOpen(false);
    // Reload so <GraphTutorial> re-runs its first-time check.
    window.location.reload();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="px-2 sm:px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded transition-colors flex items-center gap-1"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Help"
      >
        <QuestionMarkCircleIcon className="w-4 h-4" />
        <span className="hidden md:inline">Help</span>
        <ChevronDownIcon className="w-3 h-3" />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full mt-1 right-0 sm:right-auto sm:left-0 w-[min(22rem,calc(100vw-1rem))] max-h-[80vh] overflow-y-auto bg-white rounded-lg shadow-lg border border-gray-200 py-3 px-4 z-50"
        >
          {/* Keyboard shortcuts */}
          <div className="mb-4">
            <h3 className="text-sm font-semibold text-gray-800 mb-2">Keyboard shortcuts</h3>
            <div className="space-y-3">
              {keyboardShortcutGroups.map((group) => (
                <div key={group.title}>
                  <div className="text-xs font-medium text-gray-500 mb-1">{group.title}</div>
                  <ul className="space-y-1">
                    {group.shortcuts.map((s) => (
                      <li
                        key={`${group.title}:${s.description}`}
                        className="flex items-center justify-between text-xs text-gray-700"
                      >
                        <span>{s.description}</span>
                        <kbd className="ml-2 px-1.5 py-0.5 text-[10px] bg-gray-100 border border-gray-200 rounded font-mono text-gray-600 whitespace-nowrap">
                          {s.combo.display}
                        </kbd>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          {/* Tutorials */}
          <div className="mb-4 pt-3 border-t border-gray-100">
            <h3 className="text-sm font-semibold text-gray-800 mb-2">Tutorials</h3>
            <button
              type="button"
              onClick={handleReplayTutorial}
              className="w-full text-left text-sm text-blue-700 hover:underline px-1 py-1"
              role="menuitem"
            >
              Replay the view-mode walkthrough
            </button>
            <div className="text-xs text-gray-500 px-1 py-1">Edit-mode tutorial — coming soon.</div>
          </div>

          {/* External resources */}
          <div className="pt-3 border-t border-gray-100">
            <h3 className="text-sm font-semibold text-gray-800 mb-2">Learn more</h3>
            <a
              href={TOC_EXPLAINER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-sm text-blue-700 hover:underline px-1 py-1"
              role="menuitem"
            >
              What is a Theory of Change?
              <ArrowTopRightOnSquareIcon className="w-3 h-3" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
