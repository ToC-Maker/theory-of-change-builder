// Tests for `useNodeProperties` — the hook that bridges the NodeEditor
// UI to `useGraphMutation`. Centralizes the property-edit semantics for
// the new unified NodeEditor (replaces the per-selection toolbar + the
// inline contentEditable + the pencil-icon NodePopup, all of which had
// divergent commit semantics).
//
// Acceptance gates (per plan §3.1):
//   - Live (streaming): `setWidth` (mutateDebounced + commit on pointerup),
//     `setColor` (mutate; the color picker emits one value).
//   - Buffered (typing): `setTitle` (mutateDebounced + 200ms idle + blur
//     commit), `setDetails` (buffered local; commit on blur or expander
//     close).
//   - Multi-selection: writes apply to all selected nodes; title/details
//     show 'Multiple values' placeholder (caller-detected via the
//     `isTitleMixed` / `isDetailsMixed` flags exposed by the hook).
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNodeProperties } from '../../src/components/node-editor/useNodeProperties';
import type { ToCData } from '../../src/types';

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

interface MockMutationApi {
  mutate: ReturnType<typeof vi.fn>;
  mutateDebounced: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  dataRef: { current: ToCData };
}

function applyUpdater(prev: ToCData, updater: ((p: ToCData) => ToCData) | ToCData): ToCData {
  return typeof updater === 'function' ? (updater as (p: ToCData) => ToCData)(prev) : updater;
}

/**
 * A minimal `useGraphMutation` stand-in. Pads the mutator surface so
 * `useNodeProperties` can be tested without spinning up the full hook.
 * Records calls so we can assert keys + cadence, while still applying the
 * updater to a shared `dataRef` so the hook reads back consistent values.
 */
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

function makeData(
  nodes: { id: string; title?: string; text?: string; width?: number; color?: string }[],
): ToCData {
  return {
    sections: [
      {
        title: 'Section A',
        columns: [
          {
            nodes: nodes.map((n) => ({
              id: n.id,
              title: n.title ?? '',
              text: n.text ?? '',
              connectionIds: [],
              width: n.width,
              color: n.color,
            })),
          },
        ],
      },
    ],
  };
}

describe('useNodeProperties', () => {
  describe('single selection', () => {
    it("reads the selected node's width and color", () => {
      const data = makeData([
        { id: 'a', title: 'A', text: 'detail A', width: 200, color: '#ff0000' },
      ]);
      const api = makeMutationApi(data);
      const { result } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: ['a'],
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      expect(result.current.width).toBe(200);
      expect(result.current.color).toBe('#ff0000');
      expect(result.current.title).toBe('A');
      expect(result.current.details).toBe('detail A');
      expect(result.current.isTitleMixed).toBe(false);
      expect(result.current.isDetailsMixed).toBe(false);
    });

    it('streams width via mutateDebounced and commits on commitWidth', () => {
      const data = makeData([{ id: 'a', width: 192 }]);
      const api = makeMutationApi(data);
      const { result } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: ['a'],
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      // Drag: three rapid setWidth calls.
      act(() => {
        result.current.setWidth(200);
        result.current.setWidth(220);
        result.current.setWidth(240);
      });

      expect(api.mutateDebounced).toHaveBeenCalledTimes(3);
      // All calls should share ONE key so per-key flush collapses to one
      // parent notify, i.e. one undo entry per drag gesture.
      const widthKeys = api.mutateDebounced.mock.calls.map((c) => c[1]);
      expect(new Set(widthKeys).size).toBe(1);
      expect(widthKeys[0]).toMatch(/^width-/);
      expect(api.commit).not.toHaveBeenCalled();

      // pointerup → commit.
      act(() => {
        result.current.commitWidth();
      });

      expect(api.commit).toHaveBeenCalledTimes(1);
      expect(api.commit.mock.calls[0]?.[0]).toMatch(/^width-/);
    });

    it('uses mutate (not debounced) for color since picker emits one value', () => {
      const data = makeData([{ id: 'a', color: '#ffffff' }]);
      const api = makeMutationApi(data);
      const { result } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: ['a'],
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      act(() => {
        result.current.setColor('#ff0000');
      });

      expect(api.mutate).toHaveBeenCalledTimes(1);
      // Direct discrete write — no per-key buffering needed.
      expect(api.mutateDebounced).not.toHaveBeenCalled();
    });

    it('buffers title locally and only writes after typing', async () => {
      const data = makeData([{ id: 'a', title: 'old' }]);
      const api = makeMutationApi(data);
      const { result } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: ['a'],
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      act(() => {
        result.current.setTitle('new');
      });

      // Local state reflects the typed value immediately.
      expect(result.current.title).toBe('new');
      // Streaming write to mutateDebounced (one undo entry per typing
      // session via per-key buffering).
      expect(api.mutateDebounced).toHaveBeenCalledTimes(1);
      const titleKeys = api.mutateDebounced.mock.calls.map((c) => c[1]);
      expect(titleKeys[0]).toMatch(/^title-/);

      // Blur → commit.
      act(() => {
        result.current.commitTitle();
      });

      expect(api.commit).toHaveBeenCalledTimes(1);
      expect(api.commit.mock.calls[0]?.[0]).toMatch(/^title-/);
    });

    it('buffers details locally; commit triggers a single mutate + commit', () => {
      const data = makeData([{ id: 'a', text: 'old detail' }]);
      const api = makeMutationApi(data);
      const { result } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: ['a'],
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      act(() => {
        result.current.setDetails('a');
        result.current.setDetails('ab');
        result.current.setDetails('abc');
      });

      // Local state previews each keystroke immediately.
      expect(result.current.details).toBe('abc');
      // mutateDebounced wires the live state so external observers see
      // partial typing (same shape as title).
      expect(api.mutateDebounced.mock.calls.length).toBeGreaterThan(0);
      const detailsKeys = api.mutateDebounced.mock.calls.map((c) => c[1]);
      detailsKeys.forEach((k) => expect(k).toMatch(/^details-/));

      act(() => {
        result.current.commitDetails();
      });

      expect(api.commit).toHaveBeenCalled();
      expect(api.commit.mock.lastCall?.[0]).toMatch(/^details-/);
    });

    it('exposes deleteSelectedNodes that wraps a synchronous mutate', () => {
      const data = makeData([{ id: 'a' }, { id: 'b' }]);
      const api = makeMutationApi(data);
      const { result } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: ['a'],
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      act(() => {
        result.current.deleteSelectedNodes();
      });

      expect(api.mutate).toHaveBeenCalledTimes(1);
      // After the updater runs, the deleted node is gone from dataRef.
      const after = api.dataRef.current;
      const remaining = after.sections.flatMap((s) => s.columns.flatMap((c) => c.nodes));
      expect(remaining.map((n) => n.id)).toEqual(['b']);
    });
  });

  describe('multi-selection', () => {
    it('reports isTitleMixed=true when selected nodes have different titles', () => {
      const data = makeData([
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ]);
      const api = makeMutationApi(data);
      const { result } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: ['a', 'b'],
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      expect(result.current.isTitleMixed).toBe(true);
      // Convention: when mixed, expose '' so the input renders the
      // placeholder cleanly.
      expect(result.current.title).toBe('');
    });

    it('reports isTitleMixed=false when selected nodes share a title', () => {
      const data = makeData([
        { id: 'a', title: 'Same' },
        { id: 'b', title: 'Same' },
      ]);
      const api = makeMutationApi(data);
      const { result } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: ['a', 'b'],
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      expect(result.current.isTitleMixed).toBe(false);
      expect(result.current.title).toBe('Same');
    });

    it('setWidth applies to ALL selected nodes (the only currently-mutated property in multi)', async () => {
      const data = makeData([
        { id: 'a', width: 192 },
        { id: 'b', width: 192 },
        { id: 'c', width: 192 },
      ]);
      const api = makeMutationApi(data);
      const { result } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: ['a', 'b'],
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      act(() => {
        result.current.setWidth(300);
      });

      // Inspect what the updater wrote to dataRef.
      const after = api.dataRef.current;
      const nodes = after.sections.flatMap((s) => s.columns.flatMap((c) => c.nodes));
      const byId = Object.fromEntries(nodes.map((n) => [n.id, n.width]));
      expect(byId.a).toBe(300);
      expect(byId.b).toBe(300);
      // Node c was not selected — width unchanged.
      expect(byId.c).toBe(192);

      await flushMicrotasks();
    });

    it('setColor applies to ALL selected nodes', () => {
      const data = makeData([
        { id: 'a', color: '#ffffff' },
        { id: 'b', color: '#ffffff' },
        { id: 'c', color: '#ffffff' },
      ]);
      const api = makeMutationApi(data);
      const { result } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: ['a', 'b'],
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      act(() => {
        result.current.setColor('#00ff00');
      });

      const after = api.dataRef.current;
      const nodes = after.sections.flatMap((s) => s.columns.flatMap((c) => c.nodes));
      const byId = Object.fromEntries(nodes.map((n) => [n.id, n.color]));
      expect(byId.a).toBe('#00ff00');
      expect(byId.b).toBe('#00ff00');
      expect(byId.c).toBe('#ffffff');
    });

    it('deleteSelectedNodes removes ALL selected nodes in one mutate', () => {
      const data = makeData([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
      const api = makeMutationApi(data);
      const { result } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: ['a', 'c'],
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      act(() => {
        result.current.deleteSelectedNodes();
      });

      expect(api.mutate).toHaveBeenCalledTimes(1);
      const after = api.dataRef.current;
      const remaining = after.sections.flatMap((s) => s.columns.flatMap((c) => c.nodes));
      expect(remaining.map((n) => n.id)).toEqual(['b']);
    });
  });

  describe('selection change preserves local buffer correctness', () => {
    it('resets buffered title when the selection changes to a different node', () => {
      let selection = ['a'];
      const data = makeData([
        { id: 'a', title: 'A' },
        { id: 'b', title: 'B' },
      ]);
      const api = makeMutationApi(data);
      const { result, rerender } = renderHook(() =>
        useNodeProperties({
          selectedNodeIds: selection,
          data,
          mutate: api.mutate,
          mutateDebounced: api.mutateDebounced,
          commit: api.commit,
        }),
      );

      expect(result.current.title).toBe('A');

      // User types into A.
      act(() => {
        result.current.setTitle('A-typed');
      });
      expect(result.current.title).toBe('A-typed');

      // Selection switches to B (e.g. user clicks node B). The buffer
      // should *not* carry "A-typed" over — the new selection reads its
      // own title.
      selection = ['b'];
      rerender();

      expect(result.current.title).toBe('B');
    });
  });
});
