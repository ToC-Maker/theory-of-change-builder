// K8 (PR #34 round-2 parked issue): on crossing layouts the topmost
// fat hit-path steals hover from the connection whose handle you're
// approaching — the lower connection's waypoint handle is unreachable.
//
// Reproduced live (rodney, real hit-testing via elementFromPoint) on a
// crossing chart (a→d and b→c form an X):
//   - at a→d's own curve midpoint, the element receiving pointer
//     events is b→c's fat path (later in document order wins SVG
//     hit-testing across the entire 20px-wide overlap);
//   - gliding ALONG a→d toward its midpoint handle, hover was stolen
//     at t=0.35 (`fatpath(b->c)` in the hover log) while the cursor
//     was still on a→d's curve → a→d's group fired mouseleave →
//     `hoveredEdge` flipped → a→d's handles unmounted before the
//     pointer could reach them ("HANDLE NOT MOUNTED (hover stolen)").
//
// Fix under test (least-invasive hover-priority rule): while a
// connection is hovered, every OTHER connection's fat hit-path gets
// `pointerEvents: 'none'`. Acquisition is unchanged (first contact
// happens on a non-overlapped stretch of the band); once acquired, an
// overlapping band cannot steal — the pointer must actually leave the
// hovered connection's own band before another connection can take
// hover. jsdom has no SVG hit-testing, so this pins the render-output
// contract; the end-to-end reachability is verified live (both
// connections' midpoint handles reachable on the crossing layout).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { ConnectionsComponent } from '../../src/components/ConnectionsComponent';
import type { ToCData } from '../../src/types';

// Crossing layout: a (top-left) → d (bottom-right), b (bottom-left) →
// c (top-right). Geometry is irrelevant in jsdom; two connections are
// what matters.
function makeData(): ToCData {
  return {
    sections: [
      {
        title: 'Inputs',
        columns: [
          {
            nodes: [
              {
                id: 'a',
                title: 'A',
                text: '',
                connectionIds: [],
                connections: [{ targetId: 'd', confidence: 75 }],
                yPosition: 100,
              },
              {
                id: 'b',
                title: 'B',
                text: '',
                connectionIds: [],
                connections: [{ targetId: 'c', confidence: 75 }],
                yPosition: 400,
              },
            ],
          },
        ],
      },
      {
        title: 'Outputs',
        columns: [
          {
            nodes: [
              { id: 'c', title: 'C', text: '', connectionIds: [], yPosition: 100 },
              { id: 'd', title: 'D', text: '', connectionIds: [], yPosition: 400 },
            ],
          },
        ],
      },
    ],
  };
}

function setup() {
  const data = makeData();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const refs: { [key: string]: HTMLDivElement | null } = {};
  for (const id of ['a', 'b', 'c', 'd']) {
    const el = document.createElement('div');
    container.appendChild(el);
    refs[id] = el;
  }

  const props = {
    data,
    mutate: vi.fn(),
    mutateDebounced: vi.fn(),
    commit: vi.fn(),
    nodeRefs: refs,
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
    // Waypoint/midpoint binders so hover mounts the handle layer
    // (handlesVisible requires both).
    bindWaypoint: () => ({ onPointerDown: vi.fn(), onDoubleClick: vi.fn() }),
    bindMidpoint: () => ({ onPointerDown: vi.fn() }),
  };

  render(<ConnectionsComponent {...props} />, { container });

  const fatPaths = [...document.querySelectorAll('path.cursor-pointer')] as SVGPathElement[];
  expect(fatPaths).toHaveLength(2); // [a→d, b→c] in document order
  return { fatPaths };
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('body > div').forEach((el) => el.remove());
});

describe('connection hover priority on overlapping fat paths (K8)', () => {
  it('all fat paths are hittable while no connection is hovered', () => {
    const { fatPaths } = setup();
    expect(fatPaths[0].style.pointerEvents).toBe('stroke');
    expect(fatPaths[1].style.pointerEvents).toBe('stroke');
  });

  it("hovering one connection disables the OTHERS' fat paths (no steal)", () => {
    const { fatPaths } = setup();

    // Glide onto a→d's band (enters its <g>).
    fireEvent.mouseOver(fatPaths[0], { relatedTarget: document.body });

    expect(fatPaths[0].style.pointerEvents).toBe('stroke');
    expect(fatPaths[1].style.pointerEvents).toBe('none');
  });

  it('hover release re-arms every fat path', () => {
    const { fatPaths } = setup();

    fireEvent.mouseOver(fatPaths[0], { relatedTarget: document.body });
    expect(fatPaths[1].style.pointerEvents).toBe('none');

    // Leave a→d's group entirely.
    fireEvent.mouseOut(fatPaths[0], { relatedTarget: document.body });
    fireEvent.mouseOver(document.body, { relatedTarget: fatPaths[0] });

    expect(fatPaths[0].style.pointerEvents).toBe('stroke');
    expect(fatPaths[1].style.pointerEvents).toBe('stroke');
  });

  it('priority is symmetric: hovering the later-rendered connection disables the earlier one', () => {
    const { fatPaths } = setup();

    fireEvent.mouseOver(fatPaths[1], { relatedTarget: document.body });

    expect(fatPaths[0].style.pointerEvents).toBe('none');
    expect(fatPaths[1].style.pointerEvents).toBe('stroke');
  });

  it('path ↔ own-handle transitions keep the priority (handles stay reachable)', () => {
    const { fatPaths } = setup();

    fireEvent.mouseOver(fatPaths[0], { relatedTarget: document.body });
    const handle = document.querySelector('[data-tocb-midpoint-handle="a->d|0"]');
    expect(handle).not.toBeNull();

    // Continue the glide from the path onto the handle (internal to the
    // group → hover must persist, see hover-handles regression test).
    fireEvent.mouseOut(fatPaths[0], { relatedTarget: handle });
    fireEvent.mouseOver(handle!, { relatedTarget: fatPaths[0] });

    expect(document.querySelector('[data-tocb-midpoint-handle="a->d|0"]')).not.toBeNull();
    expect(fatPaths[1].style.pointerEvents).toBe('none');
  });
});
