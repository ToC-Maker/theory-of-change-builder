// App's undo history stores the data object it held before a change, so
// every edit must build a new object graph and leave the previous one
// alone. The data prop is deep-frozen here: an updater that splices,
// pushes to or assigns into a nested array or object of the previous
// state throws instead of silently rewriting the undo snapshot.
//
// fireEvent renders and flushes effects before the graph's queued change
// notification runs, so each edit must also survive that re-render: a node
// moved to another column remounts, and the graph must not answer by
// re-absorbing its unchanged data prop and reporting the old chart.

import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import type { ToCData } from '../../src/types';
import { deepFreeze } from './helpers/deepFreeze';

afterEach(() => {
  cleanup();
});

// Section 0 has two columns so "between" is reachable; section 1 has one.
const makeData = (): ToCData => ({
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

// Feeds each change back as the new data prop, as App does. Without the
// feedback the graph re-absorbs its unchanged prop after the edit.
function Controlled({ initial, onChange }: { initial: ToCData; onChange: (d: ToCData) => void }) {
  const [data, setData] = useState(initial);
  return (
    <ToC
      data={data}
      showEditButton={true}
      onDataChange={(next) => {
        onChange(next);
        setData(next);
      }}
    />
  );
}

const nodeIds = (col: ToCData['sections'][number]['columns'][number]) => col.nodes.map((n) => n.id);

// Renders the graph on frozen data, runs `edit`, and returns the one change
// the parent was notified of.
async function editAndCollect(edit: () => void) {
  const data = deepFreeze(makeData());
  const before = JSON.parse(JSON.stringify(data));
  const onDataChange = vi.fn();
  render(<Controlled initial={data} onChange={onDataChange} />);
  edit();
  // The graph notifies the parent in a microtask; the parent's state
  // update from it belongs inside act.
  await act(async () => {});
  expect(onDataChange).toHaveBeenCalledTimes(1);
  expect(data).toEqual(before);
  return onDataChange.mock.calls[0][0] as ToCData;
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
