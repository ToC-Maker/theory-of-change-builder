// The parent stores whatever the hook notifies it of and passes it back
// as `initialData`; the graph's "absorb new initialData" effect then calls
// the hook's `setData` with it. That effect runs after the render that
// carries the echo, so it can land after the user's NEXT edit. Applying
// the echo then replaced the newer local state with the older one: a
// colour picked a moment after a title edit was reverted on screen and
// never reached the parent or the server.
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import type { ToCData } from '../../src/types';

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const makeData = (): ToCData => ({
  title: 'init',
  sections: [
    {
      title: 'S',
      columns: [
        {
          nodes: [
            {
              id: 'n1',
              title: 'Alpha',
              text: '',
              connectionIds: [],
              connections: [],
              color: '#ffffff',
            },
          ],
        },
      ],
    },
  ],
});

const node = (d: ToCData) => d.sections[0].columns[0].nodes[0];
const setTitle = (title: string) => (prev: ToCData) => ({
  ...prev,
  sections: [
    {
      ...prev.sections[0],
      columns: [{ nodes: [{ ...node(prev), title }] }],
    },
  ],
});
const setColor = (color: string) => (prev: ToCData) => ({
  ...prev,
  sections: [
    {
      ...prev.sections[0],
      columns: [{ nodes: [{ ...node(prev), color }] }],
    },
  ],
});

describe('useGraphMutation: the parent echoing back what the hook notified it of', () => {
  it('does not roll newer local edits back to the echoed state', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    // Title typed and committed: the parent is told.
    act(() => {
      result.current.mutateDebounced(setTitle('Alphak'), 'title-n1');
      result.current.commit('title-n1');
    });
    await flushMicrotasks();
    const echoed = onDataChange.mock.calls[0][0];

    // The user picks a colour before the parent's echo is absorbed.
    act(() => {
      result.current.mutate(setColor('#00aa00'));
    });
    // The absorb effect now applies the echo from the earlier render.
    act(() => {
      result.current.setData(echoed);
    });
    await flushMicrotasks();

    expect(node(result.current.data).color).toBe('#00aa00');
    expect(node(result.current.data).title).toBe('Alphak');
    // The parent hears about the colour, not the echoed older state.
    const last = onDataChange.mock.calls.at(-1)![0];
    expect(node(last).color).toBe('#00aa00');
  });

  it('does not roll back to an older echo that arrives after a newer notification', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutate(setTitle('one'));
    });
    await flushMicrotasks();
    const firstEcho = onDataChange.mock.calls[0][0];
    act(() => {
      result.current.mutate(setTitle('two'));
    });
    await flushMicrotasks();

    act(() => {
      result.current.setData(firstEcho);
    });

    expect(node(result.current.data).title).toBe('two');
  });

  it('still applies a state the hook never notified the parent of', async () => {
    const onDataChange = vi.fn<(d: ToCData) => void>();
    const { result } = renderHook(() => useGraphMutation(makeData(), onDataChange));

    act(() => {
      result.current.mutate(setTitle('local'));
    });
    await flushMicrotasks();

    // An AI edit, a remote snapshot or an undo hands over a new object.
    const external = setTitle('from elsewhere')(makeData());
    act(() => {
      result.current.setData(external);
    });

    expect(node(result.current.data).title).toBe('from elsewhere');
    act(() => {
      result.current.mutate(setColor('#123456'));
    });
    expect(node(result.current.data).title).toBe('from elsewhere');
  });
});
