// Shape regression for the shortcut catalog at
// `src/data/keyboardShortcuts.ts`. HelpPanel and useKeyboardShortcuts
// both consume it; we want the smallest possible test that breaks
// loudly if someone accidentally drops a group or removes a required
// shortcut from the canonical list.
import { describe, it, expect } from 'vitest';
import {
  keyboardShortcutGroups,
  allShortcuts,
  type Shortcut,
} from '../../src/data/keyboardShortcuts';

describe('keyboardShortcuts data', () => {
  it('exposes the expected groups', () => {
    const titles = keyboardShortcutGroups.map((g) => g.title);
    expect(titles).toEqual(['Editing', 'Selection', 'Movement']);
  });

  it('every shortcut has a non-empty description and a display string', () => {
    for (const s of allShortcuts) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.combo.display.length).toBeGreaterThan(0);
      expect(typeof s.combo.hasModifier).toBe('boolean');
      expect(s.combo.key.length).toBeGreaterThan(0);
    }
  });

  it('includes the canonical edit shortcuts (undo/redo/select-all/delete)', () => {
    const descriptions = allShortcuts.map((s) => s.description.toLowerCase());
    expect(descriptions.some((d) => d.includes('undo'))).toBe(true);
    expect(descriptions.some((d) => d.includes('redo'))).toBe(true);
    expect(descriptions.some((d) => d.includes('select all'))).toBe(true);
    expect(descriptions.some((d) => d.includes('delete'))).toBe(true);
  });

  it('shortcut combos with hasModifier=true display the modifier name', () => {
    const modifierBound = allShortcuts.filter((s: Shortcut) => s.combo.hasModifier);
    for (const s of modifierBound) {
      expect(s.combo.display).toMatch(/Cmd|Ctrl/);
    }
  });
});
