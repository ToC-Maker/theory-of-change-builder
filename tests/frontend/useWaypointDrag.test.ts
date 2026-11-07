// Tests for `useWaypointDrag` — single-waypoint model (PR #34 feedback 53).
//
// The hook owns the gesture lifecycle for waypoint editing. PR #34
// feedback (53) reduced the model from N editable waypoints to ONE:
//
//   - `bindMidpoint(sourceId, targetId, segmentIndex)` — drag the
//     at-rest midpoint affordance to CREATE the connection's single
//     waypoint. Nothing is written until the pointer travels beyond
//     the drag threshold (a plain click must not create a waypoint).
//   - `bindWaypoint(sourceId, targetId, waypointIndex)` — drag the
//     existing waypoint. Every write REPLACES the whole waypoints
//     array with the dragged waypoint's offset: a connection carrying
//     several waypoints collapses to the dragged one on its first edit.
//   - `bindWaypoint(...).onDoubleClick` — remove the waypoint(s)
//     entirely (reset to the automatic curve). One commit, one undo
//     entry.
//
// Mutation contract:
//   - Live updates flow through `mutateDebounced` (no parent notify
//     during the drag — same pattern as slider drags).
//   - `commit` on pointerup fires exactly one parent notify, yielding
//     one undo entry per gesture.
//   - A sub-threshold gesture (press + release without real movement)
//     writes NOTHING: no mutateDebounced, no commit, no phantom
//     waypoint in local state.
//   - Escape / pointercancel: NO commit; buffered updater discarded.
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
import type { ToCData, WaypointOffset } from '../../src/types';
import { deepFreeze } from './helpers/deepFreeze';

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

function makeData(waypoints?: WaypointOffset[]): ToCData {
  return deepFreeze({
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
  });
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

function makeDoubleClickEvent(): React.MouseEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent;
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
  getLineMidpoint: ReturnType<typeof vi.fn>;
  data: ToCData;
  rerender: (props: { data: ToCData }) => void;
}

function setupHook(args: {
  data: ToCData;
  editMode?: boolean;
  // Maps client coords to container-local coords. Default: identity.
  translate?: (cx: number, cy: number) => { x: number; y: number };
  // Midpoint of the source -> target line, the origin of stored offsets.
  // Default: the container origin, so offsets equal container coords.
  lineMidpoint?: { x: number; y: number };
}): {
  ctx: HookContext;
  result: ReturnType<typeof renderHook>['result'];
  unmount: () => void;
} {
  const mutateDebounced = vi.fn();
  const commit = vi.fn();
  const discardBuffered = vi.fn();
  const notifyCount = vi.fn(() => 0);
  const clientToContainer = vi.fn(
    args.translate ?? ((cx: number, cy: number) => ({ x: cx, y: cy })),
  );
  const lineMidpoint = args.lineMidpoint ?? { x: 0, y: 0 };
  const getLineMidpoint = vi.fn(() => lineMidpoint);

  // The hook reads the latest data via a ref-mirrored `dataRef`.
  // Provide a function so callers can mutate the data they pass in.
  const dataRef = { current: args.data };
  const { result, rerender, unmount } = renderHook(
    ({ data }: { data: ToCData }) =>
      useWaypointDrag({
        data,
        editMode: args.editMode ?? true,
        mutateDebounced,
        commit,
        discardBuffered,
        notifyCount,
        getCommitted: () => dataRef.current,
        clientToContainer,
        getLineMidpoint,
      }),
    { initialProps: { data: args.data } },
  );
  const ctx: HookContext = {
    mutateDebounced,
    commit,
    discardBuffered,
    clientToContainer,
    getLineMidpoint,
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
  return { ctx, result, unmount };
}

/** Apply the last buffered updater to `data` and return the connection. */
function lastConnection(ctx: HookContext, data: ToCData) {
  const updater = ctx.mutateDebounced.mock.calls.at(-1)![0];
  const next = typeof updater === 'function' ? updater(data) : updater;
  return next.sections[0].columns[0].nodes[0].connections![0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useWaypointDrag (single-waypoint model)', () => {
  describe('bindMidpoint — create THE waypoint', () => {
    it('creates a single waypoint at the drop position', () => {
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

      expect(lastConnection(ctx, data).waypoints).toEqual([{ dx: 150, dy: 200 }]);
    });

    it('a sub-threshold press+release (plain click) creates NOTHING', () => {
      const data = makeData([]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindMidpoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 50, clientY: 100 }));
      });
      // 1px jiggle, below the threshold.
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 51, clientY: 100 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 51, clientY: 100 }));
      });

      expect(ctx.mutateDebounced).not.toHaveBeenCalled();
      expect(ctx.commit).not.toHaveBeenCalled();
      expect(isCanvasGestureActive()).toBe(false);
      expect(result.current.isActive).toBe(false);
    });

    it('collapses to the single dragged waypoint even if waypoints already exist', () => {
      // The UI no longer offers midpoint affordances when waypoints
      // exist, but the hook must stay consistent with the
      // single-waypoint model if invoked that way (defensive).
      const data = makeData([{ dx: 100, dy: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindMidpoint(sourceId, targetId, 1)
          .onPointerDown(makePointerDownEvent({ clientX: 0, clientY: 0 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 175, clientY: 75 }));
      });

      expect(lastConnection(ctx, data).waypoints).toEqual([{ dx: 175, dy: 75 }]);
    });
  });

  describe('bindMidpoint — tap handler', () => {
    function pressMidpoint(
      result: ReturnType<typeof setupHook>['result'],
      onTap?: () => void,
      at = { clientX: 50, clientY: 100 },
    ) {
      act(() => {
        result.current
          .bindMidpoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent(at), onTap);
      });
    }
    const move = (clientX: number, clientY: number) =>
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX, clientY }));
      });
    const release = (clientX: number, clientY: number) =>
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX, clientY }));
      });

    it('runs once when the press is released inside the dead-zone, after the gesture has ended', () => {
      const { result } = setupHook({ data: makeData([]) });
      let gestureActiveInside: boolean | null = null;
      const onTap = vi.fn(() => {
        gestureActiveInside = isCanvasGestureActive();
      });

      pressMidpoint(result, onTap);
      move(51, 100);
      release(51, 100);

      expect(onTap).toHaveBeenCalledTimes(1);
      expect(gestureActiveInside).toBe(false);
    });

    it('does not run when the press became a drag', () => {
      const { result } = setupHook({ data: makeData([]) });
      const onTap = vi.fn();

      pressMidpoint(result, onTap);
      move(150, 200);
      release(150, 200);

      expect(onTap).not.toHaveBeenCalled();
    });

    it('does not run when the press became a drag and came back to the press point', () => {
      const { result } = setupHook({ data: makeData([]) });
      const onTap = vi.fn();

      pressMidpoint(result, onTap);
      move(150, 200);
      move(50, 100);
      release(50, 100);

      expect(onTap).not.toHaveBeenCalled();
    });

    it('does not run when the gesture is cancelled before it armed', () => {
      const { result } = setupHook({ data: makeData([]) });
      const onTap = vi.fn();

      pressMidpoint(result, onTap);
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      release(50, 100);

      expect(onTap).not.toHaveBeenCalled();
    });

    it('does not run when the press is refused (editMode=false)', () => {
      const { result } = setupHook({ data: makeData([]), editMode: false });
      const onTap = vi.fn();

      pressMidpoint(result, onTap);
      release(50, 100);

      expect(onTap).not.toHaveBeenCalled();
    });

    it('does not run when the press is refused because another gesture is active', () => {
      const { result } = setupHook({ data: makeData([]) });
      const onTap = vi.fn();
      setCanvasGestureActive(true);

      pressMidpoint(result, onTap);
      release(50, 100);

      expect(onTap).not.toHaveBeenCalled();
    });
  });

  describe('bindWaypoint — move THE waypoint', () => {
    it('updates the waypoint position on pointerup', () => {
      const data = makeData([{ dx: 100, dy: 50 }]);
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

      expect(lastConnection(ctx, data).waypoints).toEqual([{ dx: 160, dy: 80 }]);
      expect(ctx.commit).toHaveBeenCalledTimes(1);
    });

    it('a sub-threshold press+release on a waypoint commits nothing', () => {
      const data = makeData([{ dx: 100, dy: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 50 }));
      });

      expect(ctx.mutateDebounced).not.toHaveBeenCalled();
      expect(ctx.commit).not.toHaveBeenCalled();
    });
  });

  describe('connections carrying several waypoints', () => {
    it('dragging any waypoint of a multi-waypoint connection collapses to the dragged one', () => {
      const data = makeData([
        { dx: 60, dy: 100 },
        { dx: 140, dy: 100 },
        { dx: 220, dy: 100 },
      ]);
      const { ctx, result } = setupHook({ data });

      // Drag waypoint[1] (at 140,100) to (150,180).
      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 1)
          .onPointerDown(makePointerDownEvent({ clientX: 140, clientY: 100 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 180 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 150, clientY: 180 }));
      });

      expect(lastConnection(ctx, data).waypoints).toEqual([{ dx: 150, dy: 180 }]);
      expect(ctx.commit).toHaveBeenCalledTimes(1);
    });

    it('a sub-threshold click on one of several waypoints does NOT collapse the others', () => {
      // A plain click is not an edit: the stored waypoints must survive.
      const data = makeData([
        { dx: 60, dy: 100 },
        { dx: 140, dy: 100 },
      ]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 60, clientY: 100 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 61, clientY: 101 }));
      });

      expect(ctx.mutateDebounced).not.toHaveBeenCalled();
      expect(ctx.commit).not.toHaveBeenCalled();
    });
  });

  describe('bindWaypoint — double-click resets to the automatic curve', () => {
    it('clears the waypoints array and commits once', () => {
      const data = makeData([{ dx: 100, dy: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current.bindWaypoint(sourceId, targetId, 0).onDoubleClick(makeDoubleClickEvent());
      });

      expect(lastConnection(ctx, data).waypoints).toEqual([]);
      expect(ctx.commit).toHaveBeenCalledTimes(1);
    });

    it('clears ALL waypoints of a multi-waypoint connection', () => {
      const data = makeData([
        { dx: 60, dy: 100 },
        { dx: 140, dy: 100 },
      ]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current.bindWaypoint(sourceId, targetId, 1).onDoubleClick(makeDoubleClickEvent());
      });

      expect(lastConnection(ctx, data).waypoints).toEqual([]);
      expect(ctx.commit).toHaveBeenCalledTimes(1);
    });

    it('does nothing when editMode=false', () => {
      const data = makeData([{ dx: 100, dy: 50 }]);
      const { ctx, result } = setupHook({ data, editMode: false });

      act(() => {
        result.current.bindWaypoint(sourceId, targetId, 0).onDoubleClick(makeDoubleClickEvent());
      });

      expect(ctx.mutateDebounced).not.toHaveBeenCalled();
      expect(ctx.commit).not.toHaveBeenCalled();
    });
  });

  describe('mutual exclusion', () => {
    it('short-circuits pointerdown when isCanvasGestureActive=true', () => {
      const data = makeData([{ dx: 100, dy: 50 }]);
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
      const data = makeData([{ dx: 100, dy: 50 }]);
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

  describe('same-task press and release (effect-free listener install)', () => {
    it('hears a pointerup dispatched before passive effects flush, then runs the next drag normally', () => {
      const { ctx, result } = setupHook({ data: makeData([{ dx: 100, dy: 50 }]) });

      // Down + up inside ONE act() callback: React has not flushed
      // passive effects when the pointerup dispatches, so the listeners
      // must already be installed.
      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 50 }));
      });

      expect(ctx.commit).not.toHaveBeenCalled();
      expect(isCanvasGestureActive()).toBe(false);
      expect(result.current.isActive).toBe(false);

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 90 }));
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 160, clientY: 90 }));
      });
      expect(ctx.commit).toHaveBeenCalledTimes(1);
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('document listeners', () => {
    // A listener left behind by a finished gesture sees later events with
    // no gesture of its own to guard on, and its cleanup clears the shared
    // gesture flag, un-claiming a drag that another hook has since begun.
    const strayEvents = () => {
      document.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2 }));
      document.dispatchEvent(pointerEvent('pointermove', { clientX: 5, clientY: 5 }));
      document.dispatchEvent(pointerEvent('pointerup', { clientX: 5, clientY: 5 }));
      document.dispatchEvent(pointerEvent('pointercancel', {}));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    };

    const endings: Array<[string, () => void]> = [
      [
        'a click (pointerup without a drag)',
        () => document.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 50 })),
      ],
      [
        'a drop (pointerup after a drag)',
        () => {
          document.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 90 }));
          document.dispatchEvent(pointerEvent('pointerup', { clientX: 160, clientY: 90 }));
        },
      ],
      ['pointercancel', () => document.dispatchEvent(pointerEvent('pointercancel', {}))],
      [
        'Escape',
        () =>
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      ],
      [
        'a second pointer',
        () => document.dispatchEvent(pointerEvent('pointerdown', { pointerId: 2 })),
      ],
    ];

    it.each(endings)('are released after the gesture ends by %s', (_name, end) => {
      const { result } = setupHook({ data: makeData([{ dx: 100, dy: 50 }]) });
      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      act(end);
      expect(isCanvasGestureActive()).toBe(false);

      act(() => setCanvasGestureActive(true));
      act(strayEvents);
      expect(isCanvasGestureActive()).toBe(true);
    });

    it('are released when the hook unmounts mid-drag', () => {
      const { result, unmount } = setupHook({ data: makeData([{ dx: 100, dy: 50 }]) });
      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      unmount();
      expect(isCanvasGestureActive()).toBe(false);

      act(() => setCanvasGestureActive(true));
      act(strayEvents);
      expect(isCanvasGestureActive()).toBe(true);
    });
  });

  describe('a throwing mutateDebounced or commit on drop', () => {
    // jsdom reports an exception thrown by a listener as a window `error` event.
    function dropReportingErrors(drop: () => void): unknown[] {
      const errors: unknown[] = [];
      const onError = (e: ErrorEvent) => {
        e.preventDefault();
        errors.push(e.error);
      };
      window.addEventListener('error', onError);
      act(drop);
      window.removeEventListener('error', onError);
      return errors;
    }

    it.each(['mutateDebounced', 'commit'] as const)(
      'still ends the gesture when %s throws',
      (failing) => {
        const { ctx, result } = setupHook({ data: makeData([{ dx: 100, dy: 50 }]) });
        act(() => {
          result.current
            .bindWaypoint(sourceId, targetId, 0)
            .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
        });
        act(() => {
          document.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 90 }));
        });
        ctx[failing].mockImplementation(() => {
          throw new Error(`${failing} failed`);
        });

        const errors = dropReportingErrors(() => {
          document.dispatchEvent(pointerEvent('pointerup', { clientX: 160, clientY: 90 }));
        });

        expect(errors).toEqual([expect.objectContaining({ message: `${failing} failed` })]);
        expect(isCanvasGestureActive()).toBe(false);
        expect(result.current.isActive).toBe(false);
      },
    );
  });

  describe('a throwing mutateDebounced on cancel', () => {
    it('still ends the gesture when the restore write throws on Escape', () => {
      const { ctx, result } = setupHook({ data: makeData([{ dx: 100, dy: 50 }]) });
      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 90 }));
      });
      ctx.mutateDebounced.mockImplementation(() => {
        throw new Error('restore failed');
      });

      const errors: unknown[] = [];
      const onError = (e: ErrorEvent) => {
        e.preventDefault();
        errors.push(e.error);
      };
      window.addEventListener('error', onError);
      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      window.removeEventListener('error', onError);

      expect(errors).toEqual([expect.objectContaining({ message: 'restore failed' })]);
      expect(isCanvasGestureActive()).toBe(false);
      expect(result.current.isActive).toBe(false);
    });
  });

  describe('selection suppression', () => {
    const MARK = 'tocb-canvas-gesture';

    it('suppresses text selection from the press of a waypoint or edge drag until it ends', () => {
      const { result } = setupHook({ data: makeData([{ dx: 100, dy: 50 }]) });
      act(() => {
        result.current
          .bindPath(sourceId, targetId)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      expect(document.documentElement.classList.contains(MARK)).toBe(true);
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 100, clientY: 50 }));
      });
      expect(document.documentElement.classList.contains(MARK)).toBe(false);
    });

    it('restores selection on pointercancel and when the hook unmounts mid-drag', () => {
      const { result, unmount } = setupHook({ data: makeData([{ dx: 100, dy: 50 }]) });
      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      expect(document.documentElement.classList.contains(MARK)).toBe(true);
      act(() => {
        document.dispatchEvent(pointerEvent('pointercancel', {}));
      });
      expect(document.documentElement.classList.contains(MARK)).toBe(false);

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      expect(document.documentElement.classList.contains(MARK)).toBe(true);
      unmount();
      expect(document.documentElement.classList.contains(MARK)).toBe(false);
    });
  });

  describe('escape cancel', () => {
    it('clears state on Escape, no commit, no parent notify', () => {
      const data = makeData([{ dx: 100, dy: 50 }]);
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

    it('discards the buffered updater on Escape so a later commit() cannot save it', () => {
      // A buffered key is flushed by any `commit()` without a key, which
      // would save the restored state as if the user had released. The
      // hook calls `discardBuffered(key)` on cancel paths.
      const data = makeData([{ dx: 100, dy: 50 }]);
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
      const data = makeData([{ dx: 100, dy: 50 }]);
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
      const data = makeData([{ dx: 100, dy: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50, pointerId: 1 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 70 }));
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
      const data = makeData([{ dx: 100, dy: 50 }]);
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

    it('stops writing and reports a stale drop when an end node leaves the canvas mid-drag', () => {
      const { ctx, result } = setupHook({ data: makeData([{ dx: 100, dy: 50 }]) });
      act(() => {
        result.current
          .bindWaypoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 50 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 80 }));
      });
      expect(ctx.mutateDebounced).toHaveBeenCalledTimes(1);

      // The midpoint can no longer be found: a landing removed a node.
      ctx.getLineMidpoint.mockReturnValue(null);
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 170, clientY: 90 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 170, clientY: 90 }));
      });

      expect(ctx.mutateDebounced).toHaveBeenCalledTimes(1);
      expect(ctx.commit).not.toHaveBeenCalled();
      expect(ctx.discardBuffered).toHaveBeenCalledWith(`waypoints-${sourceId}->${targetId}`);
      expect(loggingService.reportError).toHaveBeenCalledTimes(1);
      expect(result.current.isActive).toBe(false);
    });

    it('does not report stale-waypoint-drop on a successful drop', () => {
      const data = makeData([{ dx: 100, dy: 50 }]);
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
      const data = makeData([{ dx: 100, dy: 50 }]);
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

  describe('bindPath — whole-edge drag (PR #34 round-7 issue 78)', () => {
    // The reviewer superseded K7's "drag from a connection does
    // nothing": a pointer-drag starting anywhere on the fat hit-path
    // enters the SAME waypoint-drag flow as the midpoint handle. The
    // waypoint position math is unchanged — the waypoint goes where
    // the cursor goes.

    it('a drag starting on the path creates THE waypoint at the drop position', () => {
      const data = makeData([]); // no existing waypoint
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindPath(sourceId, targetId)
          .onPointerDown(makePointerDownEvent({ clientX: 40, clientY: 90 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 140, clientY: 190 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 140, clientY: 190 }));
      });

      expect(lastConnection(ctx, data).waypoints).toEqual([{ dx: 140, dy: 190 }]);
      expect(ctx.commit).toHaveBeenCalledTimes(1);
      expect(isCanvasGestureActive()).toBe(false);
    });

    it('a drag starting on the path MOVES the existing waypoint (collapse semantics)', () => {
      // Same write shape as every other waypoint gesture: replace the
      // whole array with [cursorPos]. Legacy multi-waypoint charts
      // collapse exactly as they do for handle drags.
      const data = makeData([
        { dx: 60, dy: 100 },
        { dx: 140, dy: 100 },
      ]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindPath(sourceId, targetId)
          .onPointerDown(makePointerDownEvent({ clientX: 90, clientY: 100 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 200, clientY: 250 }));
      });

      expect(lastConnection(ctx, data).waypoints).toEqual([{ dx: 200, dy: 250 }]);
      expect(ctx.commit).toHaveBeenCalledTimes(1);
    });

    it('a sub-threshold press+release on the path writes nothing (plain click)', () => {
      const data = makeData([]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindPath(sourceId, targetId)
          .onPointerDown(makePointerDownEvent({ clientX: 40, clientY: 90 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 41, clientY: 91 }));
      });

      expect(ctx.mutateDebounced).not.toHaveBeenCalled();
      expect(ctx.commit).not.toHaveBeenCalled();
      expect(isCanvasGestureActive()).toBe(false);
    });

    it('respects editMode=false and the canvas-gesture mutex', () => {
      const data = makeData([]);
      const viewMode = setupHook({ data, editMode: false });
      act(() => {
        viewMode.result.current
          .bindPath(sourceId, targetId)
          .onPointerDown(makePointerDownEvent({ clientX: 40, clientY: 90 }));
      });
      expect(viewMode.result.current.isActive).toBe(false);
      cleanup();
      _resetCanvasGestureStateForTest();

      const { ctx, result } = setupHook({ data });
      act(() => setCanvasGestureActive(true));
      act(() => {
        result.current
          .bindPath(sourceId, targetId)
          .onPointerDown(makePointerDownEvent({ clientX: 40, clientY: 90 }));
      });
      expect(result.current.isActive).toBe(false);
      expect(ctx.mutateDebounced).not.toHaveBeenCalled();
    });

    it('cancels (no commit, buffered discard) when the connection vanished mid-gesture', () => {
      const data = makeData([]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current
          .bindPath(sourceId, targetId)
          .onPointerDown(makePointerDownEvent({ clientX: 40, clientY: 90 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 140, clientY: 190 }));
      });

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
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 140, clientY: 190 }));
      });

      expect(ctx.commit).not.toHaveBeenCalled();
      expect(loggingService.reportError).toHaveBeenCalledTimes(1);
      expect((loggingService.reportError as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(
        expect.objectContaining({ error_name: 'stale-waypoint-drop' }),
      );
    });

    describe('consumePathGestureArmed — trailing-click suppression signal', () => {
      // Browsers fire `click` after every down/up pair on the path,
      // however far apart (pointer capture keeps the target stable).
      // The component's click handler consumes this one-shot flag to
      // tell "that gesture was a drag" (suppress the EdgeEditor) from
      // "that was a click" (open it). The flag — not a positional
      // dead-zone — is what makes an out-and-back drag (release near
      // the press point) count as a drag.

      it('is true exactly once after an armed path gesture', () => {
        const data = makeData([]);
        const { result } = setupHook({ data });

        act(() => {
          result.current
            .bindPath(sourceId, targetId)
            .onPointerDown(makePointerDownEvent({ clientX: 40, clientY: 90 }));
        });
        act(() => {
          document.dispatchEvent(pointerEvent('pointermove', { clientX: 140, clientY: 190 }));
        });
        act(() => {
          document.dispatchEvent(pointerEvent('pointerup', { clientX: 140, clientY: 190 }));
        });

        expect(result.current.consumePathGestureArmed()).toBe(true);
        // One-shot: consumed.
        expect(result.current.consumePathGestureArmed()).toBe(false);
      });

      it('is true after an out-and-back drag that releases at the press point', () => {
        // The arm latches mid-gesture; releasing back at the start is
        // a "moved then changed my mind" drop, not a click.
        const data = makeData([]);
        const { result } = setupHook({ data });

        act(() => {
          result.current
            .bindPath(sourceId, targetId)
            .onPointerDown(makePointerDownEvent({ clientX: 40, clientY: 90 }));
        });
        act(() => {
          document.dispatchEvent(pointerEvent('pointermove', { clientX: 140, clientY: 190 }));
        });
        act(() => {
          document.dispatchEvent(pointerEvent('pointerup', { clientX: 40, clientY: 90 }));
        });

        expect(result.current.consumePathGestureArmed()).toBe(true);
      });

      it('is false after a sub-threshold path press (a plain click)', () => {
        const data = makeData([]);
        const { result } = setupHook({ data });

        act(() => {
          result.current
            .bindPath(sourceId, targetId)
            .onPointerDown(makePointerDownEvent({ clientX: 40, clientY: 90 }));
        });
        act(() => {
          document.dispatchEvent(pointerEvent('pointerup', { clientX: 41, clientY: 91 }));
        });

        expect(result.current.consumePathGestureArmed()).toBe(false);
      });

      it('is true after an Escape-cancelled armed path gesture (release must not open the editor)', () => {
        const data = makeData([]);
        const { ctx, result } = setupHook({ data });

        act(() => {
          result.current
            .bindPath(sourceId, targetId)
            .onPointerDown(makePointerDownEvent({ clientX: 40, clientY: 90 }));
        });
        act(() => {
          document.dispatchEvent(pointerEvent('pointermove', { clientX: 140, clientY: 190 }));
        });
        act(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });

        expect(ctx.commit).not.toHaveBeenCalled();
        expect(ctx.discardBuffered).toHaveBeenCalledWith(`waypoints-${sourceId}->${targetId}`);
        expect(result.current.consumePathGestureArmed()).toBe(true);
      });

      it('is NOT set by handle-initiated gestures (midpoint / waypoint drags)', () => {
        const data = makeData([]);
        const { result } = setupHook({ data });

        act(() => {
          result.current
            .bindMidpoint(sourceId, targetId, 0)
            .onPointerDown(makePointerDownEvent({ clientX: 40, clientY: 90 }));
        });
        act(() => {
          document.dispatchEvent(pointerEvent('pointermove', { clientX: 140, clientY: 190 }));
        });
        act(() => {
          document.dispatchEvent(pointerEvent('pointerup', { clientX: 140, clientY: 190 }));
        });

        expect(result.current.consumePathGestureArmed()).toBe(false);
      });

      it('a stale flag from a cancelled gesture resets on the next path press', () => {
        // Cancel paths can set the flag without a trailing click ever
        // firing (pointer released off-path). The next path press
        // must start clean.
        const data = makeData([]);
        const { result } = setupHook({ data });

        act(() => {
          result.current
            .bindPath(sourceId, targetId)
            .onPointerDown(makePointerDownEvent({ clientX: 40, clientY: 90 }));
        });
        act(() => {
          document.dispatchEvent(pointerEvent('pointermove', { clientX: 140, clientY: 190 }));
        });
        act(() => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });
        // Flag is true now, but NOT consumed (no click fired).

        act(() => {
          result.current
            .bindPath(sourceId, targetId)
            .onPointerDown(makePointerDownEvent({ clientX: 50, clientY: 95 }));
        });
        act(() => {
          document.dispatchEvent(pointerEvent('pointerup', { clientX: 50, clientY: 95 }));
        });

        expect(result.current.consumePathGestureArmed()).toBe(false);
      });
    });
  });

  describe('resetWaypoints — shared reset seam (dblclick + EdgeEditor button)', () => {
    it('is callable without an event (EdgeEditor "Reset path" button) and commits once', () => {
      const data = makeData([{ dx: 100, dy: 50 }]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current.resetWaypoints(sourceId, targetId);
      });

      expect(lastConnection(ctx, data).waypoints).toEqual([]);
      expect(ctx.commit).toHaveBeenCalledTimes(1);
    });

    it('no-ops when the connection has no waypoints', () => {
      const data = makeData([]);
      const { ctx, result } = setupHook({ data });

      act(() => {
        result.current.resetWaypoints(sourceId, targetId);
      });

      expect(ctx.mutateDebounced).not.toHaveBeenCalled();
      expect(ctx.commit).not.toHaveBeenCalled();
    });

    it('no-ops when editMode=false', () => {
      const data = makeData([{ dx: 100, dy: 50 }]);
      const { ctx, result } = setupHook({ data, editMode: false });

      act(() => {
        result.current.resetWaypoints(sourceId, targetId);
      });

      expect(ctx.mutateDebounced).not.toHaveBeenCalled();
      expect(ctx.commit).not.toHaveBeenCalled();
    });
  });

  describe('offsets from the line midpoint', () => {
    it('stores the drop position relative to the midpoint of the source -> target line', () => {
      const data = makeData([]);
      const { ctx, result } = setupHook({ data, lineMidpoint: { x: 100, y: 40 } });

      act(() => {
        result.current
          .bindMidpoint(sourceId, targetId, 0)
          .onPointerDown(makePointerDownEvent({ clientX: 100, clientY: 40 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 150, clientY: 200 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 150, clientY: 200 }));
      });

      expect(ctx.getLineMidpoint).toHaveBeenCalledWith(sourceId, targetId);
      expect(lastConnection(ctx, data).waypoints).toEqual([{ dx: 50, dy: 160 }]);
    });

    it('applies the same offset rule to a drag that starts on the edge', () => {
      const data = makeData([{ dx: 5, dy: 5 }]);
      const { ctx, result } = setupHook({ data, lineMidpoint: { x: 100, y: 40 } });

      act(() => {
        result.current
          .bindPath(sourceId, targetId)
          .onPointerDown(makePointerDownEvent({ clientX: 60, clientY: 40 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 80, clientY: 10 }));
      });

      expect(lastConnection(ctx, data).waypoints).toEqual([{ dx: -20, dy: -30 }]);
    });

    it('replaces old absolute {x, y} waypoints with a single offset on the first drag', () => {
      const oldFormat = [{ x: 120, y: 240 }] as unknown as WaypointOffset[];
      const data = makeData(oldFormat);
      const { ctx, result } = setupHook({ data, lineMidpoint: { x: 100, y: 40 } });

      act(() => {
        result.current
          .bindPath(sourceId, targetId)
          .onPointerDown(makePointerDownEvent({ clientX: 60, clientY: 40 }));
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 130, clientY: 90 }));
      });

      expect(lastConnection(ctx, data).waypoints).toEqual([{ dx: 30, dy: 50 }]);
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

      const connection = lastConnection(ctx, ctx.data);
      // (250-50)/2, (300-100)/2 -> (100, 100).
      expect(connection.waypoints).toEqual([{ dx: 100, dy: 100 }]);
    });
  });
});
