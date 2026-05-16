// Tests for the shared focus-check utility.
//
// Returns true for INPUT, TEXTAREA, contentEditable elements; false
// otherwise (including for the BODY and unfocused state).
//
// Used by `App.handleUndo/handleRedo`, `useKeyboardShortcuts`, and the
// L2 mitigation on toolbar undo buttons (which also need
// `onMouseDown={(e) => e.preventDefault()}` to keep focus on the
// previously-active input across the click).
import { describe, it, expect, afterEach } from 'vitest';
import { isInputFocused } from '../../src/utils/isInputFocused';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isInputFocused', () => {
  it('returns false with no active element / body focus', () => {
    // jsdom's default activeElement is the body. Confirm the helper
    // doesn't false-positive on it.
    expect(isInputFocused()).toBe(false);
  });

  it('returns true when an INPUT is focused', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(isInputFocused()).toBe(true);
  });

  it('returns true when a TEXTAREA is focused', () => {
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    expect(isInputFocused()).toBe(true);
  });

  it('returns true for a contentEditable element', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    div.tabIndex = 0;
    document.body.appendChild(div);
    div.focus();
    expect(isInputFocused()).toBe(true);
  });

  it('returns false for a focused BUTTON (L2 prerequisite)', () => {
    // A button can hold focus but should NOT count as input. Combined
    // with onMouseDown preventDefault on toolbar buttons, this lets us
    // safely run an undo while the user is typing without the click
    // shifting focus to the button and bypassing isInputFocused.
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    btn.focus();
    expect(isInputFocused()).toBe(false);
  });
});
