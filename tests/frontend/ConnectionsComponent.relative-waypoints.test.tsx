// Stored waypoints are offsets from the midpoint of the straight line
// between a connection's anchors. The renderer resolves them against the
// nodes' CURRENT positions, so moving a node moves the bend with it, and
// entries that aren't finite {dx, dy} (the earlier absolute {x, y}
// format) leave the connection on its automatic curve.
//
// jsdom has no layout, so each node's offset geometry is stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { ConnectionsComponent } from '../../src/components/ConnectionsComponent';
import type { ToCData } from '../../src/types';

interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

function placeNode(el: HTMLElement, g: Geometry) {
  Object.defineProperties(el, {
    offsetLeft: { configurable: true, value: g.x },
    offsetTop: { configurable: true, value: g.y },
    offsetWidth: { configurable: true, value: g.width },
    offsetHeight: { configurable: true, value: g.height },
  });
}

function makeData(waypoints?: unknown): ToCData {
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
                connections: [
                  {
                    targetId: 'b',
                    confidence: 75,
                    ...(waypoints !== undefined ? { waypoints: waypoints as never } : {}),
                  },
                ],
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

const noopBinding = { onPointerDown: vi.fn(), onDoubleClick: vi.fn() };

function setup(waypoints: unknown, b: Geometry = { x: 300, y: 0, width: 100, height: 60 }) {
  const data = makeData(waypoints);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const nodeA = document.createElement('div');
  const nodeB = document.createElement('div');
  container.append(nodeA, nodeB);
  placeNode(nodeA, { x: 0, y: 0, width: 100, height: 60 });
  placeNode(nodeB, b);

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
    bindWaypoint: () => noopBinding,
    bindMidpoint: () => ({ onPointerDown: vi.fn() }),
    bindPath: () => ({ onPointerDown: vi.fn() }),
  };

  const view = render(<ConnectionsComponent {...props} />, { container });
  const fatPath = () => document.querySelector('svg path.cursor-pointer') as SVGPathElement;
  const hover = () => fireEvent.mouseOver(fatPath(), { relatedTarget: document.body });
  const waypointHandle = () =>
    document.querySelector('[data-tocb-waypoint-handle]') as SVGCircleElement | null;
  const moveNodeB = (g: Geometry) => {
    placeNode(nodeB, g);
    view.rerender(<ConnectionsComponent {...props} nodeRefs={{ a: nodeA, b: nodeB }} />);
  };
  return { fatPath, hover, waypointHandle, moveNodeB };
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('body > div').forEach((el) => el.remove());
});

// Anchors for A (0,0,100x60) -> B (300,0,100x60), forward: (100, 30) and
// (286, 30). The line midpoint is (193, 30).
describe('ConnectionsComponent — relative waypoints', () => {
  it('draws the waypoint handle at the line midpoint plus its offset', () => {
    const { hover, waypointHandle } = setup([{ dx: 10, dy: -40 }]);
    hover();

    const handle = waypointHandle();
    expect(handle).not.toBeNull();
    expect(Number(handle!.getAttribute('cx'))).toBe(203);
    expect(Number(handle!.getAttribute('cy'))).toBe(-10);
  });

  it('routes the path through the resolved waypoint', () => {
    const { fatPath } = setup([{ dx: 10, dy: -40 }]);
    expect(fatPath().getAttribute('d')).toContain(' 203 -10');
  });

  it('keeps the same offset from the line when a node moves', () => {
    const { hover, waypointHandle, moveNodeB } = setup([{ dx: 10, dy: -40 }]);
    hover();

    // Anchors become (100, 30) and (486, 130): midpoint (293, 80).
    moveNodeB({ x: 500, y: 100, width: 100, height: 60 });

    const handle = waypointHandle();
    expect(Number(handle!.getAttribute('cx'))).toBe(303);
    expect(Number(handle!.getAttribute('cy'))).toBe(40);
  });

  it('keeps a pixel offset when the line shrinks', () => {
    const { hover, waypointHandle, moveNodeB } = setup([{ dx: 0, dy: -50 }]);
    hover();

    // B moves right up against A: anchors (100, 30) and (126, 30).
    moveNodeB({ x: 140, y: 0, width: 100, height: 60 });

    const handle = waypointHandle();
    expect(Number(handle!.getAttribute('cx'))).toBe(113);
    expect(Number(handle!.getAttribute('cy'))).toBe(-20);
  });

  it.each([
    ['old absolute {x, y}', [{ x: 150, y: 120 }]],
    ['non-finite offsets', [{ dx: Number.NaN, dy: 5 }]],
    ['null entry', [null]],
  ])('renders the automatic curve for %s', (_label, waypoints) => {
    const auto = setup(undefined);
    const autoD = auto.fatPath().getAttribute('d');
    cleanup();

    const { fatPath, hover, waypointHandle } = setup(waypoints);
    hover();

    expect(fatPath().getAttribute('d')).toBe(autoD);
    expect(waypointHandle()).toBeNull();
    expect(document.querySelector('[data-tocb-midpoint-handle]')).not.toBeNull();
  });
});
