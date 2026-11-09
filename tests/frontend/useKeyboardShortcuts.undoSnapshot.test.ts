// The chart document keeps the charts on both sides of a change, by
// reference, as an undo entry, so an updater must return new state and leave
// its argument alone: an in-place write would rewrite the entry's `before`
// and undo would restore the wrong chart. The hook below is wired to a real
// document over a deep-frozen chart, and each preview is frozen again, so an
// updater that assigns into or pushes onto a nested array or object of the
// chart it receives throws. After each gesture the test undoes and redoes it
// on the document, which only restores the right charts if nothing was
// written in place.

import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import type { ChartInput, ToCData } from '../../src/types';
import { deepFreeze } from './helpers/deepFreeze';
import { makeDoc } from './helpers/renderToC';

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
const makeData = (): ChartInput => ({
  sections: [
    { title: 'S1', columns: [{ nodes: [node('a', 100)] }, { nodes: [node('b', 140)] }] },
    { title: 'S2', columns: [{ nodes: [node('c', 120)] }] },
    { title: 'S3', columns: [] },
  ],
});

const ids = (columns: ToCData['sections'][number]['columns']) =>
  columns.map((c) => c.nodes.map((n) => n.id));

// Runs one gesture of the hook against a document, commits it as one change
// and returns the chart it committed.
function run(
  gesture: (hook: ReturnType<typeof useKeyboardShortcuts>) => void,
  selected: string[],
): ToCData {
  const { doc } = makeDoc(makeData());
  const before = doc.getCommitted();
  const snapshot = JSON.parse(JSON.stringify(before));
  const { result } = renderHook(() =>
    useKeyboardShortcuts({
      data: doc.getLive(),
      // The canvas previews through the document and commits afterwards; each
      // updater receives the chart the previous one built.
      setDataAndNotify: (updater) => {
        doc.preview(updater);
        deepFreeze(doc.getLive());
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
  gesture(result.current);
  doc.commit();
  const next = doc.getCommitted();

  expect(next).not.toBe(before);
  expect(before).toEqual(snapshot);
  expect(doc.getStatus().canUndo).toBe(true);
  doc.undo();
  expect(doc.getCommitted()).toEqual(snapshot);
  doc.redo();
  expect(doc.getCommitted()).toEqual(next);
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
    expect(next.sections[2].columns[0].id).toMatch(/^col-/);
  });

  it('deleting the selected nodes', () => {
    const next = run((h) => h.deleteSelectedNodes(), ['a', 'c']);
    expect(ids(next.sections[0].columns)).toEqual([[], ['b']]);
    expect(ids(next.sections[1].columns)).toEqual([[]]);
  });
});
