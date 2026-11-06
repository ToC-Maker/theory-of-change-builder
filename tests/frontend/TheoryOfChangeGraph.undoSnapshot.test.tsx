// App's undo history stores the data object it held before a change, so
// every edit must build a new object graph and leave the previous one
// alone. The data prop is deep-frozen here: an updater that splices,
// pushes to or assigns into a nested array or object of the previous
// state throws instead of silently rewriting the undo snapshot.

import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import type { ToCData } from '../../src/types';

afterEach(() => {
  cleanup();
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

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

async function clickAndCollect(testId: string, index = 0) {
  const data = deepFreeze(makeData());
  const before = JSON.parse(JSON.stringify(data));
  const onDataChange = vi.fn();
  render(<Controlled initial={data} onChange={onDataChange} />);
  const gutter = document.querySelectorAll(`[data-testid="${testId}"]`)[index];
  expect(gutter).toBeTruthy();
  // A plain click inside an async act keeps the production order: the
  // parent is notified before React renders and re-absorbs the old prop.
  await act(async () => {
    (gutter as HTMLElement).click();
  });
  expect(onDataChange).toHaveBeenCalledTimes(1);
  expect(data).toEqual(before);
  return onDataChange.mock.calls[0][0] as ToCData;
}

describe('adding a column or section builds new state and leaves the previous state intact', () => {
  it('column before the first column', async () => {
    const next = await clickAndCollect('add-column-before-0-0');
    expect(next.sections[0].columns.map(nodeIds)).toEqual([[], ['a'], ['b']]);
  });

  it('column between two columns', async () => {
    const next = await clickAndCollect('add-column-after-0-0');
    expect(next.sections[0].columns.map(nodeIds)).toEqual([['a'], [], ['b']]);
  });

  it('column after the last column', async () => {
    const next = await clickAndCollect('add-column-after-0-1');
    expect(next.sections[0].columns.map(nodeIds)).toEqual([['a'], ['b'], []]);
  });

  it('section before the first section', async () => {
    const next = await clickAndCollect('add-section-before', 0);
    expect(next.sections.map((s) => s.title)).toEqual(['New Section', 'S1', 'S2']);
  });

  it('section between two sections', async () => {
    const next = await clickAndCollect('add-section-before', 1);
    expect(next.sections.map((s) => s.title)).toEqual(['S1', 'New Section', 'S2']);
  });

  it('section after the last section', async () => {
    const next = await clickAndCollect('add-section-after-last');
    expect(next.sections.map((s) => s.title)).toEqual(['S1', 'S2', 'New Section']);
  });
});
