// addConnection idempotency regression test.
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
import { cleanup, fireEvent, act } from '@testing-library/react';
import type { ChartInput } from '../../src/types';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import { renderToC } from './helpers/renderToC';

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// A fresh object per test; the document freezes it, so an updater that
// writes into the state it receives throws.
const makeData = (): ChartInput => ({
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

describe('TheoryOfChangeGraph.addConnection idempotency', () => {
  it('re-dropping on an already-connected target does not grow node.connections', async () => {
    const { doc, onCommit } = renderToC(makeData());

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

    // Wait one microtask for the gesture's deferred commit.
    await Promise.resolve();

    // The duplicate edge is suppressed before the store is written, so
    // nothing commits. Both layers must still hold the single original
    // connection: without the dedup guard the array would have two.
    expect(onCommit).not.toHaveBeenCalled();
    for (const chart of [doc.getLive(), doc.getCommitted()]) {
      const sourceNodeAfter = chart.sections[0].columns[0].nodes.find((n) => n.id === 'n-source');
      expect(sourceNodeAfter?.connections).toEqual([{ targetId: 'n-target', confidence: 75 }]);
    }
  });
});
