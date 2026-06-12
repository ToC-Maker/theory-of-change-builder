// PR #34 round-4 feedback 67: "Auto alignment doesn't undo (or doesn't
// undo correctly)."
//
// Root cause (reproduced live with rodney): `straightenEdges` built its
// next state as `const newData = { ...prevData }` — a SHALLOW copy — and
// then assigned `newData.sections[i].columns[j].nodes[k] = {...}`. The
// nested `sections`/`columns`/`nodes` arrays were the SAME objects as
// `prevData`'s, so the assignment mutated the previous state in place.
// App.tsx's undo machinery (`handleDataChange` → `saveToHistory(
// dataRef.current)`) deep-clones the PREVIOUS data object to build the
// undo entry — but by the time the clone runs, that object already
// carries the aligned yPositions. The history entry equals the
// post-alignment state, and Ctrl+Z is a visual no-op (live evidence:
// "Undo performed, undo history length: 0" with positions unchanged).
//
// The fix routes alignment through `computeAlignedSections` (pure,
// immutable — `src/utils/alignNodes.ts`). These tests pin the contract
// the App-level undo machinery depends on:
//
//   1. The data object passed as a prop is NEVER mutated by the
//      "Align nodes" action (undo snapshot integrity).
//   2. Alignment emits exactly ONE parent notification (one undo
//      boundary — a single Ctrl+Z must restore the pre-alignment
//      state, not an increment of it).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import type { ToCData } from '../../src/types';

afterEach(() => {
  cleanup();
});

// Two nodes in different sections, vertically misaligned by 40px
// (yPosition 100 vs 140 → same alignment group, tolerance 40, group
// average 120). jsdom reports offsetHeight 0 for all nodes, so the
// component's `nodeHeights[id] || 76` fallback makes the math
// deterministic.
const makeMisalignedData = (): ToCData => ({
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
  it('Align nodes never mutates the data object passed as prop', async () => {
    const data = makeMisalignedData();
    const preClickSnapshot = JSON.parse(JSON.stringify(data));
    const onDataChange = vi.fn();

    render(<ToC data={data} showEditButton={true} onDataChange={onDataChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Align nodes' }));
    await waitFor(() => expect(onDataChange).toHaveBeenCalled());

    // The object App holds in state (and clones into the undo history)
    // must still describe the PRE-alignment chart.
    expect(data).toEqual(preClickSnapshot);
  });

  it('alignment emits exactly one parent notification carrying the aligned positions', async () => {
    const data = makeMisalignedData();
    const onDataChange = vi.fn();

    render(<ToC data={data} showEditButton={true} onDataChange={onDataChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Align nodes' }));
    await waitFor(() => expect(onDataChange).toHaveBeenCalled());

    // ONE notification → ONE saveToHistory call → ONE undo boundary.
    expect(onDataChange).toHaveBeenCalledTimes(1);

    const next: ToCData = onDataChange.mock.calls[0][0];
    expect(next.sections[0].columns[0].nodes[0].yPosition).toBe(120);
    expect(next.sections[1].columns[0].nodes[0].yPosition).toBe(120);
    // The notified object is a different object graph, not the prop
    // (sharing the mutated arrays is exactly the bug under test).
    expect(next.sections[0].columns[0].nodes[0]).not.toBe(data.sections[0].columns[0].nodes[0]);
  });

  it('one simulated undo (App contract) restores the exact pre-alignment positions', async () => {
    // Mirrors App.tsx's actual sequence: saveToHistory deep-clones
    // dataRef.current (the object passed as prop) when the change
    // notification arrives; undo then restores that clone. If
    // alignment mutated the prop in place, the clone would already be
    // aligned and undo would restore the wrong state.
    const data = makeMisalignedData();
    const onDataChange = vi.fn();

    render(<ToC data={data} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Align nodes' }));
    await waitFor(() => expect(onDataChange).toHaveBeenCalled());

    // App.tsx:1050 — saveToHistory(dataRef.current) clones the prop
    // object at notify time.
    const undoEntry: ToCData = JSON.parse(JSON.stringify(data));

    expect(undoEntry.sections[0].columns[0].nodes[0].yPosition).toBe(100);
    expect(undoEntry.sections[1].columns[0].nodes[0].yPosition).toBe(140);
  });
});
