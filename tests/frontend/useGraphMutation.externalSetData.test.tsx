// Regression for the stale-`dataRef` bug: when the parent replaces the
// data via the hook's exposed `setData` (the AI-edit / external-state-
// replace path in TheoryOfChangeGraph.tsx:219-224), the next `mutate()`
// must derive from the NEW state, not the pre-replacement snapshot.
//
// Pre-fix:
//   1. User edits a chart with one node, asks AI to add a section.
//   2. Parent receives the streamed edit, sets `initialData` to the new
//      graph, the effect calls `setData(initialData)`.
//   3. React state has the new graph; `dataRef.current` still has the
//      old, because `setData` is the raw React setter and bypasses
//      `writeLocal`.
//   4. User drags a node before any other `mutate()` runs ->
//      `mutate(prev => ...)` -> writeLocal applies the updater against
//      the stale `dataRef.current`, wiping the AI's section addition.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import type { ToCData } from '../../src/types';

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const baseData = (): ToCData => ({
  title: 'init',
  sections: [
    {
      title: 'Original',
      columns: [
        {
          title: 'Col A',
          nodes: [
            {
              id: 'node-a',
              title: 'A',
              text: 'a',
              connectionIds: [],
              connections: [],
            },
          ],
        },
      ],
    },
  ],
});

const replacementData = (): ToCData => ({
  title: 'after-ai-edit',
  sections: [
    {
      title: 'Original',
      columns: [
        {
          title: 'Col A',
          nodes: [
            {
              id: 'node-a',
              title: 'A',
              text: 'a',
              connectionIds: [],
              connections: [],
            },
          ],
        },
      ],
    },
    {
      title: 'AI-added section',
      columns: [
        {
          title: 'New col',
          nodes: [],
        },
      ],
    },
  ],
});

describe('useGraphMutation: external setData + subsequent mutate', () => {
  it('mutate after setData(newData) derives from the new data, not the stale snapshot', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(baseData(), onDataChange));

    // External replacement (AI-edit path).
    act(() => {
      result.current.setData(replacementData());
    });
    expect(result.current.data.sections.length).toBe(2);

    // User mutation that depends on the replaced state.
    act(() => {
      result.current.mutate((prev) => ({
        ...prev,
        title: prev.title + '-edited',
      }));
    });

    await flushMicrotasks();

    // The mutate updater must have observed the replaced data.
    expect(result.current.data.title).toBe('after-ai-edit-edited');
    expect(result.current.data.sections.length).toBe(2);

    // Parent learns the replaced + mutated value.
    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(onDataChange.mock.calls[0]?.[0].title).toBe('after-ai-edit-edited');
    expect(onDataChange.mock.calls[0]?.[0].sections.length).toBe(2);
  });
});
