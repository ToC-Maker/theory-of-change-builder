// Tests for `EdgeEditor` — the unified anchored edge-property editor.
//
// Acceptance gates (per plan §3.3):
//   - Renders when a (sourceId, targetId) edge is selected.
//   - Confidence slider mutates via mutateDebounced + commit on
//     pointerup.
//   - Evidence / assumptions edits buffer locally and commit on blur.
//   - Delete button removes the connection from the source node and
//     fires onRequestClose.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { EdgeEditor } from '../../src/components/edge-editor/EdgeEditor';
import type { ToCData } from '../../src/types';

function makeMutationApi(initial: ToCData) {
  const dataRef = { current: initial };
  const apply = (prev: ToCData, updater: ((p: ToCData) => ToCData) | ToCData): ToCData =>
    typeof updater === 'function' ? (updater as (p: ToCData) => ToCData)(prev) : updater;
  return {
    mutate: vi.fn((updater) => {
      dataRef.current = apply(dataRef.current, updater);
    }),
    mutateDebounced: vi.fn((updater) => {
      dataRef.current = apply(dataRef.current, updater);
    }),
    commit: vi.fn(),
    dataRef,
  };
}

function makeData(): ToCData {
  return {
    sections: [
      {
        title: 'S',
        columns: [
          {
            nodes: [
              {
                id: 'a',
                title: 'A',
                text: '',
                connectionIds: ['b'],
                connections: [
                  {
                    targetId: 'b',
                    confidence: 60,
                    evidence: '',
                    assumptions: '',
                  },
                ],
              },
              { id: 'b', title: 'B', text: '', connectionIds: [] },
            ],
          },
        ],
      },
    ],
  };
}

function renderEdgeEditor(props: {
  data?: ToCData;
  api?: ReturnType<typeof makeMutationApi>;
  onRequestClose?: () => void;
}) {
  const data = props.data ?? makeData();
  const api = props.api ?? makeMutationApi(data);
  const anchor = document.createElement('div');
  anchor.id = 'edge-anchor';
  document.body.appendChild(anchor);
  const anchorRef = { current: anchor } as React.RefObject<HTMLElement>;
  const utils = render(
    <EdgeEditor
      sourceId="a"
      targetId="b"
      data={data}
      mutate={api.mutate}
      mutateDebounced={api.mutateDebounced}
      commit={api.commit}
      anchorRef={anchorRef}
      camera={{ x: 0, y: 0, z: 1 }}
      onRequestClose={props.onRequestClose ?? (() => {})}
    />,
  );
  return { ...utils, api, anchor };
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('#edge-anchor').forEach((el) => el.remove());
});

describe('EdgeEditor', () => {
  it('renders the current confidence value', () => {
    renderEdgeEditor({});
    const slider = screen.getByRole('slider', { name: /confidence/i }) as HTMLInputElement;
    expect(slider.value).toBe('60');
  });

  it('streams confidence via mutateDebounced; commits on pointerup', () => {
    const { api } = renderEdgeEditor({});
    const slider = screen.getByRole('slider', { name: /confidence/i });

    fireEvent.change(slider, { target: { value: '75' } });
    fireEvent.change(slider, { target: { value: '85' } });

    expect(api.mutateDebounced).toHaveBeenCalledTimes(2);
    const keys = api.mutateDebounced.mock.calls.map((c) => c[1]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^confidence-/);

    expect(api.commit).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(api.commit.mock.calls[0]?.[0]).toMatch(/^confidence-/);
  });

  it('buffers evidence + assumptions and commits on blur', () => {
    const { api } = renderEdgeEditor({});

    const evidence = screen.getByRole('textbox', { name: /evidence/i }) as HTMLTextAreaElement;
    fireEvent.change(evidence, { target: { value: 'new evidence' } });
    fireEvent.blur(evidence);

    const assumptions = screen.getByRole('textbox', {
      name: /assumptions/i,
    }) as HTMLTextAreaElement;
    fireEvent.change(assumptions, { target: { value: 'new assumptions' } });
    fireEvent.blur(assumptions);

    const commitKeys = api.commit.mock.calls.map((c) => c[0]);
    expect(commitKeys.some((k) => typeof k === 'string' && k.startsWith('evidence-'))).toBe(true);
    expect(commitKeys.some((k) => typeof k === 'string' && k.startsWith('assumptions-'))).toBe(
      true,
    );
  });

  it('deletes the connection and fires onRequestClose', () => {
    const onRequestClose = vi.fn();
    const { api } = renderEdgeEditor({ onRequestClose });

    const del = screen.getByRole('button', { name: /delete connection/i });
    fireEvent.click(del);

    expect(api.mutate).toHaveBeenCalledTimes(1);
    expect(onRequestClose).toHaveBeenCalled();

    const after = api.dataRef.current;
    const aNode = after.sections[0].columns[0].nodes.find((n) => n.id === 'a');
    expect(aNode?.connections ?? []).toEqual([]);
    expect(aNode?.connectionIds).toEqual([]);
  });
});
