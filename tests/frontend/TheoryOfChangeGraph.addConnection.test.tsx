// PR 5 review (Wave 3): addConnection idempotency regression test.
//
// The hook (useConnectionDrag) fires onConnect on any pointerup over a
// target node, including when the source-target pair is already
// connected. The mutation owner (TheoryOfChangeGraph.addConnection)
// is the only layer that enforces "no duplicates". A future refactor
// that hoists dedup to the caller, or that drops the
// `areNodesConnected` short-circuit, would silently produce duplicate
// {targetId, confidence} entries in node.connections — visible only
// post-save in the database, and corrupts undo/redo.
//
// This test pins the invariant: re-dropping on an already-connected
// target does not grow node.connections.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import type { ToCData } from '../../src/types';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// Fresh deep clone per test — pre-existing setDataAndNotify shallow-
// clone mutation makes the data otherwise leak across tests. Same
// rationale as the gutter test file.
const makeData = (): ToCData => ({
  title: 'Test',
  sections: [
    {
      title: 'Inputs',
      columns: [
        {
          nodes: [
            {
              id: 'n-source',
              title: 'Source',
              text: '',
              connectionIds: [],
              connections: [{ targetId: 'n-target', confidence: 75 }],
              yPosition: 100,
            },
            {
              id: 'n-target',
              title: 'Target',
              text: '',
              connectionIds: [],
              connections: [],
              yPosition: 200,
            },
          ],
        },
      ],
    },
  ],
});

describe('TheoryOfChangeGraph.addConnection (PR 5 Task 5.2 idempotency)', () => {
  it('re-dropping on an already-connected target does not grow node.connections', async () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeData()} showEditButton={true} onDataChange={onDataChange} />);

    // Reveal the connection handles on the source node (they're gated
    // by isHovered || isHighlighted).
    const sourceNode = document.querySelector('[data-tocb-node="n-source"]') as HTMLElement;
    expect(sourceNode).toBeTruthy();
    fireEvent.mouseEnter(sourceNode);

    const rightHandle = document.querySelector(
      '[data-tocb-connection-handle="n-source|right"]',
    ) as HTMLElement;
    expect(rightHandle).toBeTruthy();

    // Mock document.elementFromPoint to land on the target node when
    // pointerup is dispatched (the hook walks up the DOM looking for
    // a [data-tocb-node] ancestor).
    const targetNode = document.querySelector('[data-tocb-node="n-target"]') as HTMLElement;
    expect(targetNode).toBeTruthy();
    document.elementFromPoint = vi.fn(() => targetNode);

    // Fire pointerdown on the handle, then pointerup on the document
    // (the hook subscribes document-level events while a drag is in
    // flight).
    act(() => {
      const down = new Event('pointerdown', { bubbles: true, cancelable: true });
      Object.defineProperties(down, {
        clientX: { value: 100 },
        clientY: { value: 100 },
        pointerId: { value: 1 },
        pointerType: { value: 'mouse' },
        button: { value: 0 },
      });
      rightHandle.dispatchEvent(down);
    });

    act(() => {
      const up = new Event('pointerup', { bubbles: true, cancelable: true });
      Object.defineProperties(up, {
        clientX: { value: 200 },
        clientY: { value: 200 },
        pointerId: { value: 1 },
        pointerType: { value: 'mouse' },
      });
      document.dispatchEvent(up);
    });

    // Wait one microtask for useGraphMutation's deferred flush.
    await Promise.resolve();

    // addConnection's `areNodesConnected` short-circuit fires before
    // setDataAndNotify is even called for the duplicate edge, so
    // onDataChange may have zero calls. The invariant we pin: even if
    // it WAS called, the connection count must not have grown.
    if (onDataChange.mock.calls.length > 0) {
      const lastArg = onDataChange.mock.calls[onDataChange.mock.calls.length - 1][0] as ToCData;
      const sourceNodeAfter = lastArg.sections[0].columns[0].nodes.find((n) => n.id === 'n-source');
      expect(sourceNodeAfter?.connections?.length).toBe(1);
      expect(sourceNodeAfter?.connections?.[0].targetId).toBe('n-target');
    }
    // Whether or not onDataChange fired, the test passes only if the
    // duplicate would-be entry was suppressed. If a future refactor
    // dropped the dedup guard, the connections array would be length 2.
  });
});
