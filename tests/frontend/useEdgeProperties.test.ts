// Tests for `useEdgeProperties` — the hook that bridges the EdgeEditor
// UI to `useGraphMutation`. Single-edge only (per plan §3.3 — edges are
// addressed by source/target; no top-level collection means no useful
// multi-edge UI).
//
// Acceptance gates (per plan §3.1):
//   - Confidence slider: streaming (mutateDebounced + commit on pointerup).
//   - Evidence + assumptions: buffered local (commit on blur or close).
//   - deleteConnection removes the connection from the source node.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEdgeProperties } from '../../src/components/edge-editor/useEdgeProperties';
import type { ToCData } from '../../src/types';

interface MockMutationApi {
  mutate: ReturnType<typeof vi.fn>;
  mutateDebounced: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  dataRef: { current: ToCData };
}

function applyUpdater(prev: ToCData, updater: ((p: ToCData) => ToCData) | ToCData): ToCData {
  return typeof updater === 'function' ? (updater as (p: ToCData) => ToCData)(prev) : updater;
}

function makeMutationApi(initial: ToCData): MockMutationApi {
  const dataRef = { current: initial };
  return {
    mutate: vi.fn((updater) => {
      dataRef.current = applyUpdater(dataRef.current, updater);
    }),
    mutateDebounced: vi.fn((updater) => {
      dataRef.current = applyUpdater(dataRef.current, updater);
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
                    evidence: 'old evidence',
                    assumptions: 'old assumptions',
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

describe('useEdgeProperties', () => {
  it("reads the current connection's confidence, evidence, assumptions", () => {
    const data = makeData();
    const api = makeMutationApi(data);
    const { result } = renderHook(() =>
      useEdgeProperties({
        sourceId: 'a',
        targetId: 'b',
        data,
        mutate: api.mutate,
        mutateDebounced: api.mutateDebounced,
        commit: api.commit,
      }),
    );

    expect(result.current.confidence).toBe(60);
    expect(result.current.evidence).toBe('old evidence');
    expect(result.current.assumptions).toBe('old assumptions');
  });

  it('streams confidence via mutateDebounced and commits on commitConfidence', () => {
    const data = makeData();
    const api = makeMutationApi(data);
    const { result } = renderHook(() =>
      useEdgeProperties({
        sourceId: 'a',
        targetId: 'b',
        data,
        mutate: api.mutate,
        mutateDebounced: api.mutateDebounced,
        commit: api.commit,
      }),
    );

    act(() => {
      result.current.setConfidence(70);
      result.current.setConfidence(80);
      result.current.setConfidence(90);
    });

    // Three streaming writes, one shared key.
    expect(api.mutateDebounced).toHaveBeenCalledTimes(3);
    const keys = api.mutateDebounced.mock.calls.map((c) => c[1]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^confidence-/);

    // The dataRef reflects the latest streaming value.
    const after = api.dataRef.current;
    const aNode = after.sections[0].columns[0].nodes.find((n) => n.id === 'a');
    expect(aNode?.connections?.[0].confidence).toBe(90);

    // pointerup → commit.
    act(() => {
      result.current.commitConfidence();
    });
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(api.commit.mock.calls[0]?.[0]).toMatch(/^confidence-/);
  });

  it('buffers evidence locally; commit produces a single mutate path', () => {
    const data = makeData();
    const api = makeMutationApi(data);
    const { result } = renderHook(() =>
      useEdgeProperties({
        sourceId: 'a',
        targetId: 'b',
        data,
        mutate: api.mutate,
        mutateDebounced: api.mutateDebounced,
        commit: api.commit,
      }),
    );

    act(() => {
      result.current.setEvidence('new evidence');
    });
    expect(result.current.evidence).toBe('new evidence');
    expect(api.mutateDebounced).toHaveBeenCalledTimes(1);
    expect(api.mutateDebounced.mock.calls[0]?.[1]).toMatch(/^evidence-/);

    act(() => {
      result.current.commitEvidence();
    });
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(api.commit.mock.calls[0]?.[0]).toMatch(/^evidence-/);
  });

  it('buffers assumptions locally; commit produces a single mutate path', () => {
    const data = makeData();
    const api = makeMutationApi(data);
    const { result } = renderHook(() =>
      useEdgeProperties({
        sourceId: 'a',
        targetId: 'b',
        data,
        mutate: api.mutate,
        mutateDebounced: api.mutateDebounced,
        commit: api.commit,
      }),
    );

    act(() => {
      result.current.setAssumptions('new assumptions');
    });
    expect(result.current.assumptions).toBe('new assumptions');
    expect(api.mutateDebounced).toHaveBeenCalledTimes(1);
    expect(api.mutateDebounced.mock.calls[0]?.[1]).toMatch(/^assumptions-/);

    act(() => {
      result.current.commitAssumptions();
    });
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(api.commit.mock.calls[0]?.[0]).toMatch(/^assumptions-/);
  });

  it('deleteConnection removes the connection from the source node atomically', () => {
    const data = makeData();
    const api = makeMutationApi(data);
    const { result } = renderHook(() =>
      useEdgeProperties({
        sourceId: 'a',
        targetId: 'b',
        data,
        mutate: api.mutate,
        mutateDebounced: api.mutateDebounced,
        commit: api.commit,
      }),
    );

    act(() => {
      result.current.deleteConnection();
    });

    expect(api.mutate).toHaveBeenCalledTimes(1);
    const after = api.dataRef.current;
    const aNode = after.sections[0].columns[0].nodes.find((n) => n.id === 'a');
    // Both the new-format `connections` and the legacy `connectionIds`
    // should drop the deleted target.
    expect(aNode?.connections ?? []).toEqual([]);
    expect(aNode?.connectionIds).toEqual([]);
  });

  it('updating evidence does NOT clobber confidence on the same connection', () => {
    const data = makeData();
    const api = makeMutationApi(data);
    const { result } = renderHook(() =>
      useEdgeProperties({
        sourceId: 'a',
        targetId: 'b',
        data,
        mutate: api.mutate,
        mutateDebounced: api.mutateDebounced,
        commit: api.commit,
      }),
    );

    act(() => {
      result.current.setEvidence('e2');
    });
    const after = api.dataRef.current;
    const aNode = after.sections[0].columns[0].nodes.find((n) => n.id === 'a');
    // Confidence still 60 from the initial fixture.
    expect(aNode?.connections?.[0].confidence).toBe(60);
    expect(aNode?.connections?.[0].evidence).toBe('e2');
  });
});
