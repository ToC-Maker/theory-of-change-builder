// Cancelling a waypoint drag (Escape, pointercancel, a second pointer) must
// put the connection back as it was, with no save and no undo entry, and a
// later unrelated edit must not carry the cancelled path along.
//
// Runs `useWaypointDrag` against the real `useGraphMutation`: the hooks
// meet at `mutateDebounced` / `discardBuffered`, and "cancel really
// reverts" is a property of the pair, not of either mock.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import { useWaypointDrag } from '../../src/hooks/useWaypointDrag';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import type { ToCData } from '../../src/types';

vi.mock('../../src/services/loggingService', () => ({
  loggingService: { reportError: vi.fn() },
}));

type Waypoints = Array<{ x: number; y: number }>;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  vi.useRealTimers();
});

function makeData(waypoints?: Waypoints): ToCData {
  return {
    title: 'Chart',
    sections: [
      {
        title: 'A',
        columns: [
          {
            nodes: [
              {
                id: 'source',
                title: 'src',
                text: '',
                connectionIds: [],
                connections: [
                  { targetId: 'target', confidence: 75, ...(waypoints ? { waypoints } : {}) },
                ],
                yPosition: 0,
              },
              {
                id: 'target',
                title: 'tgt',
                text: '',
                connectionIds: [],
                connections: [],
                yPosition: 0,
              },
            ],
          },
        ],
      },
    ],
  };
}

const connectionOf = (data: ToCData) => data.sections[0].columns[0].nodes[0].connections![0];

function setup(initial: ToCData) {
  const onDataChange = vi.fn();
  const rendered = renderHook(() => {
    const graph = useGraphMutation(initial, onDataChange);
    const drag = useWaypointDrag({
      data: graph.data,
      editMode: true,
      mutateDebounced: graph.mutateDebounced,
      commit: graph.commit,
      discardBuffered: graph.discardBuffered,
      clientToContainer: (x, y) => ({ x, y }),
    });
    return { graph, drag };
  });
  return { ...rendered, onDataChange };
}

function pointerDown(x: number, y: number, pointerId = 1): React.PointerEvent {
  const el = document.createElement('div');
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.hasPointerCapture = vi.fn().mockReturnValue(true);
  return {
    clientX: x,
    clientY: y,
    pointerId,
    pointerType: 'mouse',
    button: 0,
    target: el,
    currentTarget: el,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.PointerEvent;
}

function pointer(type: string, x: number, y: number, pointerId = 1): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: pointerId },
  });
  return event;
}

const escape = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });

const cancels: Array<[string, () => Event]> = [
  ['Escape', escape],
  ['pointercancel', () => pointer('pointercancel', 0, 0)],
  ['a second pointer', () => pointer('pointerdown', 0, 0, 2)],
];

/** Press on the waypoint of `source->target` and drag it past the threshold. */
function dragWaypointAway(result: ReturnType<typeof setup>['result'], from = { x: 100, y: 50 }) {
  act(() => {
    result.current.drag
      .bindWaypoint('source', 'target', 0)
      .onPointerDown(pointerDown(from.x, from.y));
  });
  act(() => {
    document.dispatchEvent(pointer('pointermove', from.x + 80, from.y + 40));
  });
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
}

describe('cancelling a waypoint drag', () => {
  it.each(cancels)('%s puts the waypoint back and saves nothing', async (_name, makeEvent) => {
    const original = [{ x: 100, y: 50 }];
    const { result, onDataChange } = setup(makeData(original));

    dragWaypointAway(result);
    expect(connectionOf(result.current.graph.data).waypoints).toEqual([{ x: 180, y: 90 }]);

    act(() => {
      document.dispatchEvent(makeEvent());
    });
    await settle();

    expect(connectionOf(result.current.graph.data).waypoints).toEqual(original);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('removes a waypoint the drag created, leaving the connection as it was', async () => {
    const { result, onDataChange } = setup(makeData());

    act(() => {
      result.current.drag.bindMidpoint('source', 'target', 0).onPointerDown(pointerDown(0, 0));
    });
    act(() => {
      document.dispatchEvent(pointer('pointermove', 60, 60));
    });
    expect(connectionOf(result.current.graph.data).waypoints).toEqual([{ x: 60, y: 60 }]);

    act(() => {
      document.dispatchEvent(escape());
    });
    await settle();

    expect(connectionOf(result.current.graph.data)).toEqual({ targetId: 'target', confidence: 75 });
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('restores every waypoint of a legacy multi-waypoint connection', async () => {
    const original = [
      { x: 60, y: 100 },
      { x: 140, y: 100 },
    ];
    const { result, onDataChange } = setup(makeData(original));

    dragWaypointAway(result, { x: 140, y: 100 });
    expect(connectionOf(result.current.graph.data).waypoints).toHaveLength(1);

    act(() => {
      document.dispatchEvent(escape());
    });
    await settle();

    expect(connectionOf(result.current.graph.data).waypoints).toEqual(original);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('does not carry the cancelled path into the next unrelated edit', async () => {
    const original = [{ x: 100, y: 50 }];
    const { result, onDataChange } = setup(makeData(original));

    dragWaypointAway(result);
    act(() => {
      document.dispatchEvent(escape());
    });
    act(() => {
      result.current.graph.mutate((prev) => ({ ...prev, title: 'Renamed' }));
    });
    await settle();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    const saved: ToCData = onDataChange.mock.calls[0][0];
    expect(saved.title).toBe('Renamed');
    expect(connectionOf(saved).waypoints).toEqual(original);
  });

  it('restores the committed position after an earlier committed drag was echoed back', async () => {
    // The parent hands the hook's own notified state back as new data; the
    // restore must still land when the state to return to is one the hook
    // notified earlier.
    const { result, onDataChange } = setup(makeData([{ x: 100, y: 50 }]));

    dragWaypointAway(result);
    act(() => {
      document.dispatchEvent(pointer('pointerup', 180, 90));
    });
    await settle();
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const committed: ToCData = onDataChange.mock.calls[0][0];
    act(() => {
      result.current.graph.setData(committed);
    });

    dragWaypointAway(result, { x: 180, y: 90 });
    act(() => {
      document.dispatchEvent(escape());
    });
    await settle();

    expect(connectionOf(result.current.graph.data).waypoints).toEqual([{ x: 180, y: 90 }]);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('leaves the data untouched when the press never became a drag', async () => {
    const original = [{ x: 100, y: 50 }];
    const initial = makeData(original);
    const { result, onDataChange } = setup(initial);

    act(() => {
      result.current.drag.bindWaypoint('source', 'target', 0).onPointerDown(pointerDown(100, 50));
    });
    act(() => {
      document.dispatchEvent(escape());
    });
    await settle();

    expect(result.current.graph.data).toBe(initial);
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('a completed drag still saves once, as before', async () => {
    const { result, onDataChange } = setup(makeData([{ x: 100, y: 50 }]));

    dragWaypointAway(result);
    act(() => {
      document.dispatchEvent(pointer('pointerup', 180, 90));
    });
    await settle();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(connectionOf(onDataChange.mock.calls[0][0]).waypoints).toEqual([{ x: 180, y: 90 }]);
  });
});
