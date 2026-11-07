// PR #34 round-4 feedback 67: "Auto alignment doesn't undo (or doesn't
// undo correctly)."
//
// Root cause (reproduced live with rodney): `straightenEdges` built its
// next state as `const newData = { ...prevData }` — a SHALLOW copy — and
// then assigned `newData.sections[i].columns[j].nodes[k] = {...}`. The
// nested `sections`/`columns`/`nodes` arrays were the SAME objects as
// `prevData`'s, so the assignment mutated the previous state in place.
// The document's undo history keeps the PREVIOUS chart object as the undo
// entry — but by the time it is read, that object already carried the
// aligned yPositions. The history entry equalled the post-alignment state,
// and Ctrl+Z was a visual no-op (live evidence: positions unchanged after
// undo).
//
// The fix routes alignment through `computeAlignedSections` (pure,
// immutable — `src/utils/alignNodes.ts`). These tests pin the contract
// the document's undo history depends on:
//
//   1. The chart the document held before the "Align nodes" action is
//      NEVER mutated (undo snapshot integrity; the helper deep-freezes it,
//      so an in-place write throws).
//   2. Alignment emits exactly ONE commit (one undo boundary — a single
//      undo must restore the pre-alignment state, not an increment of it).

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ChartInput, ToCData } from '../../src/types';
import { renderToC } from './helpers/renderToC';

afterEach(() => {
  cleanup();
});

// Two nodes in different sections, vertically misaligned by 40px
// (yPosition 100 vs 140 → same alignment group, tolerance 40, group
// average 120). jsdom reports offsetHeight 0 for all nodes, so the
// component's `nodeHeights[id] || 76` fallback makes the math
// deterministic.
const makeMisalignedData = (): ChartInput => ({
  title: 'Alignment fixture',
  sections: [
    {
      title: 'S1',
      columns: [
        {
          nodes: [
            {
              id: 'a',
              title: 'A',
              text: '',
              connectionIds: [],
              connections: [{ targetId: 'b', confidence: 75 }],
              yPosition: 100,
            },
          ],
        },
      ],
    },
    {
      title: 'S2',
      columns: [
        {
          nodes: [{ id: 'b', title: 'B', text: '', connectionIds: [], yPosition: 140 }],
        },
      ],
    },
  ],
});

describe('TheoryOfChangeGraph alignment undo contract (feedback 67)', () => {
  it('Align nodes never mutates the chart the document held before it', async () => {
    const { doc, onCommit } = renderToC(makeMisalignedData());
    const before = doc.getCommitted();
    const preClickSnapshot = JSON.parse(JSON.stringify(before));

    fireEvent.click(screen.getByRole('button', { name: 'Align nodes' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalled());

    // The object the undo history holds must still describe the
    // PRE-alignment chart.
    expect(before).toEqual(preClickSnapshot);
    expect(doc.getCommitted()).not.toBe(before);
  });

  it('alignment emits exactly one commit carrying the aligned positions', async () => {
    const { doc, onCommit } = renderToC(makeMisalignedData());
    const before = doc.getCommitted();

    fireEvent.click(screen.getByRole('button', { name: 'Align nodes' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalled());

    // ONE commit → ONE undo boundary.
    expect(onCommit).toHaveBeenCalledTimes(1);

    const next: ToCData = onCommit.mock.calls[0][0];
    expect(next.sections[0].columns[0].nodes[0].yPosition).toBe(120);
    expect(next.sections[1].columns[0].nodes[0].yPosition).toBe(120);
    // The committed chart is a different object graph, not the previous
    // one (sharing the mutated arrays is exactly the bug under test).
    expect(next.sections[0].columns[0].nodes[0]).not.toBe(before.sections[0].columns[0].nodes[0]);
  });

  it('one undo restores the exact pre-alignment positions', async () => {
    // If alignment mutated the previous chart in place, the history entry
    // would already be aligned and undo would restore the wrong state.
    const { doc, onCommit } = renderToC(makeMisalignedData());

    fireEvent.click(screen.getByRole('button', { name: 'Align nodes' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalled());
    expect(doc.getCommitted().sections[0].columns[0].nodes[0].yPosition).toBe(120);

    doc.undo();

    const undone = doc.getCommitted();
    expect(undone.sections[0].columns[0].nodes[0].yPosition).toBe(100);
    expect(undone.sections[1].columns[0].nodes[0].yPosition).toBe(140);
  });
});
