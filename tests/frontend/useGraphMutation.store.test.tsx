// `useGraphMutation` over the chart store: previews go to the store, commits are
// the store's commits, and a remote chart landing in the middle of a gesture
// merges into the same object the gesture is previewing into.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useGraphMutation } from '../../src/hooks/useGraphMutation';
import { useWaypointDrag } from '../../src/hooks/useWaypointDrag';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import type { ToCData } from '../../src/types';
import {
  columnsOf,
  connectedChart,
  edit,
  findNode,
  moveNode,
  nodeIn,
} from '../shared/chart-fixtures';
import { makeDoc, type TestDoc } from './helpers/renderToC';

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve));

const retitle = (id: string, title: string) => (chart: ToCData) =>
  edit(chart, (draft) => {
    nodeIn(draft, id).title = title;
  });

const titleOf = (chart: ToCData, id: string) => findNode(chart, id)?.title;

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  vi.useRealTimers();
});

describe('useGraphMutation over a store', () => {
  it('mutate_previews_then_commits_once_per_task', async () => {
    const { doc, onCommit } = makeDoc(connectedChart());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutate(retitle('a', 'One'));
      result.current.mutate(retitle('b', 'Two'));
    });

    expect(titleOf(result.current.data, 'b')).toBe('Two');
    expect(onCommit).not.toHaveBeenCalled();

    await flushMicrotasks();

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(titleOf(onCommit.mock.calls[0][0], 'a')).toBe('One');
    expect(titleOf(onCommit.mock.calls[0][0], 'b')).toBe('Two');
  });

  it('mutateDebounced_commits_after_200ms_idle', async () => {
    vi.useFakeTimers();
    const { doc, onCommit } = makeDoc(connectedChart());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced(retitle('a', 'Typed'), 'title-a');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(onCommit).not.toHaveBeenCalled();
    expect(titleOf(doc.getLive(), 'a')).toBe('Typed');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(titleOf(doc.getCommitted(), 'a')).toBe('Typed');
  });

  it('idleCommit_false_commits_only_on_commit_key', async () => {
    vi.useFakeTimers();
    const { doc, onCommit } = makeDoc(connectedChart());
    const { result } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced(retitle('a', 'Held'), 'drag-a', { idleCommit: false });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      result.current.commit('drag-a');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(titleOf(doc.getCommitted(), 'a')).toBe('Held');
  });

  it('unmount_commits_buffered_keys_synchronously', () => {
    const { doc } = makeDoc(connectedChart());
    const { result, unmount } = renderHook(() => useGraphMutation(doc));

    act(() => {
      result.current.mutateDebounced(retitle('a', 'Typed'), 'title-a');
    });
    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');

    unmount();

    expect(titleOf(doc.getCommitted(), 'a')).toBe('Typed');
    expect(doc.getCommitCount()).toBe(1);
  });

  it('a_replaced_chart_is_not_overwritten_by_the_idle_commit_of_an_earlier_preview', async () => {
    vi.useFakeTimers();
    const { doc, onCommit } = makeDoc(connectedChart());
    const { result } = renderHook(() => useGraphMutation(doc));
    const replacement = edit(connectedChart(), (draft) => {
      nodeIn(draft, 'd').title = 'Imported';
    });

    act(() => {
      result.current.mutateDebounced(retitle('a', 'Typed'), 'title-a');
    });
    act(() => {
      doc.replace(replacement);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // The replacement is the only commit, and it is what the document holds.
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(titleOf(doc.getCommitted(), 'a')).toBe('A');
    expect(titleOf(doc.getCommitted(), 'd')).toBe('Imported');
  });

  it('notifyCount_tracks_store_commit_count', () => {
    const { doc } = makeDoc(connectedChart());
    const { result } = renderHook(() => useGraphMutation(doc));
    expect(result.current.notifyCount()).toBe(0);

    act(() => {
      doc.edit(retitle('a', 'From elsewhere'));
    });

    expect(result.current.notifyCount()).toBe(1);
  });
});

// The three bend-drag cases run `useWaypointDrag` on the real hook and store: the
// hooks meet at `mutateDebounced`, `discardBuffered` and the commit count, and a
// landing's effect on a gesture is a property of that pairing.
describe('a bend drag while a remote chart lands', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  const bentChart = () =>
    edit(connectedChart(), (draft) => {
      nodeIn(draft, 'a').connections![0].waypoints = [{ dx: 100, dy: 50 }];
    });

  const waypointsOf = (chart: ToCData) => findNode(chart, 'a')?.connections?.[0].waypoints;

  function setup(
    getLineMidpoint: (testDoc: TestDoc) => { x: number; y: number } = () => ({ x: 0, y: 0 }),
  ) {
    const testDoc = makeDoc(bentChart());
    const rendered = renderHook(() => {
      const graph = useGraphMutation(testDoc.doc);
      const drag = useWaypointDrag({
        data: graph.data,
        editMode: true,
        mutateDebounced: graph.mutateDebounced,
        commit: graph.commit,
        discardBuffered: graph.discardBuffered,
        notifyCount: graph.notifyCount,
        getCommitted: testDoc.doc.getCommitted,
        clientToContainer: (x, y) => ({ x, y }),
        getLineMidpoint: () => getLineMidpoint(testDoc),
      });
      return { graph, drag };
    });
    return { ...rendered, ...testDoc };
  }

  const pointerDown = (x: number, y: number) => {
    const el = document.createElement('div');
    return {
      clientX: x,
      clientY: y,
      pointerId: 1,
      button: 0,
      target: el,
      currentTarget: el,
      stopPropagation: vi.fn(),
    } as unknown as React.PointerEvent;
  };

  const pointer = (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: x },
      clientY: { value: y },
      pointerId: { value: 1 },
    });
    return event;
  };

  const press = (result: ReturnType<typeof setup>['result'], x: number, y: number) =>
    act(() => {
      result.current.drag.bindWaypoint('a', 'c', 0).onPointerDown(pointerDown(x, y));
    });
  const move = (x: number, y: number) =>
    act(() => void document.dispatchEvent(pointer('pointermove', x, y)));

  it('waypoint_cancel_restores_committed_waypoints', async () => {
    const { result, doc, onCommit, land } = setup();

    press(result, 100, 50);
    move(180, 90);
    expect(waypointsOf(result.current.graph.data)).toEqual([{ dx: 180, dy: 90 }]);

    act(() =>
      land((draft) => {
        nodeIn(draft, 'a').connections![0].waypoints = [{ dx: 7, dy: 8 }];
      }),
    );
    // The drag's preview wins on the bend while it lasts.
    expect(waypointsOf(result.current.graph.data)).toEqual([{ dx: 180, dy: 90 }]);

    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(waypointsOf(result.current.graph.data)).toEqual([{ dx: 7, dy: 8 }]);
    expect(waypointsOf(doc.getCommitted())).toEqual([{ dx: 7, dy: 8 }]);
    expect(onCommit).not.toHaveBeenCalled();
    expect(doc.getStatus().unsaved).toBe(false);
  });

  it('bend_drag_preview_survives_landing', async () => {
    const { result, doc, onCommit, land } = setup();

    press(result, 100, 50);
    move(180, 90);
    act(() =>
      land((draft) => {
        nodeIn(draft, 'b').title = 'Remote B';
      }),
    );
    expect(titleOf(result.current.graph.data, 'b')).toBe('Remote B');

    move(200, 100);
    expect(waypointsOf(result.current.graph.data)).toEqual([{ dx: 200, dy: 100 }]);
    expect(titleOf(result.current.graph.data, 'b')).toBe('Remote B');

    act(() => void document.dispatchEvent(pointer('pointerup', 200, 100)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(waypointsOf(doc.getCommitted())).toEqual([{ dx: 200, dy: 100 }]);
    expect(titleOf(doc.getCommitted(), 'b')).toBe('Remote B');
  });

  it('bend_drag_rereads_midpoint_after_landing', () => {
    // The line's midpoint depends on where `c` sits: far right in its own
    // column, at the origin once a landing moves it next to `a`.
    const midpointOf = ({ doc }: TestDoc) => {
      const columnOfC = columnsOf(doc.getLive()).find((column) =>
        column.nodes.some((n) => n.id === 'c'),
      );
      return columnOfC?.id === 'c1' ? { x: 0, y: 0 } : { x: 300, y: 200 };
    };
    const { result, land } = setup(midpointOf);

    press(result, 400, 250);
    move(410, 260);
    expect(waypointsOf(result.current.graph.data)).toEqual([{ dx: 110, dy: 60 }]);

    act(() => land((draft) => moveNode(draft, 'c', 'c1', 100)));
    move(500, 300);

    expect(waypointsOf(result.current.graph.data)).toEqual([{ dx: 500, dy: 300 }]);
  });
});
