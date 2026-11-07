// Selecting exactly two nodes in edit mode previews the link between them:
// a ghost connection drawn in the canvas SVG, and a "+" (connect) or "−"
// (disconnect) button at its midpoint. Both are editing aids, so a PNG or
// PDF export must leave them out (`data-export-exclude`): the ghost is SVG
// (hidden for the capture by the exporter), the button is HTML (dropped by
// the capture filter).

import { describe, it, expect, afterEach } from 'vitest';
import { cleanup, fireEvent, act } from '@testing-library/react';
import type { ChartInput } from '../../src/types';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import { renderToC } from './helpers/renderToC';

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  document.body.innerHTML = '';
});

const makeData = (connected: boolean): ChartInput => ({
  title: 'Test',
  sections: [
    {
      title: 'Inputs',
      columns: [
        {
          nodes: [
            {
              id: 'n-a',
              title: 'A',
              text: '',
              connectionIds: [],
              connections: connected ? [{ targetId: 'n-b', confidence: 75 }] : [],
              yPosition: 100,
            },
          ],
        },
        {
          nodes: [{ id: 'n-b', title: 'B', text: '', connectionIds: [], yPosition: 100 }],
        },
      ],
    },
  ],
});

async function renderWithBothSelected(connected: boolean) {
  const view = renderToC(makeData(connected));
  await act(async () => {
    await Promise.resolve();
  });
  for (const id of ['n-a', 'n-b']) {
    fireEvent.click(document.querySelector(`[data-tocb-node="${id}"]`)!, { ctrlKey: true });
  }
  return view;
}

describe('previewing the link between two selected nodes', () => {
  it('marks the ghost connection for exclusion from exports', async () => {
    const { container } = await renderWithBothSelected(false);
    // The ghost is the only connection arrow inside an excluded SVG group;
    // the real connections are not editing aids.
    expect(container.querySelectorAll('svg [data-export-exclude] path[marker-end]')).toHaveLength(
      1,
    );
  });

  it('marks the connect button for exclusion from exports', async () => {
    await renderWithBothSelected(false);
    const button = document.querySelector('[title="Connect nodes"]');
    expect(button).not.toBeNull();
    expect(button!.closest('[data-export-exclude]')).not.toBeNull();
  });

  it('marks the disconnect button for exclusion from exports', async () => {
    await renderWithBothSelected(true);
    const button = document.querySelector('[title="Disconnect nodes"]');
    expect(button).not.toBeNull();
    expect(button!.closest('[data-export-exclude]')).not.toBeNull();
  });
});
