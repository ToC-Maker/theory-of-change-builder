// Regression test for the second pan-leak path of PR #34 feedback (50)
// and the handle-hover flicker behind it.
//
// Symptom (reproduced with CDP trusted input): glide the mouse along a
// connection's curve onto its waypoint/midpoint handle — the handles
// VANISH the moment the pointer reaches the handle, and a subsequent
// press lands on the bare canvas/path and PANS the canvas instead of
// dragging the waypoint.
//
// Mechanism: hover state (`hoveredEdge`) was owned by onMouseEnter /
// onMouseLeave on the invisible fat hit-path. The handle circles are
// SIBLINGS of that path (rendered above it), so moving from the path
// onto a handle fires `mouseleave` on the path → `hoveredEdge = null`
// → `handlesVisible = false` → the handle under the pointer unmounts.
//
// Fix: hover handlers live on the per-connection `<g>` wrapper, which
// contains BOTH the hit path and the handles layer. Path ↔ handle
// transitions are internal to the group, so no leave fires and the
// handles stay mounted under the pointer.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import type { ToCData } from '../../src/types';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

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

function renderGraphAndHoverPath() {
  render(<ToC data={makeData()} showEditButton={true} onDataChange={vi.fn()} />);

  const fatPath = document.querySelector('svg path.cursor-pointer') as SVGPathElement;
  expect(fatPath).toBeTruthy();

  // Glide onto the path: hover state engages, handles mount.
  fireEvent.mouseOver(fatPath, { relatedTarget: document.body });
  const midpoint = document.querySelector('[data-tocb-midpoint-handle]') as SVGCircleElement;
  expect(midpoint).toBeTruthy();

  return { fatPath, midpoint };
}

describe('connection handle hover stability (PR #34 feedback 50, leak path 2)', () => {
  it('handles stay mounted when the pointer moves from the path onto a handle', () => {
    const { fatPath, midpoint } = renderGraphAndHoverPath();

    // Continue the glide FROM the path ONTO the midpoint handle. The
    // browser fires mouseout(path → handle) + mouseover(handle ← path).
    fireEvent.mouseOut(fatPath, { relatedTarget: midpoint });
    fireEvent.mouseOver(midpoint, { relatedTarget: fatPath });

    // The handle under the pointer must still exist — otherwise the
    // user's press falls through to the canvas and pans it.
    expect(document.querySelector('[data-tocb-midpoint-handle]')).toBeTruthy();
  });

  it('handles unmount when the pointer leaves the connection entirely', () => {
    const { fatPath } = renderGraphAndHoverPath();

    // Leave toward something outside the connection's group.
    fireEvent.mouseOut(fatPath, { relatedTarget: document.body });
    fireEvent.mouseOver(document.body, { relatedTarget: fatPath });

    expect(document.querySelector('[data-tocb-midpoint-handle]')).toBeNull();
  });
});
