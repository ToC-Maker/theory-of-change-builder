// Tests for the cross-PR canvas gesture mutex module.
//
// PR 4 ships `_canvasGestureState.ts` as the primitive PR 5
// (`useConnectionDrag`) and PR 7 (`useWaypointDrag`) lean on. The
// failure mode the test-analyzer flagged (and that motivates having
// this file at all): a future PR adds its own drag hook, forgets to
// clear the flag on cleanup, and node-drag silently stops working
// from then on with no console log to triage by. The reader-side
// contract is dead simple — three exports, one mutable boolean — but
// "simple" is exactly when regressions land unobserved.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isCanvasGestureActive,
  setCanvasGestureActive,
  _resetCanvasGestureStateForTest,
} from '../../src/hooks/_canvasGestureState';

beforeEach(() => {
  _resetCanvasGestureStateForTest();
});

describe('_canvasGestureState', () => {
  it('starts in the inactive state', () => {
    expect(isCanvasGestureActive()).toBe(false);
  });

  it('setCanvasGestureActive(true) flips the flag to true', () => {
    setCanvasGestureActive(true);
    expect(isCanvasGestureActive()).toBe(true);
  });

  it('setCanvasGestureActive(false) flips the flag back to false', () => {
    setCanvasGestureActive(true);
    setCanvasGestureActive(false);
    expect(isCanvasGestureActive()).toBe(false);
  });

  it('is idempotent — setting true twice stays true', () => {
    setCanvasGestureActive(true);
    setCanvasGestureActive(true);
    expect(isCanvasGestureActive()).toBe(true);
  });

  it('_resetCanvasGestureStateForTest restores neutral state', () => {
    setCanvasGestureActive(true);
    _resetCanvasGestureStateForTest();
    expect(isCanvasGestureActive()).toBe(false);
  });

  it('survives multiple readers — get returns the same value', () => {
    // The point of a module singleton: every reader sees the same flag
    // without coordination. This pins the no-stateful-snapshot
    // contract PR 5/7 lean on.
    setCanvasGestureActive(true);
    const a = isCanvasGestureActive();
    const b = isCanvasGestureActive();
    const c = isCanvasGestureActive();
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(c).toBe(true);
  });
});

// A canvas gesture must never turn into a text selection or a native
// drag of an existing selection: either one takes over the pointer
// (the browser fires `pointercancel`) or leaves highlighted text behind
// the connection line. The module owns that for all three gesture
// hooks, so it is pinned here once.
describe('_canvasGestureState selection suppression', () => {
  const MARK = 'tocb-canvas-gesture';

  const selectText = (el: Element) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  };

  afterEach(() => {
    document.body.innerHTML = '';
    window.getSelection()?.removeAllRanges();
  });

  it('marks the document root while a gesture is active and unmarks it on release', () => {
    setCanvasGestureActive(true);
    expect(document.documentElement.classList.contains(MARK)).toBe(true);
    setCanvasGestureActive(false);
    expect(document.documentElement.classList.contains(MARK)).toBe(false);
  });

  it('the reset helper also removes the mark', () => {
    setCanvasGestureActive(true);
    _resetCanvasGestureStateForTest();
    expect(document.documentElement.classList.contains(MARK)).toBe(false);
  });

  it('clears highlighted page text when a gesture starts', () => {
    document.body.innerHTML = '<h1 id="t">Chart title</h1>';
    selectText(document.getElementById('t')!);
    expect(window.getSelection()!.toString()).toBe('Chart title');
    setCanvasGestureActive(true);
    expect(window.getSelection()!.toString()).toBe('');
  });

  it('leaves the selection alone while an input is focused', () => {
    document.body.innerHTML = '<input id="i" value="hello world" />';
    const input = document.getElementById('i') as HTMLInputElement;
    input.focus();
    input.setSelectionRange(0, 5);
    setCanvasGestureActive(true);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
  });

  it('leaves the selection alone while a contenteditable (rich-text editor) is focused', () => {
    document.body.innerHTML = '<div id="e" contenteditable="true" tabindex="0">editable text</div>';
    const editor = document.getElementById('e') as HTMLElement;
    editor.focus();
    selectText(editor);
    setCanvasGestureActive(true);
    expect(window.getSelection()!.toString()).toBe('editable text');
  });

  it('cancels the browser native drag (of a selection, image or link) while active only', () => {
    const fire = () => {
      const ev = new Event('dragstart', { bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(fire()).toBe(false);
    setCanvasGestureActive(true);
    expect(fire()).toBe(true);
    setCanvasGestureActive(false);
    expect(fire()).toBe(false);
  });

  it('does not stack drag guards when set true twice (one release is enough)', () => {
    setCanvasGestureActive(true);
    setCanvasGestureActive(true);
    setCanvasGestureActive(false);
    const ev = new Event('dragstart', { bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(document.documentElement.classList.contains(MARK)).toBe(false);
  });
});
