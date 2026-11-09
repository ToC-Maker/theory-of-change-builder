// Ctrl/Cmd+A selects every node. With Caps Lock on the browser reports
// `event.key` as 'A', so the shortcut has to compare the letter without case.

import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import type { ToCData } from '../../src/types';

const node = (id: string) => ({
  id,
  title: id,
  text: '',
  connectionIds: [],
  connections: [],
  yPosition: 100,
});

const data: ToCData = {
  sections: [{ title: 'S1', columns: [{ nodes: [node('a')] }, { nodes: [node('b')] }] }],
};

function press(init: KeyboardEventInit, editMode = true) {
  const setHighlightedNodes = vi.fn();
  renderHook(() =>
    useKeyboardShortcuts({
      data,
      setDataAndNotify: () => {},
      highlightedNodes: new Set(),
      setHighlightedNodes,
      editMode,
      nodeRefs: {},
      setNodeWidth: () => {},
      setNodeColor: () => {},
      moveNodeVertically: () => {},
      nodeHeights: {},
    }),
  );
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  return setHighlightedNodes;
}

describe('select-all shortcut', () => {
  it.each([
    ['Ctrl+A', { key: 'a', ctrlKey: true }],
    ['Cmd+A', { key: 'a', metaKey: true }],
    ['Ctrl+A with Caps Lock on (key "A")', { key: 'A', ctrlKey: true }],
    ['Cmd+A with Caps Lock on (key "A")', { key: 'A', metaKey: true }],
  ])('%s selects every node', (_name, init) => {
    const setHighlightedNodes = press(init);
    expect(setHighlightedNodes).toHaveBeenCalledWith(new Set(['a', 'b']));
  });

  it('does nothing outside edit mode', () => {
    expect(press({ key: 'a', ctrlKey: true }, false)).not.toHaveBeenCalled();
  });
});
