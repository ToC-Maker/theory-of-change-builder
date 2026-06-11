// Editor mutual exclusion (PR 34 feedback item 49): the NodeEditor and
// EdgeEditor must never display at the same time — opening one closes
// the other.
//
// The two selections live in different owners: node selection
// (`highlightedNodes`) in TheoryOfChangeGraph, edge selection
// (`selectedEdge`) in ConnectionsComponent. Mouse flows are already
// mutually exclusive *emergently*: both editors dismiss on document
// `mousedown` (via `useDismissOnOutsideEvent`), and every mouse path
// that changes one selection starts with a mousedown that lands outside
// the other editor. The hole is node-selection paths that involve NO
// mousedown — keyboard select-all (Ctrl/Cmd+A → `selectAllNodes`) and
// Tab node-navigation (`navigateNodes`), both in
// `useKeyboardShortcuts.ts`. With the EdgeEditor open, either of those
// mounts the NodeEditor while `selectedEdge` is still set → both
// editors visible (reproduced live with trusted CDP input).
//
// The invariant under test: when `highlightedNodes` transitions to a
// non-empty set while an edge is selected, ConnectionsComponent must
// drop `selectedEdge` (unmounting the EdgeEditor) — regardless of which
// input gesture caused the selection.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { ConnectionsComponent } from '../../src/components/ConnectionsComponent';
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

function setup(highlightedNodes: Set<string>) {
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
    highlightedNodes,
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

  const utils = render(<ConnectionsComponent {...props} />, { container });
  return { utils, props, container };
}

afterEach(() => {
  cleanup();
  // setup() appends the container manually; RTL cleanup unmounts but
  // doesn't remove containers it didn't create.
  document.querySelectorAll('body > div').forEach((el) => el.remove());
});

describe('ConnectionsComponent editor exclusivity (feedback 49)', () => {
  it('closes the EdgeEditor when node selection becomes non-empty', () => {
    const { utils, props } = setup(new Set());

    // Open the EdgeEditor by clicking the connection's invisible
    // click-target path.
    const clickPath = document.querySelector('path.cursor-pointer');
    expect(clickPath).not.toBeNull();
    fireEvent.click(clickPath!);
    expect(document.querySelector('.edge-editor')).not.toBeNull();

    // Node selection arrives with NO intervening mousedown — the
    // keyboard select-all / Tab-navigation shape. The EdgeEditor must
    // close; otherwise both editors render simultaneously.
    utils.rerender(<ConnectionsComponent {...props} highlightedNodes={new Set(['a'])} />);
    expect(document.querySelector('.edge-editor')).toBeNull();
  });

  it('keeps the EdgeEditor open across unrelated rerenders while selection stays empty', () => {
    const { utils, props } = setup(new Set());

    const clickPath = document.querySelector('path.cursor-pointer');
    fireEvent.click(clickPath!);
    expect(document.querySelector('.edge-editor')).not.toBeNull();

    // Same-size empty set, new identity — must NOT close the editor
    // (parents recreate Sets freely on rerender).
    utils.rerender(<ConnectionsComponent {...props} highlightedNodes={new Set()} />);
    expect(document.querySelector('.edge-editor')).not.toBeNull();
  });
});
