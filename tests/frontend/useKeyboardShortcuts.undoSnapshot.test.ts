// App's undo history stores the data object it held before a change, so
// an updater must return new state and leave its argument alone. The
// argument is deep-frozen: an updater that assigns into or pushes onto
// a nested array or object of the previous state throws.

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import type { ToCData } from '../../src/types';
import { deepFreeze } from './helpers/deepFreeze';

const node = (id: string, yPosition: number) => ({
  id,
  title: id,
  text: '',
  connectionIds: [],
  connections: [],
  yPosition,
});

// S1 has two columns, S2 one, S3 none (an imported chart can have a
// section without columns).
const makeData = (): ToCData => ({
  sections: [
    { title: 'S1', columns: [{ nodes: [node('a', 100)] }, { nodes: [node('b', 140)] }] },
    { title: 'S2', columns: [{ nodes: [node('c', 120)] }] },
    { title: 'S3', columns: [] },
  ],
});

const ids = (columns: ToCData['sections'][number]['columns']) =>
  columns.map((c) => c.nodes.map((n) => n.id));

// Runs the hook's updater against frozen data and returns what it built.
function run(act: (hook: ReturnType<typeof useKeyboardShortcuts>) => void, selected: string[]) {
  const data = deepFreeze(makeData());
  const before = JSON.parse(JSON.stringify(data));
  // Like the real mutate, each updater receives the previous one's result.
  let next: ToCData = data;
  const { result } = renderHook(() =>
    useKeyboardShortcuts({
      data,
      setDataAndNotify: (updater) => {
        next = typeof updater === 'function' ? updater(next) : updater;
      },
      highlightedNodes: new Set(selected),
      setHighlightedNodes: () => {},
      editMode: true,
      nodeRefs: {},
      setNodeWidth: () => {},
      setNodeColor: () => {},
      moveNodeVertically: () => {},
      nodeHeights: {},
    }),
  );
  act(result.current);
  expect(data).toEqual(before);
  return next;
}

describe('keyboard edits build new state and leave the previous state intact', () => {
  it('moving a node right into the next column', () => {
    const next = run((h) => h.moveNodeHorizontally('a', 'right'), ['a']);
    expect(ids(next.sections[0].columns)).toEqual([[], ['b', 'a']]);
  });

  it('moving a node left into the previous column', () => {
    const next = run((h) => h.moveNodeHorizontally('b', 'left'), ['b']);
    expect(ids(next.sections[0].columns)).toEqual([['a', 'b'], []]);
  });

  it('moving a node right out of the last column into the next section', () => {
    const next = run((h) => h.moveNodeHorizontally('b', 'right'), ['b']);
    expect(ids(next.sections[0].columns)).toEqual([['a'], []]);
    expect(ids(next.sections[1].columns)).toEqual([['c', 'b']]);
  });

  it('moving a node into a section with no columns gives it one', () => {
    const next = run((h) => h.moveNodeHorizontally('c', 'right'), ['c']);
    expect(ids(next.sections[1].columns)).toEqual([[]]);
    expect(ids(next.sections[2].columns)).toEqual([['c']]);
  });

  it('deleting the selected nodes', () => {
    const next = run((h) => h.deleteSelectedNodes(), ['a', 'c']);
    expect(ids(next.sections[0].columns)).toEqual([[], ['b']]);
    expect(ids(next.sections[1].columns)).toEqual([[]]);
  });
});
