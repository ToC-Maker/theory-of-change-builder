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

// A buffered `mutateDebounced` edit has not been reported to the parent. A
// replacement the hook never notified (an undo, an AI edit, a remote
// snapshot) overwrites the preview it was made on, so the buffered edit's
// pending notify would report the replacement back to the parent as a new
// edit: for App, a wiped redo stack and an empty undo step.
describe('useGraphMutation: an external replacement while an edit is buffered', () => {
  const withTitle = (title: string) => (prev: ToCData) => ({ ...prev, title });

  it('is not reported back to the parent when the idle timer would have fired', async () => {
    vi.useFakeTimers();
    try {
      const onDataChange = vi.fn<(d: ToCData) => void>();
      const { result } = renderHook(() => useGraphMutation(baseData(), onDataChange));

      act(() => {
        result.current.mutateDebounced(withTitle('typed'), 'title');
      });
      const replacement = replacementData();
      act(() => {
        result.current.setData(replacement);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(onDataChange).not.toHaveBeenCalled();
      expect(result.current.data).toBe(replacement);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves an explicit commit of the superseded key with nothing to send', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(baseData(), onDataChange));

    act(() => {
      result.current.mutateDebounced(withTitle('typed'), 'title');
    });
    act(() => {
      result.current.setData(replacementData());
    });
    act(() => {
      result.current.commit('title');
    });
    await flushMicrotasks();

    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('does not stop a later edit of the same key from being reported', async () => {
    vi.useFakeTimers();
    try {
      const onDataChange = vi.fn<(d: ToCData) => void>();
      const { result } = renderHook(() => useGraphMutation(baseData(), onDataChange));

      act(() => {
        result.current.mutateDebounced(withTitle('typed'), 'title');
      });
      act(() => {
        result.current.setData(replacementData());
      });
      act(() => {
        result.current.mutateDebounced(withTitle('typed again'), 'title');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(onDataChange).toHaveBeenCalledTimes(1);
      expect(onDataChange.mock.calls[0][0].title).toBe('typed again');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the buffered edit when the replacement is the echo of a state the hook notified', async () => {
    vi.useFakeTimers();
    try {
      const onDataChange = vi.fn<(d: ToCData) => void>();
      const { result } = renderHook(() => useGraphMutation(baseData(), onDataChange));

      act(() => {
        result.current.mutate(withTitle('committed'));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const echoed: ToCData = onDataChange.mock.calls[0][0];

      act(() => {
        result.current.mutateDebounced(withTitle('typing'), 'title');
      });
      act(() => {
        result.current.setData(echoed);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });

      expect(result.current.data.title).toBe('typing');
      expect(onDataChange).toHaveBeenCalledTimes(2);
      expect(onDataChange.mock.calls[1][0].title).toBe('typing');
    } finally {
      vi.useRealTimers();
    }
  });
});
