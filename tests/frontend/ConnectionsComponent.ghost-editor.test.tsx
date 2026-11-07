// An open EdgeEditor follows its connection: when someone else deletes the
// connection (or one of its end nodes), the editor closes instead of
// lingering over a line that is gone, and it stays closed if the
// connection comes back.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { ConnectionsComponent } from '../../src/components/ConnectionsComponent';
import type { Node, ToCData } from '../../src/types';

function chart(opts: { connectionAtoB?: boolean; confidence?: number; nodeB?: boolean }): ToCData {
  const { connectionAtoB = true, confidence = 75, nodeB = true } = opts;
  const nodeA: Node = {
    id: 'a',
    title: 'A',
    text: '',
    connectionIds: connectionAtoB ? ['b'] : [],
    connections: connectionAtoB ? [{ targetId: 'b', confidence }] : [],
  };
  const nodeBNode: Node = { id: 'b', title: 'B', text: '', connectionIds: [] };
  return {
    sections: [
      { title: 'Activities', columns: [{ nodes: [nodeA] }] },
      { title: 'Outcomes', columns: [{ nodes: nodeB ? [nodeBNode] : [] }] },
    ],
  };
}

function setup(data: ToCData) {
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
    titleBlockShown: true,
    sectionWidths: [200, 200],
    columnPadding: 24,
    sectionPadding: 32,
    onSizeChange: vi.fn(),
    containerRef: { current: container } as React.RefObject<HTMLDivElement | null>,
    camera: { x: 0, y: 0, z: 1 },
  };
  const utils = render(<ConnectionsComponent {...props} />, { container });
  return { utils, props };
}

function openEdgeEditor() {
  const clickPath = document.querySelector('path.cursor-pointer');
  expect(clickPath).not.toBeNull();
  fireEvent.click(clickPath!);
  expect(document.querySelector('.edge-editor')).not.toBeNull();
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('body > div').forEach((el) => el.remove());
});

describe('ConnectionsComponent with an open EdgeEditor', () => {
  it('edge_editor_closes_when_connection_disappears', () => {
    const { utils, props } = setup(chart({}));
    openEdgeEditor();

    utils.rerender(<ConnectionsComponent {...props} data={chart({ connectionAtoB: false })} />);

    expect(document.querySelector('.edge-editor')).toBeNull();
  });

  it('closes when the connection is left dangling by a deleted end node', () => {
    const { utils, props } = setup(chart({}));
    openEdgeEditor();

    const danglingChart = chart({ nodeB: false });
    expect(danglingChart.sections[0].columns[0].nodes[0].connections).toHaveLength(1);
    utils.rerender(<ConnectionsComponent {...props} data={danglingChart} />);

    expect(document.querySelector('.edge-editor')).toBeNull();
  });

  it('stays closed when the connection comes back', () => {
    const { utils, props } = setup(chart({}));
    openEdgeEditor();

    utils.rerender(<ConnectionsComponent {...props} data={chart({ connectionAtoB: false })} />);
    utils.rerender(<ConnectionsComponent {...props} data={chart({})} />);

    expect(document.querySelector('.edge-editor')).toBeNull();
  });

  it('keeps the same editor open while its connection exists, whatever else changes', () => {
    const { utils, props } = setup(chart({}));
    openEdgeEditor();
    const editor = document.querySelector('.edge-editor');

    utils.rerender(<ConnectionsComponent {...props} data={chart({ confidence: 90 })} />);

    expect(document.querySelector('.edge-editor')).toBe(editor);
  });

  it('closes on a legacy chart whose connectionIds lose the target', () => {
    const legacy = (ids: string[]): ToCData => ({
      sections: [
        {
          title: 'Activities',
          columns: [{ nodes: [{ id: 'a', title: 'A', text: '', connectionIds: ids }] }],
        },
        {
          title: 'Outcomes',
          columns: [{ nodes: [{ id: 'b', title: 'B', text: '', connectionIds: [] }] }],
        },
      ],
    });
    const { utils, props } = setup(legacy(['b']));
    openEdgeEditor();

    utils.rerender(<ConnectionsComponent {...props} data={legacy([])} />);

    expect(document.querySelector('.edge-editor')).toBeNull();
  });
});
