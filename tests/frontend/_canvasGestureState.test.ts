// Tests for the canvas gesture mutex module, which the node, connection
// and waypoint drag hooks all lean on. The failure mode that motivates
// this file: a drag hook forgets to clear the flag on cleanup, and every
// other drag silently stops working from then on with no console log to
// triage by. The contract is dead simple — three exports, one mutable
// boolean — but "simple" is exactly when regressions land unobserved.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    // contract the drag hooks lean on.
    setCanvasGestureActive(true);
    const a = isCanvasGestureActive();
    const b = isCanvasGestureActive();
    const c = isCanvasGestureActive();
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(c).toBe(true);
  });
});

// A canvas gesture must never turn into a text selection, or into a
// native drag of an existing selection. A native drag takes over the
// pointer (the browser fires `pointercancel`) and kills the gesture; a
// selection made by the drag leaves highlighted text behind the
// connection line. The module owns that for all three gesture hooks, so
// it is pinned here once.
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
    vi.restoreAllMocks();
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

  // jsdom does not tie an input's selection to the document selection, so
  // clearing the document selection would not show up in `selectionStart`.
  // Browsers do tie them; the observable here is whether the page's
  // selection was cleared at all.
  it.each([
    ['an input', 'input'],
    ['a textarea', 'textarea'],
  ])('does not clear the page selection while %s is focused', (_label, tag) => {
    document.body.innerHTML = `<${tag} id="f">hello world</${tag}>`;
    const field = document.getElementById('f') as HTMLInputElement | HTMLTextAreaElement;
    field.focus();
    field.setSelectionRange(0, 5);
    const removeAllRanges = vi.spyOn(window.getSelection()!, 'removeAllRanges');

    setCanvasGestureActive(true);

    expect(removeAllRanges).not.toHaveBeenCalled();
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
