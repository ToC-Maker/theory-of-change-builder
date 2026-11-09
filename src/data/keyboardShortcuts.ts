// Shortcut catalog used by the HelpPanel and (later) edit-mode tutorial.
//
// Two surfaces consume this:
//   1. `HelpPanel.tsx` renders the catalog as a grouped reference list.
//   2. `useKeyboardShortcuts.ts` will eventually pull the active set
//      from here too (currently it hard-codes the same keys; the data
//      module is the canonical source going forward).
//
// Cross-platform: the display string uses Cmd on Mac and Ctrl elsewhere.
// `keys` is a structured shape so consumers that want to highlight a
// modifier separately (e.g. an SVG tutorial overlay) can do so.
import { isMac } from '../utils/keyboardShortcuts';

export interface ShortcutKey {
  /** Display label per platform, e.g. "Cmd+Z" / "Ctrl+Z". */
  display: string;
  /** Whether this shortcut requires Cmd/Ctrl (Meta on Mac). */
  hasModifier: boolean;
  /** The raw key (lowercase). */
  key: string;
}

export interface Shortcut {
  /** Short imperative description, e.g. "Undo last change". */
  description: string;
  /** Per-platform key sequence. */
  combo: ShortcutKey;
}

export interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

const mod = isMac() ? 'Cmd' : 'Ctrl';

const editing: Shortcut[] = [
  {
    description: 'Undo last change',
    combo: { display: `${mod}+Z`, hasModifier: true, key: 'z' },
  },
  {
    description: 'Redo last change',
    combo: { display: `${mod}+Y`, hasModifier: true, key: 'y' },
  },
  {
    description: 'Select all nodes (edit mode)',
    combo: { display: `${mod}+A`, hasModifier: true, key: 'a' },
  },
  {
    description: 'Delete selected nodes',
    combo: { display: 'Delete', hasModifier: false, key: 'delete' },
  },
];

const selection: Shortcut[] = [
  {
    description: 'Multi-select nodes',
    combo: { display: `${mod}+Click`, hasModifier: true, key: 'click' },
  },
  {
    description: 'Select an entire column',
    combo: { display: 'Shift+Click', hasModifier: false, key: 'click' },
  },
  {
    description: 'Cycle through nodes',
    combo: { display: 'Tab', hasModifier: false, key: 'tab' },
  },
  {
    description: 'Clear selection',
    combo: { display: 'Esc', hasModifier: false, key: 'escape' },
  },
];

const movement: Shortcut[] = [
  {
    description: 'Move selected nodes vertically',
    combo: { display: '↑ / ↓', hasModifier: false, key: 'arrow' },
  },
  {
    description: 'Move selected nodes between columns',
    combo: { display: '← / →', hasModifier: false, key: 'arrow' },
  },
];

export const keyboardShortcutGroups: ShortcutGroup[] = [
  { title: 'Editing', shortcuts: editing },
  { title: 'Selection', shortcuts: selection },
  { title: 'Movement', shortcuts: movement },
];

/** Flat list of all shortcuts — useful for fuzzy search / tests. */
export const allShortcuts: Shortcut[] = keyboardShortcutGroups.flatMap((g) => g.shortcuts);
