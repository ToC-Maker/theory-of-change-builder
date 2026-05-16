// Returns true when the current document activeElement is a text-entry
// surface (INPUT, TEXTAREA, or contentEditable). Used as a guard around
// keyboard shortcuts and toolbar undo/redo buttons so they don't steal
// keystrokes while the user is typing.
//
// Mirror of the inline check at `useKeyboardShortcuts.ts:244-257`; that
// callsite is refactored to use this helper in Task 0.6.
//
// L2 mitigation note: clicking a toolbar button shifts focus to the
// button BEFORE the onClick handler runs, so `isInputFocused()` would
// return false. The button must call `onMouseDown={(e) =>
// e.preventDefault()}` to keep focus on the input across the click.
export function isInputFocused(): boolean {
  // Guard for non-browser environments (e.g. SSR / Worker test pool).
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
  // Three complementary checks for contentEditable. Real browsers
  // expose all three; jsdom is patchy (the IDL `contentEditable`
  // property is writable but doesn't reflect to attribute, and
  // `isContentEditable` is `undefined`). Match any:
  //   - `isContentEditable` boolean (real browsers; respects inheritance)
  //   - `contentEditable` IDL prop equal to "true" (jsdom path)
  //   - `contenteditable` attribute present and not "false"
  const html = el as HTMLElement;
  if (html.isContentEditable === true) return true;
  if (html.contentEditable === 'true') return true;
  const ce = el.getAttribute?.('contenteditable');
  if (ce !== null && ce !== undefined && ce !== 'false') return true;
  return false;
}
