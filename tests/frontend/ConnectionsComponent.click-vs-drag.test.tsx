// K7 (PR #34 round-2 parked issue): starting a DRAG on a connection's
// invisible fat hit-path must do nothing — neither pan the canvas nor
// open the EdgeEditor on release. A plain click (no movement) still
// opens the editor.
//
// Reproduced live (rodney, trusted-order synthetic events): mousedown
// on the fat path → mousemove +80/+40 → mouseup. The canvas panned the
// full delta (camera left 89.4→169.4, top -239.9→-199.9) AND the
// trailing click opened the EdgeEditor — browsers fire click after a
// drag whenever mousedown/mouseup share a target, and during a pan the
// content moves WITH the cursor, so the path stays under it.
//
// Two cooperating defects:
//   1. The fat path is not excluded from panning: App.tsx's
//      `excludeFromPan` had no rule for it (and the path claims no
//      canvas-gesture mutex). Fixed by the
//      `data-tocb-connection-hitpath` attribute + matching App rule —
//      same mechanism as the waypoint handles (PR 7 feedback 18).
//   2. The path's onClick opened the editor regardless of intervening
//      drag distance. Fixed with the same movement-threshold
//      discipline as `usePointerDrag.hasMoved` (PR #34 fb 45): the
//      click handler compares the click coords against the
//      pointerdown coords and ignores beyond-threshold "clicks".
//
// The pan-exclusion integration (App.tsx closure) is covered by the
// attribute contract here + live rodney verification; precedent:
// waypoint handles pin the attribute, useZoomPan.gesture-mutex.test.ts
// pins the mutex path.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { ConnectionsComponent } from '../../src/components/ConnectionsComponent';
import { MOVE_THRESHOLD_PX } from '../../src/hooks/usePointerDrag';
import type { ToCData } from '../../src/types';

function makeData(): ToCData {
  return {
    sections: [
      {
        title: 'Activities',
        columns: [
          {
            nodes: [
              {
                id: 'a',
                title: 'A',
                text: '',
                connectionIds: [],
                connections: [{ targetId: 'b', confidence: 75 }],
              },
            ],
          },
        ],
      },
      {
        title: 'Outcomes',
        columns: [{ nodes: [{ id: 'b', title: 'B', text: '', connectionIds: [] }] }],
      },
    ],
  };
}

function setup() {
  const data = makeData();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const nodeA = document.createElement('div');
  const nodeB = document.createElement('div');
  container.append(nodeA, nodeB);

  const props = {
    data,
    mutate: vi.fn(),
    mutateDebounced: vi.fn(),
    commit: vi.fn(),
    nodeRefs: { a: nodeA, b: nodeB } as { [key: string]: HTMLDivElement | null },
    nodeHeights: {},
    highlightedNodes: new Set<string>(),
    connectedNodes: new Set<string>(),
    hoveredConnections: new Set<string>(),
    curvature: 0.5,
    editMode: true,
    sectionWidths: [200, 200],
    columnPadding: 24,
    sectionPadding: 32,
    onSizeChange: vi.fn(),
    containerRef: { current: container } as React.RefObject<HTMLDivElement | null>,
    camera: { x: 0, y: 0, z: 1 },
  };

  render(<ConnectionsComponent {...props} />, { container });

  const fatPath = document.querySelector('path.cursor-pointer') as SVGPathElement;
  expect(fatPath).not.toBeNull();
  return { fatPath };
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('body > div').forEach((el) => el.remove());
});

describe('connection fat-path click vs drag (K7)', () => {
  it('carries the pan-exclusion attribute App.excludeFromPan matches', () => {
    const { fatPath } = setup();
    expect(fatPath.hasAttribute('data-tocb-connection-hitpath')).toBe(true);
  });

  it('a drag (pointerdown → beyond-threshold click) does NOT open the EdgeEditor', () => {
    const { fatPath } = setup();

    fireEvent.pointerDown(fatPath, { clientX: 100, clientY: 100 });
    // Browser dispatches the click at the mouseup position; after a
    // drag that's far from the pointerdown.
    fireEvent.click(fatPath, { clientX: 180, clientY: 140 });

    expect(document.querySelector('.edge-editor')).toBeNull();
  });

  it('a tap (pointerdown → sub-threshold click) opens the EdgeEditor', () => {
    const { fatPath } = setup();

    fireEvent.pointerDown(fatPath, { clientX: 100, clientY: 100 });
    fireEvent.click(fatPath, {
      clientX: 100 + MOVE_THRESHOLD_PX,
      clientY: 100 + MOVE_THRESHOLD_PX,
    });

    expect(document.querySelector('.edge-editor')).not.toBeNull();
  });

  it('a click with no preceding pointerdown opens the EdgeEditor (programmatic path)', () => {
    const { fatPath } = setup();

    fireEvent.click(fatPath);

    expect(document.querySelector('.edge-editor')).not.toBeNull();
  });

  it('drag suppression is one-shot: the next clean click opens normally', () => {
    const { fatPath } = setup();

    fireEvent.pointerDown(fatPath, { clientX: 100, clientY: 100 });
    fireEvent.click(fatPath, { clientX: 200, clientY: 200 });
    expect(document.querySelector('.edge-editor')).toBeNull();

    fireEvent.pointerDown(fatPath, { clientX: 200, clientY: 200 });
    fireEvent.click(fatPath, { clientX: 201, clientY: 200 });
    expect(document.querySelector('.edge-editor')).not.toBeNull();
  });
});
