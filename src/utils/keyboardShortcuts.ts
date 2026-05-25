// Utility functions for cross-platform keyboard shortcuts

export const isMac = (): boolean => {
  return typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
};

export const getModifierKey = (): string => {
  return isMac() ? '⌘' : 'Ctrl';
};

export const getModifierKeyText = (): string => {
  return isMac() ? 'Cmd' : 'Ctrl';
};

export const getShortcutText = (key: string, withModifier: boolean = true): string => {
  if (!withModifier) return key;
  return `${getModifierKey()}+${key}`;
};

export const getShortcutDisplayText = (key: string, withModifier: boolean = true): string => {
  if (!withModifier) return key;
  return `${getModifierKeyText()}+${key}`;
};

// Common shortcuts
export const shortcuts = {
  undo: () => getShortcutText('Z'),
  redo: () => getShortcutText('Y'),
  selectAll: () => getShortcutText('A'),
  multiSelect: () => `${getModifierKeyText()}+Click`,
  undoDisplay: () => getShortcutDisplayText('Z'),
  redoDisplay: () => getShortcutDisplayText('Y'),
  selectAllDisplay: () => getShortcutDisplayText('A'),
};
