// Cancelling a waypoint drag (Escape, pointercancel, a second pointer) must
// put the connection back as it was, with no save and no undo entry, and a
// later unrelated edit must not carry the cancelled path along. The one
// exception is a drag whose preview an unrelated notify already handed to
// the parent: there the restored chart is sent too.
//
// Runs `useWaypointDrag` against the real `useGraphMutation`: the hooks
// meet at `mutateDebounced` / `discardBuffered`, and "cancel really
// reverts" is a property of the pair, not of either mock. The same setup
// covers a drop whose validity depends on what the drag has already
// written to local state.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import { useWaypointDrag } from '../../src/hooks/useWaypointDrag';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import { loggingService } from '../../src/services/loggingService';
import type { ToCData, WaypointOffset } from '../../src/types';

vi.mock('../../src/services/loggingService', () => ({
  loggingService: { reportError: vi.fn() },
}));

type Waypoints = WaypointOffset[];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

// Waypoints are stored relative to the midpoint of the connection's line, so
// the pointer position and the stored offset differ by this midpoint.
const LINE_MIDPOINT = { x: 0, y: 0 };

function setup(initial: ToCData, lineMidpoint = LINE_MIDPOINT) {
  const onDataChange = vi.fn();
  const rendered = renderHook(() => {
    const graph = useGraphMutation(initial, onDataChange);
    const drag = useWaypointDrag({
      data: graph.data,
      editMode: true,
      mutateDebounced: graph.mutateDebounced,
      commit: graph.commit,
      discardBuffered: graph.discardBuffered,
      notifyCount: graph.notifyCount,
      clientToContainer: (x, y) => ({ x, y }),
      getLineMidpoint: () => lineMidpoint,
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

async function settle(ms = 500) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('cancelling a waypoint drag', () => {
  it.each(cancels)('%s puts the waypoint back and saves nothing', async (_name, makeEvent) => {
    const original = [{ dx: 100, dy: 50 }];
    const { result, onDataChange } = setup(makeData(original));

    dragWaypointAway(result);
    expect(connectionOf(result.current.graph.data).waypoints).toEqual([{ dx: 180, dy: 90 }]);

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
    expect(connectionOf(result.current.graph.data).waypoints).toEqual([{ dx: 60, dy: 60 }]);

    act(() => {
      document.dispatchEvent(escape());
    });
    await settle();

    expect(connectionOf(result.current.graph.data)).toStrictEqual({
      targetId: 'target',
      confidence: 75,
    });
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('restores every waypoint of a legacy multi-waypoint connection', async () => {
    const original = [
      { dx: 60, dy: 100 },
      { dx: 140, dy: 100 },
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
    const original = [{ dx: 100, dy: 50 }];
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
    const { result, onDataChange } = setup(makeData([{ dx: 100, dy: 50 }]));

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

    expect(connectionOf(result.current.graph.data).waypoints).toEqual([{ dx: 180, dy: 90 }]);
    expect(onDataChange).toHaveBeenCalledTimes(1);
  });

  it('leaves the data untouched when the press never became a drag', async () => {
    const original = [{ dx: 100, dy: 50 }];
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
    const { result, onDataChange } = setup(makeData([{ dx: 100, dy: 50 }]));

    dragWaypointAway(result);
    act(() => {
      document.dispatchEvent(pointer('pointerup', 180, 90));
    });
    await settle();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(connectionOf(onDataChange.mock.calls[0][0]).waypoints).toEqual([{ dx: 180, dy: 90 }]);
  });
});

describe('a waypoint drag that is held still', () => {
  it('sends nothing until the pointer is released, then saves once', async () => {
    const { result, onDataChange } = setup(makeData([{ dx: 100, dy: 50 }]));

    dragWaypointAway(result);
    await settle();
    expect(onDataChange).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(pointer('pointerup', 180, 90));
    });
    await settle();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(connectionOf(onDataChange.mock.calls[0][0]).waypoints).toEqual([{ dx: 180, dy: 90 }]);
  });

  it.each(cancels)(
    '%s after the pause leaves the screen and the parent on the original path',
    async (_name, makeEvent) => {
      const original = [{ dx: 100, dy: 50 }];
      const initial = makeData(original);
      const { result, onDataChange } = setup(initial);

      dragWaypointAway(result);
      await settle();
      act(() => {
        document.dispatchEvent(makeEvent());
      });
      await settle();

      expect(connectionOf(result.current.graph.data).waypoints).toEqual(original);
      const parentChart: ToCData = onDataChange.mock.calls.at(-1)?.[0] ?? initial;
      expect(connectionOf(parentChart).waypoints).toEqual(original);
      expect(onDataChange).not.toHaveBeenCalled();
    },
  );
});

describe('cancelling after an unrelated edit carried the preview to the parent', () => {
  it.each(cancels)(
    '%s sends the parent the original path, keeping the edit',
    async (_n, makeEvent) => {
      const original = [{ dx: 100, dy: 50 }];
      const { result, onDataChange } = setup(makeData(original));

      dragWaypointAway(result);
      act(() => {
        result.current.graph.mutate((prev) => ({ ...prev, title: 'Renamed' }));
      });
      await settle(0);
      expect(onDataChange).toHaveBeenCalledTimes(1);
      expect(connectionOf(onDataChange.mock.calls[0][0]).waypoints).toEqual([{ dx: 180, dy: 90 }]);

      act(() => {
        document.dispatchEvent(makeEvent());
      });
      await settle();

      expect(onDataChange).toHaveBeenCalledTimes(2);
      const parentChart: ToCData = onDataChange.mock.calls[1][0];
      expect(parentChart.title).toBe('Renamed');
      expect(connectionOf(parentChart).waypoints).toEqual(original);
      expect(connectionOf(result.current.graph.data).waypoints).toEqual(original);
    },
  );

  it('sends nothing when the unrelated edit went out before the drag moved', async () => {
    const original = [{ dx: 100, dy: 50 }];
    const { result, onDataChange } = setup(makeData(original));

    act(() => {
      result.current.drag.bindWaypoint('source', 'target', 0).onPointerDown(pointerDown(100, 50));
    });
    act(() => {
      result.current.graph.mutate((prev) => ({ ...prev, title: 'Renamed' }));
    });
    await settle();
    expect(onDataChange).toHaveBeenCalledTimes(1);

    act(() => {
      document.dispatchEvent(pointer('pointermove', 180, 90));
    });
    act(() => {
      document.dispatchEvent(escape());
    });
    await settle();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(connectionOf(result.current.graph.data).waypoints).toEqual(original);
  });
});

describe('a replacement chart arriving in the middle of a waypoint drag', () => {
  // A remote snapshot or an AI edit overwrites the preview the drag made.
  const remoteChart = () => ({ ...makeData([{ dx: 100, dy: 50 }]), title: 'Remote' });

  it('does not stop the drop from saving, on top of the replacement', async () => {
    const { result, onDataChange } = setup(makeData([{ dx: 100, dy: 50 }]));

    dragWaypointAway(result);
    act(() => {
      result.current.graph.setData(remoteChart());
    });
    act(() => {
      document.dispatchEvent(pointer('pointerup', 180, 90));
    });
    await settle();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    const saved: ToCData = onDataChange.mock.calls[0][0];
    expect(saved.title).toBe('Remote');
    expect(connectionOf(saved).waypoints).toEqual([{ dx: 180, dy: 90 }]);
  });

  it('leaves a cancel with nothing to send', async () => {
    const { result, onDataChange } = setup(makeData([{ dx: 100, dy: 50 }]));

    dragWaypointAway(result);
    act(() => {
      result.current.graph.setData(remoteChart());
    });
    act(() => {
      document.dispatchEvent(escape());
    });
    await settle();

    expect(onDataChange).not.toHaveBeenCalled();
    expect(result.current.graph.data.title).toBe('Remote');
    expect(connectionOf(result.current.graph.data).waypoints).toEqual([{ dx: 100, dy: 50 }]);
  });
});

describe('dragging a later waypoint of a legacy multi-waypoint connection', () => {
  it('commits the dragged position once and reports no stale drop', async () => {
    // The first move collapses the array to the dragged waypoint, so the
    // press-time index no longer exists in the live data at release.
    const { result, onDataChange } = setup(
      makeData([
        { dx: 60, dy: 100 },
        { dx: 140, dy: 100 },
      ]),
    );

    act(() => {
      result.current.drag.bindWaypoint('source', 'target', 1).onPointerDown(pointerDown(140, 100));
    });
    act(() => {
      document.dispatchEvent(pointer('pointermove', 220, 140));
    });
    act(() => {
      document.dispatchEvent(pointer('pointerup', 220, 140));
    });
    await settle();

    expect(loggingService.reportError).not.toHaveBeenCalled();
    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(connectionOf(onDataChange.mock.calls[0][0]).waypoints).toEqual([{ dx: 220, dy: 140 }]);
  });
});

describe('a waypoint drag on a line whose midpoint is not the container origin', () => {
  const midpoint = { x: 300, y: 200 };

  it.each(cancels)(
    '%s restores the offsets the connection had before the press',
    async (_n, makeEvent) => {
      const original = [{ dx: 100, dy: 50 }];
      const { result, onDataChange } = setup(makeData(original), midpoint);

      dragWaypointAway(result, { x: 400, y: 250 });
      // The pointer is at (480, 290): 180 right of and 90 below the midpoint.
      expect(connectionOf(result.current.graph.data).waypoints).toEqual([{ dx: 180, dy: 90 }]);

      act(() => {
        document.dispatchEvent(makeEvent());
      });
      await settle();

      expect(connectionOf(result.current.graph.data).waypoints).toEqual(original);
      expect(onDataChange).not.toHaveBeenCalled();
    },
  );

  it('saves the pointer position as an offset from the midpoint on release', async () => {
    const { result, onDataChange } = setup(makeData([{ dx: 100, dy: 50 }]), midpoint);

    dragWaypointAway(result, { x: 400, y: 250 });
    act(() => {
      document.dispatchEvent(pointer('pointerup', 480, 290));
    });
    await settle();

    expect(onDataChange).toHaveBeenCalledTimes(1);
    expect(connectionOf(onDataChange.mock.calls[0][0]).waypoints).toEqual([{ dx: 180, dy: 90 }]);
  });
});
