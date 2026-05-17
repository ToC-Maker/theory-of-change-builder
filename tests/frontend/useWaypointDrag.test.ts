// PR 7 Task 7.2 tests for `useWaypointDrag`.
//
// The hook owns the gesture lifecycle for two kinds of drag:
//
//   - `bindWaypoint(connectionId, waypointIndex)` — drag an existing
//     waypoint. On pointermove: update the waypoint position. On
//     pointerup: if the final position is within `MERGE_RADIUS_PX` of a
//     neighbor waypoint, remove this waypoint (or the neighbor — see
//     impl note in `src/hooks/useWaypointDrag.ts`). Otherwise commit
//     the new position.
//   - `bindMidpoint(connectionId, segmentIndex)` — drag a midpoint to
//     create a NEW waypoint. On pointerdown: insert a waypoint at the
//     midpoint's position. On pointermove: update it like a regular
//     waypoint. On pointerup: commit (or undo the insert if merged
//     into a neighbor — defensive).
//
// Mutation contract:
//   - Live updates flow through `mutateDebounced` (no parent notify
//     during the drag — same pattern as slider drags).
//   - `commit` on pointerup fires exactly one parent notify, yielding
//     one undo entry per gesture.
//   - Escape / pointercancel: NO commit. Live state has already been
//     touched via `mutateDebounced`, but the caller is expected to
//     revert that via the `onCancel` callback (the hook surfaces the
//     cancel signal so callers can clear the buffer).
//
// Mutual exclusion: pointerdown checks `isCanvasGestureActive` and
// short-circuits if true (red-team Important, plan/figma-redesign.md:203).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// Mock loggingService so stale-waypoint-drop reports can be asserted.
vi.mock('../../src/services/loggingService', () => {
  return {
    loggingService: {
      reportError: vi.fn(),
    },
  };
});

import { useWaypointDrag } from '../../src/hooks/useWaypointDrag';
import {
  isCanvasGestureActive,
  setCanvasGestureActive,
  _resetCanvasGestureStateForTest,
} from '../../src/hooks/_canvasGestureState';
import { loggingService } from '../../src/services/loggingService';
import type { ToCData } from '../../src/types';

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sourceId = 'source';
const targetId = 'target';

function makeData(waypoints?: Array<{ x: number; y: number }>): ToCData {
  return {
    sections: [
      {
        title: 'A',
        columns: [
          {
            nodes: [
              {
                id: sourceId,
                title: 'src',
                text: '',
                connectionIds: [],
                connections: [
                  {
                    targetId,
                    confidence: 75,
                    ...(waypoints !== undefined ? { waypoints } : {}),
                  },
                ],
                yPosition: 0,
              },
              {
                id: targetId,
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

function makePointerDownEvent(init: {
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  button?: number;
}): React.PointerEvent {
  const el = document.createElement('div');
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.hasPointerCapture = vi.fn().mockReturnValue(true);
  return {
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    pointerId: init.pointerId ?? 1,
    pointerType: 'mouse',
    button: init.button ?? 0,
    target: el,
    currentTarget: el,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.PointerEvent;
}

function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number },
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    clientX: { value: init.clientX ?? 0 },
    clientY: { value: init.clientY ?? 0 },
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: 'mouse' },
  });
  return event;
}

interface HookContext {
  mutateDebounced: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  discardBuffered: ReturnType<typeof vi.fn>;
  clientToContainer: ReturnType<typeof vi.fn>;
  data: ToCData;
  rerender: (props: { data: ToCData }) => void;
}

function setupHook(args: {
  data: ToCData;
  editMode?: boolean;
  // Maps client coords to container-local coords. Default: identity.
  translate?: (cx: number, cy: number) => { x: number; y: number };
}): {
  ctx: HookContext;
  result: ReturnType<typeof renderHook>['result'];
} {
  const mutateDebounced = vi.fn();
  const commit = vi.fn();
  const discardBuffered = vi.fn();
  const clientToContainer = vi.fn(
    args.translate ?? ((cx: number, cy: number) => ({ x: cx, y: cy })),
  );

  // The hook reads the latest data via a ref-mirrored `dataRef`.
  // Provide a function so callers can mutate the data they pass in.
  const dataRef = { current: args.data };
  const { result, rerender } = renderHook(
    ({ data }: { data: ToCData }) =>
      useWaypointDrag({
        data,
        editMode: args.editMode ?? true,
        mutateDebounced,
        commit,
        discardBuffered,
        clientToContainer,
      }),
    { initialProps: { data: args.data } },
  );
  const ctx: HookContext = {
    mutateDebounced,
    commit,
    discardBuffered,
    clientToContainer,
    data: args.data,
    rerender: (props) => {
      dataRef.current = props.data;
      rerender(props);
    },
  };
  Object.defineProperty(ctx, 'data', {
    get: () => dataRef.current,
    set: (next) => {
      dataRef.current = next;
    },
  });
  return { ctx, result };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWaypointDrag', () => {
  describe('bindMidpoint — insert new waypoint', () => {
    it('inserts a waypoint at the drop position when no neighbor merge', () => {
      const data = makeData([]); // no existing waypoints
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindMidpoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 50, clientY: 100 }));
      });

      // Move and release at (150, 200).
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 200 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 150, clientY: 200 }));
      });

      // The hook should have called `mutateDebounced` during the drag
      // and `commit` once at the end.
      expect(ctx.mutateDebounced).toHaveBeenCalled();
      expect(ctx.commit).toHaveBeenCalledTimes(1);

      // Apply the final updater to verify the inserted waypoint lands
      // at the drop position.
      const updater = ctx.mutateDebounced.mock.calls.at(-1)![0];
      const next = typeof updater === 'function' ? updater(data) : updater;
      const connection = next.sections[0].columns[0].nodes[0].connections![0];
      expect(connection.waypoints).toEqual([{ x: 150, y: 200 }]);
    });

    it('inserts at the correct segmentIndex (between existing waypoints)', () => {
      // Existing waypoint at (100, 50). Inserting at segmentIndex 1
      // means "between waypoint[0] and target" — should land at
      // waypoints[1] after insert.
      const data = makeData([{ x: 100, y: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindMidpoint(sourceId, targetId, 1)
          .onPointerDown(makePointerDownEvent({ clientX: 0, clientY: 0 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 175, clientY: 75 }));
      });

      const updater = ctx.mutateDebounced.mock.calls.at(-1)![0];
      const next = typeof updater === 'function' ? updater(data) : updater;
      const connection = next.sections[0].columns[0].nodes[0].connections![0];
      expect(connection.waypoints).toEqual([
        { x: 100, y: 50 },
        { x: 175, y: 75 },
      ]);
    });
  });

  describe('bindWaypoint — move existing waypoint', () => {
    it('updates the waypoint position on pointerup (no merge)', () => {
      const data = makeData([{ x: 100, y: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 80 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 160, clientY: 80 }));
      });

      const updater = ctx.mutateDebounced.mock.calls.at(-1)![0];
      const next = typeof updater === 'function' ? updater(data) : updater;
      const connection = next.sections[0].columns[0].nodes[0].connections![0];
      expect(connection.waypoints).toEqual([{ x: 160, y: 80 }]);
      expect(ctx.commit).toHaveBeenCalledTimes(1);
    });
  });

  describe('bindWaypoint — merge with neighbor (remove waypoint)', () => {
    it('removes the dragged waypoint when its final pos is within 16px of a neighbor waypoint', () => {
      const data = makeData([
        { x: 60, y: 100 },
        { x: 140, y: 100 },
      ]);
      const { ctx, result } = setupHook({ data });

      // Drag waypoint[0] (at 60,100) to (130,100) — within 16px of
      // waypoint[1] (at 140,100).
      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 60, clientY: 100 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 130, clientY: 100 }));
      });

      const updater = ctx.mutateDebounced.mock.calls.at(-1)![0];
      const next = typeof updater === 'function' ? updater(data) : updater;
      const connection = next.sections[0].columns[0].nodes[0].connections![0];
      expect(connection.waypoints).toEqual([{ x: 140, y: 100 }]);
      expect(ctx.commit).toHaveBeenCalledTimes(1);
    });

    it('does not merge when the final pos is just outside the 16px threshold', () => {
      const data = makeData([
        { x: 60, y: 100 },
        { x: 140, y: 100 },
      ]);
      const { ctx, result } = setupHook({ data });

      // Drag waypoint[0] to (120, 100) — distance 20 to waypoint[1].
      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 60, clientY: 100 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 120, clientY: 100 }));
      });

      const updater = ctx.mutateDebounced.mock.calls.at(-1)![0];
      const next = typeof updater === 'function' ? updater(data) : updater;
      const connection = next.sections[0].columns[0].nodes[0].connections![0];
      expect(connection.waypoints).toEqual([
        { x: 120, y: 100 },
        { x: 140, y: 100 },
      ]);
    });
  });

  describe('mutual exclusion', () => {
    it('short-circuits pointerdown when isCanvasGestureActive=true', () => {
      const data = makeData([{ x: 100, y: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => setCanvasGestureActive(true));

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });

      expect(ctx.mutateDebounced).not.toHaveBeenCalled();
      expect(ctx.commit).not.toHaveBeenCalled();
      expect(result.current.isActive).toBe(false);
    });

    it('sets isCanvasGestureActive=true during the drag and clears it on release', () => {
      const data = makeData([{ x: 100, y: 50 }]);
      const { result } = setupHook({ data });

      expect(isCanvasGestureActive()).toBe(false);

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });

      expect(isCanvasGestureActive()).toBe(true);
      expect(result.current.isActive).toBe(true);

      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 50 }));
      });

      expect(isCanvasGestureActive()).toBe(false);
      expect(result.current.isActive).toBe(false);
    });
  });

  describe('escape cancel', () => {
    it('clears state on Escape, no commit, no parent notify', () => {
      const data = makeData([{ x: 100, y: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });

      // A pointermove so live preview happens.
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 50 }));
      });

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      expect(ctx.commit).not.toHaveBeenCalled();
      expect(isCanvasGestureActive()).toBe(false);
      expect(result.current.isActive).toBe(false);
    });

    it('discards the buffered updater on Escape so no auto-commit fires 200ms later', () => {
      // `mutateDebounced`'s 200ms idle timer would otherwise auto-commit
      // the in-flight drag position as if the user had released — making
      // Escape a 200ms-delayed commit rather than a true cancel. The
      // hook now calls `discardBuffered(key)` on cancel paths.
      const data = makeData([{ x: 100, y: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 50 }));
      });
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      const expectedKey = `waypoints-${sourceId}->${targetId}`;
      expect(ctx.discardBuffered).toHaveBeenCalledWith(expectedKey);
      expect(ctx.commit).not.toHaveBeenCalled();
    });

    it('discards the buffered updater on pointercancel', () => {
      const data = makeData([{ x: 100, y: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 50 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointercancel', { clientX: 200, clientY: 50 }));
      });

      const expectedKey = `waypoints-${sourceId}->${targetId}`;
      expect(ctx.discardBuffered).toHaveBeenCalledWith(expectedKey);
      expect(ctx.commit).not.toHaveBeenCalled();
      expect(result.current.isActive).toBe(false);
    });

    it('discards the buffered updater when a second pointer interrupts the gesture', () => {
      const data = makeData([{ x: 100, y: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50, pointerId: 1 }));
      });
      // Second pointer with a different pointerId → cancel.
      act(() => {
        document.dispatchEvent(
          pointerEvent('pointerdown', { clientX: 0, clientY: 0, pointerId: 2 }),
        );
      });

      const expectedKey = `waypoints-${sourceId}->${targetId}`;
      expect(ctx.discardBuffered).toHaveBeenCalledWith(expectedKey);
      expect(ctx.commit).not.toHaveBeenCalled();
      expect(result.current.isActive).toBe(false);
    });
  });

  describe('stale-edge race observability', () => {
    it('reports stale-waypoint-drop and survives a mid-gesture rerender where the connection has been deleted', () => {
      // Cross-tab / AI-streaming-edit class of race: the user starts a
      // waypoint move; before pointerup, an external update wipes the
      // connection from `data`. The replay updater MUST defend against
      // this (no throw, no corrupt write) and the drop site is the only
      // place where the stale-drop log should fire (pointermove-internal
      // logging would flood per-tick during the race).
      const data = makeData([{ x: 100, y: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 80 }));
      });

      // Mid-drag: rerender with a `data` that no longer has the
      // connection. The hook's dataRef should pick up the new shape.
      const emptyData = makeData([]);
      const dataNoConnection: ToCData = {
        ...emptyData,
        sections: emptyData.sections.map((section) => ({
          ...section,
          columns: section.columns.map((column) => ({
            ...column,
            nodes: column.nodes.map((node) =>
              node.id === sourceId ? { ...node, connections: [] } : node,
            ),
          })),
        })),
      };
      act(() => {
        ctx.rerender({ data: dataNoConnection });
      });

      // Pointerup: the replay updater walks data and finds no
      // connection — defensive return-unchanged path triggers; the
      // hook fires one `stale-waypoint-drop` log at the drop site.
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 160, clientY: 80 }));
      });

      expect(loggingService.reportError).toHaveBeenCalledTimes(1);
      expect((loggingService.reportError as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(
        expect.objectContaining({ error_name: 'stale-waypoint-drop' }),
      );
      // The replay updater itself no-ops gracefully (no throw).
      const lastUpdater = ctx.mutateDebounced.mock.calls.at(-1)![0];
      expect(typeof lastUpdater).toBe('function');
      const next = (lastUpdater as (p: ToCData) => ToCData)(dataNoConnection);
      // Original data should be returned unchanged (defensive guard at
      // `updateConnectionWaypoints` finds no matching connection).
      expect(next).toBe(dataNoConnection);
    });

    it('does not report stale-waypoint-drop on a successful drop', () => {
      const data = makeData([{ x: 100, y: 50 }]);
      const { result } = setupHook({ data });

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 160, clientY: 80 }));
      });

      expect(loggingService.reportError).not.toHaveBeenCalled();
    });
  });

  describe('editMode guard', () => {
    it('does not start drag when editMode=false', () => {
      const data = makeData([{ x: 100, y: 50 }]);
      const { ctx, result } = setupHook({ data, editMode: false });

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });

      expect(ctx.mutateDebounced).not.toHaveBeenCalled();
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('clientToContainer coordinate translation', () => {
    it('writes the translated (not raw client) coords to the waypoint', () => {
      const data = makeData([]);
      const { ctx, result } = setupHook({
        data,
        // Simulate camera with zoom=2 and offset=(50, 100): inverse is
        // (cx-50)/2, (cy-100)/2.
        translate: (cx, cy) => ({ x: (cx - 50) / 2, y: (cy - 100) / 2 }),
      });

      act(() => {
        result.current
          .bindMidpoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 0, clientY: 0 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 250, clientY: 300 }));
      });

      const updater = ctx.mutateDebounced.mock.calls.at(-1)![0];
      const next = typeof updater === 'function' ? updater(data) : updater;
      const connection = next.sections[0].columns[0].nodes[0].connections![0];
      // (250-50)/2, (300-100)/2 -> (100, 100).
      expect(connection.waypoints).toEqual([{ x: 100, y: 100 }]);
    });
  });
});
