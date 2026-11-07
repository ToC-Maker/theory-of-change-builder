// The canvas hands every updater the document's live chart, and the document
// keeps the charts on both sides of a change, by reference, as an undo entry.
// An updater must therefore build a new object graph and leave the chart it
// received alone: an in-place write (a splice, a push, an assignment into a
// nested array or object) would rewrite the entry's `before`, and undo would
// restore the wrong chart. The document is created over a deep-frozen chart
// (see `makeDoc`), so such a write throws instead of corrupting history.
//
// Each gesture is also undone and redone on the document: undo must restore
// the chart the gesture started from, exactly, and redo the chart it produced.
//
// fireEvent renders and flushes effects before the canvas's queued commit
// runs, so each edit must also survive that re-render: a node moved to another
// column remounts, and the remount must not write the old chart back.

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, act } from '@testing-library/react';
import type { ChartInput, ToCData } from '../../src/types';
import { renderToC } from './helpers/renderToC';

afterEach(() => {
  cleanup();
});

// Section 0 has two columns so "between" is reachable; section 1 has one.
const makeData = (): ChartInput => ({
  title: 'Snapshot fixture',
  sections: [
    {
      title: 'S1',
      columns: [
        {
          nodes: [
            { id: 'a', title: 'A', text: '', connectionIds: [], connections: [], yPosition: 100 },
          ],
        },
        {
          nodes: [
            { id: 'b', title: 'B', text: '', connectionIds: [], connections: [], yPosition: 140 },
          ],
        },
      ],
    },
    {
      title: 'S2',
      columns: [
        {
          nodes: [
            { id: 'c', title: 'C', text: '', connectionIds: [], connections: [], yPosition: 120 },
          ],
        },
      ],
    },
  ],
});

const nodeIds = (col: ToCData['sections'][number]['columns'][number]) => col.nodes.map((n) => n.id);

// Renders the canvas on a frozen chart and runs `perform`. Expects exactly one
// commit (one undo step), the starting chart untouched, undo back to it and
// redo back to the edit; returns the edited chart.
async function editAndCollect(perform: () => void) {
  const { doc, onCommit } = renderToC(makeData());
  const before = doc.getCommitted();
  const snapshot = JSON.parse(JSON.stringify(before));
  perform();
  // The canvas commits in a microtask; the store notifications it causes
  // belong inside act.
  await act(async () => {});
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(before).toEqual(snapshot);
  const next = doc.getCommitted();
  expect(next).not.toEqual(snapshot);

  act(() => doc.undo());
  expect(doc.getCommitted()).toEqual(snapshot);
  expect(doc.getStatus()).toMatchObject({ canUndo: false, canRedo: true });

  act(() => doc.redo());
  expect(doc.getCommitted()).toEqual(next);
  expect(doc.getStatus()).toMatchObject({ canUndo: true, canRedo: false });
  return next;
}

const byId = (testId: string, index = 0) =>
  document.querySelectorAll(`[data-testid="${testId}"]`)[index] as HTMLElement;

const clickGutter = (testId: string, index = 0) =>
  editAndCollect(() => fireEvent.click(byId(testId, index)));

describe('adding a column or section builds new state and leaves the previous state intact', () => {
  it('column before the first column', async () => {
    const next = await clickGutter('add-column-before-0-0');
    expect(next.sections[0].columns.map(nodeIds)).toEqual([[], ['a'], ['b']]);
  });

  it('column between two columns', async () => {
    const next = await clickGutter('add-column-after-0-0');
    expect(next.sections[0].columns.map(nodeIds)).toEqual([['a'], [], ['b']]);
  });

  it('column after the last column', async () => {
    const next = await clickGutter('add-column-after-0-1');
    expect(next.sections[0].columns.map(nodeIds)).toEqual([['a'], ['b'], []]);
  });

  it('section before the first section', async () => {
    const next = await clickGutter('add-section-before', 0);
    expect(next.sections.map((s) => s.title)).toEqual(['New Section', 'S1', 'S2']);
  });

  it('section between two sections', async () => {
    const next = await clickGutter('add-section-before', 1);
    expect(next.sections.map((s) => s.title)).toEqual(['S1', 'New Section', 'S2']);
  });

  it('section after the last section', async () => {
    const next = await clickGutter('add-section-after-last');
    expect(next.sections.map((s) => s.title)).toEqual(['S1', 'S2', 'New Section']);
  });
});

describe('other edits leave the previous state intact', () => {
  const confirmDelete = () => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    const button = Array.from(dialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Delete',
    );
    fireEvent.click(button!);
  };

  // The node editor focuses its title input, which suspends shortcuts.
  const selectNodeAndPress = (nodeId: string, key: string) => () => {
    fireEvent.click(document.querySelector(`[data-tocb-node="${nodeId}"]`) as HTMLElement);
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(window, { key });
  };

  const retitle = (heading: string) => () => {
    fireEvent.click(document.querySelector(heading) as HTMLElement);
    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
  };

  it('deleting a column', async () => {
    const next = await editAndCollect(() => {
      fireEvent.click(byId('column-delete-0-1'));
      confirmDelete();
    });
    expect(next.sections[0].columns.map(nodeIds)).toEqual([['a']]);
  });

  it('deleting a section', async () => {
    const next = await editAndCollect(() => {
      fireEvent.click(byId('section-delete-1'));
      confirmDelete();
    });
    expect(next.sections.map((s) => s.title)).toEqual(['S1']);
  });

  it('nudging a selected node with an arrow key', async () => {
    const next = await editAndCollect(selectNodeAndPress('a', 'ArrowDown'));
    expect(next.sections[0].columns[0].nodes[0].yPosition).toBe(120);
  });

  it('moving a selected node into the next column with an arrow key', async () => {
    const next = await editAndCollect(selectNodeAndPress('a', 'ArrowRight'));
    expect(next.sections[0].columns.map(nodeIds)).toEqual([[], ['b', 'a']]);
  });

  it('retitling the chart', async () => {
    const next = await editAndCollect(retitle('h1'));
    expect(next.title).toBe('Renamed');
  });

  it('retitling a section', async () => {
    const next = await editAndCollect(retitle('h2'));
    expect(next.sections.map((s) => s.title)).toEqual(['Renamed', 'S2']);
  });
});
