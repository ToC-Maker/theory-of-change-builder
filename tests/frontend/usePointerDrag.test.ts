// Tests for `usePointerDrag` — the PR 4 pointer-events drag hook.
//
// Verifies (acceptance items from plan/figma-redesign.md:910-922):
//   - Drag-start: pointerdown on bound node sets isCanvasGestureActive,
//     fires onStart, transitions dragState from null to {nodeId,...}.
//   - Drag-over: pointermove drives ghostPos and dragOverLocation
//     (classifyRegion called via getSnapshot).
//   - Drop: pointerup with a valid region fires onDrop with the
//     mapped target, clears dragState, clears isCanvasGestureActive.
//   - Pointer-cancel: pointercancel resets state without firing onDrop.
//   - Escape key: cancels cleanly (releases pointer capture, resets).
//   - Second-pointer cancel: a second pointerdown mid-drag cancels.
//   - Stale-node guard: drop with no matching node in data aborts with
//     loggingService.reportError, no onDrop call.
//   - isCanvasGestureActive transitions: false → true on start, false
//     after drop / cancel / escape / stale-abort.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import { usePointerDrag } from '../../src/hooks/usePointerDrag';
import {
  isCanvasGestureActive,
  setCanvasGestureActive,
  _resetCanvasGestureStateForTest,
} from '../../src/hooks/_canvasGestureState';
import type { LayoutSnapshot } from '../../src/hooks/useGraphLayout';
import type { ToCData } from '../../src/types';

// Mock loggingService.reportError so stale-node aborts can be asserted.
vi.mock('../../src/services/loggingService', () => {
  return {
    loggingService: {
      reportError: vi.fn(),
    },
  };
});

import { loggingService } from '../../src/services/loggingService';

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleNode = (id: string, yPosition = 0) => ({
  id,
  title: `Node ${id}`,
  text: '',
  connectionIds: [],
  connections: [],
  yPosition,
});

const sampleData = (nodes: ReturnType<typeof sampleNode>[] = [sampleNode('n-1')]): ToCData => ({
  sections: [
    {
      title: 'A',
      columns: [
        {
          nodes,
        },
        {
          nodes: [],
        },
      ],
    },
    {
      title: 'B',
      columns: [
        {
          nodes: [],
        },
      ],
    },
  ],
});

// A layout snapshot with two sections, simple node-slot zones.
//
// Section 0: Col0 [50..250 x] [100..900 y], with Node A at center y=200 height 60 (170..230).
//            Col1 [274..474 x].
// Section 1: Col0 [506..706 x].
const makeSnapshot = (): LayoutSnapshot => ({
  sectionPadding: 32,
  columnPadding: 24,
  columnRects: [
    [
      { left: 50, right: 250, top: 100, bottom: 900 },
      { left: 274, right: 474, top: 100, bottom: 900 },
    ],
    [{ left: 506, right: 706, top: 100, bottom: 900 }],
  ],
  containerWidth: 800,
  containerHeight: 1000,
  nodeRects: {
    '0-0': [{ left: 50, right: 250, top: 170, bottom: 230 }],
    '0-1': [],
    '1-0': [],
  },
});

// A minimal stand-in element that supports {set,release}PointerCapture.
// jsdom does not implement these on HTMLElement; we patch them per-test.
// We also patch getBoundingClientRect since jsdom returns all-zero rects.
function makeMockElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.hasPointerCapture = vi.fn().mockReturnValue(true);
  el.getBoundingClientRect = vi.fn().mockReturnValue({
    left: 0,
    right: 200,
    top: 0,
    bottom: 60,
    width: 200,
    height: 60,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  // offsetWidth/Height are zero in jsdom; define for our drag math.
  Object.defineProperty(el, 'offsetWidth', { value: 200, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: 60, configurable: true });
  return el;
}

// Build a synthetic React PointerEvent: handler-callable, with currentTarget
// + target set. The hook reads currentTarget for node geometry.
function pointerDownEvent(init: {
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  button?: number;
  nodeEl: HTMLElement;
}): React.PointerEvent {
  return {
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    pointerId: init.pointerId ?? 1,
    pointerType: 'mouse',
    button: init.button ?? 0,
    target: init.nodeEl,
    currentTarget: init.nodeEl,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.PointerEvent;
}

// Build a native PointerEvent for document-level dispatch.
function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number; target?: EventTarget },
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    clientX: { value: init.clientX ?? 0 },
    clientY: { value: init.clientY ?? 0 },
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: 'mouse' },
  });
  if (init.target) {
    Object.defineProperty(event, 'target', { value: init.target });
  }
  return event;
}

interface HookArgs {
  data: ToCData;
  onDrop: ReturnType<typeof vi.fn>;
  onStart?: ReturnType<typeof vi.fn>;
  editMode?: boolean;
  zoomScale?: number;
  snapshot?: LayoutSnapshot;
}

function setupHook(args: HookArgs) {
  let containerEl: HTMLDivElement;
  const result = renderHook(() => {
    const containerRef = useRef<HTMLDivElement>(null);
    if (!containerEl) {
      containerEl = document.createElement('div');
      document.body.appendChild(containerEl);
      // The container anchors at (0,0) for the coord-translation math
      // to come out clean.
      containerEl.getBoundingClientRect = vi.fn().mockReturnValue({
        left: 0,
        right: 800,
        top: 0,
        bottom: 1000,
        width: 800,
        height: 1000,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    }
    containerRef.current = containerEl;
    const getSnapshot = () => args.snapshot ?? makeSnapshot();
    return usePointerDrag({
      data: args.data,
      containerRef,
      getSnapshot,
      editMode: args.editMode ?? true,
      zoomScale: args.zoomScale ?? 1,
      nodeHeights: { 'n-1': 60 },
      onDrop: args.onDrop,
      onDragStart: args.onStart,
    });
  });
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('usePointerDrag', () => {
  describe('drag-start', () => {
    it('sets isCanvasGestureActive on pointerdown and fires onDragStart', () => {
      const onDrop = vi.fn();
      const onStart = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop, onStart });

      expect(isCanvasGestureActive()).toBe(false);
      expect(result.current.dragState).toBeNull();

      const nodeEl = makeMockElement();
      const e = pointerDownEvent({ clientX: 100, clientY: 200, pointerId: 1, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(e);
      });

      expect(isCanvasGestureActive()).toBe(true);
      expect(onStart).toHaveBeenCalledTimes(1);
      expect(result.current.dragState).not.toBeNull();
      expect(result.current.dragState?.nodeId).toBe('n-1');
    });

    it('short-circuits when another canvas gesture is in flight', () => {
      const onDrop = vi.fn();
      const onStart = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop, onStart });

      // Simulate another hook (PR 5/7) already holding the gesture.
      act(() => setCanvasGestureActive(true));

      const nodeEl = makeMockElement();
      const e = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(e);
      });

      expect(onStart).not.toHaveBeenCalled();
      expect(result.current.dragState).toBeNull();
    });

    it('does not start drag when editMode=false', () => {
      const onDrop = vi.fn();
      const onStart = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop, onStart, editMode: false });

      const nodeEl = makeMockElement();
      const e = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(e);
      });

      expect(onStart).not.toHaveBeenCalled();
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('drag-over', () => {
    it('updates ghostPos and dragOverLocation on pointermove', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const e = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(e);
      });

      // Move within Section 0 / Col 1 — should classify as node-slot in col 1.
      // Container is anchored at (0,0) per makeMockElement.
      const move = pointerEvent('pointermove', { clientX: 350, clientY: 400 });
      act(() => {
        document.dispatchEvent(move);
      });

      expect(result.current.dragState?.dragOverLocation).toEqual(
        expect.objectContaining({
          kind: 'node-slot',
          sectionIndex: 0,
          columnIndex: 1,
        }),
      );
      expect(result.current.dragState?.ghostPos).toEqual({ x: 350, y: 400 });
    });

    it('classifies new-column gutter with kind="new-column"', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      // Move into the gutter between col 0 and col 1 of section 0
      // (left=250, right=274). Pick 260.
      const move = pointerEvent('pointermove', { clientX: 260, clientY: 400 });
      act(() => {
        document.dispatchEvent(move);
      });

      expect(result.current.dragState?.dragOverLocation).toEqual(
        expect.objectContaining({
          kind: 'new-column',
          sectionIndex: 0,
          columnIndex: 1,
        }),
      );
    });
  });

  describe('drop', () => {
    it('fires onDrop on pointerup and clears state', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      const move = pointerEvent('pointermove', { clientX: 350, clientY: 400 });
      act(() => {
        document.dispatchEvent(move);
      });

      const up = pointerEvent('pointerup', { clientX: 350, clientY: 400 });
      act(() => {
        document.dispatchEvent(up);
      });

      expect(onDrop).toHaveBeenCalledTimes(1);
      expect(onDrop.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          kind: 'node-slot',
          sectionIndex: 0,
          columnIndex: 1,
        }),
      );
      // Hook supplies pointerOffset as the third argument, captured at
      // drag-start (cursor at 100,200; node rect anchored at 0,0 in
      // makeMockElement) so offset is {x: 100, y: 200}.
      expect(onDrop.mock.calls[0][1]).toBe('n-1');
      expect(onDrop.mock.calls[0][2]).toEqual({ x: 100, y: 200 });
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });

    it('does not call onDrop when dropped over void (region=null)', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      // Move into the void above all column rects (y < minTop=100).
      const move = pointerEvent('pointermove', { clientX: 100, clientY: 50 });
      act(() => {
        document.dispatchEvent(move);
      });

      const up = pointerEvent('pointerup', { clientX: 100, clientY: 50 });
      act(() => {
        document.dispatchEvent(up);
      });

      expect(onDrop).not.toHaveBeenCalled();
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('pointer-cancel', () => {
    it('clears state on pointercancel without firing onDrop', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      expect(isCanvasGestureActive()).toBe(true);

      const cancel = pointerEvent('pointercancel', { clientX: 100, clientY: 200 });
      act(() => {
        document.dispatchEvent(cancel);
      });

      expect(onDrop).not.toHaveBeenCalled();
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('escape cancel', () => {
    it('escape during drag cancels cleanly', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      expect(isCanvasGestureActive()).toBe(true);

      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      act(() => {
        document.dispatchEvent(esc);
      });

      expect(onDrop).not.toHaveBeenCalled();
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });

    it('ignores non-Escape keys', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      act(() => {
        document.dispatchEvent(enter);
      });

      expect(result.current.dragState).not.toBeNull();
      expect(isCanvasGestureActive()).toBe(true);
    });
  });

  describe('second-pointer cancel (pinch-zoom coexistence)', () => {
    it('cancels drag when a second pointer arrives mid-drag', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, pointerId: 1, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      expect(isCanvasGestureActive()).toBe(true);

      // Second-finger touch elsewhere on the page.
      const second = pointerEvent('pointerdown', { clientX: 500, clientY: 500, pointerId: 2 });
      act(() => {
        document.dispatchEvent(second);
      });

      expect(onDrop).not.toHaveBeenCalled();
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('stale-node abort', () => {
    it('aborts drop when node id no longer exists in data, fires onStaleDrop', () => {
      const onDrop = vi.fn();
      const onStaleDrop = vi.fn();
      // Start with node 'n-1'; mid-flight the data prop will be replaced.
      let containerEl: HTMLDivElement | null = null;
      const { result, rerender } = renderHook(
        ({ data }: { data: ToCData }) => {
          const containerRef = useRef<HTMLDivElement>(null);
          if (!containerEl) {
            containerEl = document.createElement('div');
            document.body.appendChild(containerEl);
            containerEl.getBoundingClientRect = vi.fn().mockReturnValue({
              left: 0,
              right: 800,
              top: 0,
              bottom: 1000,
              width: 800,
              height: 1000,
              x: 0,
              y: 0,
              toJSON: () => ({}),
            });
          }
          containerRef.current = containerEl;
          const getSnapshot = () => makeSnapshot();
          return usePointerDrag({
            data,
            containerRef,
            getSnapshot,
            editMode: true,
            zoomScale: 1,
            nodeHeights: { 'n-1': 60 },
            onDrop,
            onStaleDrop,
          });
        },
        { initialProps: { data: sampleData() } },
      );

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      const move = pointerEvent('pointermove', { clientX: 350, clientY: 400 });
      act(() => {
        document.dispatchEvent(move);
      });

      // Simulate cross-tab delete of n-1.
      rerender({ data: { sections: [{ title: 'A', columns: [{ nodes: [] }] }] } });

      const up = pointerEvent('pointerup', { clientX: 350, clientY: 400 });
      act(() => {
        document.dispatchEvent(up);
      });

      expect(onDrop).not.toHaveBeenCalled();
      expect(loggingService.reportError).toHaveBeenCalledTimes(1);
      expect((loggingService.reportError as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(
        expect.objectContaining({
          error_name: 'stale-node-drop',
        }),
      );
      // I2 (silent-failure-hunter): user must be able to surface a
      // toast / inline notice when the drag silently aborts.
      expect(onStaleDrop).toHaveBeenCalledTimes(1);
      expect(onStaleDrop).toHaveBeenCalledWith('n-1');
      expect(isCanvasGestureActive()).toBe(false);
      expect(result.current.dragState).toBeNull();
    });
  });

  describe('isActive flag (for polling pause)', () => {
    it('exposes isActive=true while drag is in flight, false otherwise', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      expect(result.current.isActive).toBe(false);

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      expect(result.current.isActive).toBe(true);

      const up = pointerEvent('pointerup', { clientX: 350, clientY: 400 });
      act(() => {
        document.dispatchEvent(up);
      });

      expect(result.current.isActive).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('clears isCanvasGestureActive when the hook unmounts mid-drag', () => {
      const onDrop = vi.fn();
      const { result, unmount } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      expect(isCanvasGestureActive()).toBe(true);
      unmount();
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('tap vs drag threshold (avoids ghost flicker on single tap)', () => {
    it("hasMoved=false on pointerdown alone (single tap shouldn't engage ghost)", () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      expect(result.current.dragState).not.toBeNull();
      expect(result.current.dragState?.hasMoved).toBe(false);
    });

    it('hasMoved=false after sub-threshold movement (3px)', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      // 3px move — under the 4px threshold.
      const move = pointerEvent('pointermove', { clientX: 103, clientY: 202 });
      act(() => {
        document.dispatchEvent(move);
      });

      expect(result.current.dragState?.hasMoved).toBe(false);
    });

    it('hasMoved=true after >threshold movement (8px)', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      const move = pointerEvent('pointermove', { clientX: 108, clientY: 202 });
      act(() => {
        document.dispatchEvent(move);
      });

      expect(result.current.dragState?.hasMoved).toBe(true);
    });

    it('hasMoved stays true once flipped (slow drag past threshold)', () => {
      const onDrop = vi.fn();
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      // Cross the threshold once...
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 108, clientY: 202 }));
      });
      expect(result.current.dragState?.hasMoved).toBe(true);

      // ...then a 1px tiny move shouldn't re-set it to false.
      act(() => {
        document.dispatchEvent(pointerEvent('pointermove', { clientX: 109, clientY: 202 }));
      });
      expect(result.current.dragState?.hasMoved).toBe(true);
    });
  });

  describe('onDrop callback throws (C1: try/finally cleanup)', () => {
    it('still cleans up all state when onDrop throws', () => {
      // C1 from silent-failure-hunter: without try/finally around
      // onDropRef.current(...), a throw escapes pointerup and leaves
      // (a) isCanvasGestureActive=true forever, (b) dragState non-null
      // (phantom ghost stuck on screen), (c) pointer capture leaked.
      // The hook must guarantee cleanup regardless of consumer behavior.
      const onDrop = vi.fn(() => {
        throw new Error('boom');
      });
      const { result } = setupHook({ data: sampleData(), onDrop });

      const nodeEl = makeMockElement();
      const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
      act(() => {
        result.current.bindNode('n-1').onPointerDown(down);
      });

      const move = pointerEvent('pointermove', { clientX: 350, clientY: 400 });
      act(() => {
        document.dispatchEvent(move);
      });

      // pointerup triggers onDrop which throws. The hook must still
      // run cleanup and surface the error via loggingService.
      const up = pointerEvent('pointerup', { clientX: 350, clientY: 400 });
      act(() => {
        document.dispatchEvent(up);
      });

      expect(onDrop).toHaveBeenCalledTimes(1);
      // Cleanup guarantees: all four observable surfaces back to neutral.
      expect(isCanvasGestureActive()).toBe(false);
      expect(result.current.dragState).toBeNull();
      expect(result.current.isActive).toBe(false);
      // The thrown error must be reported (so the user-invisible bug is
      // observable in logs rather than silently swallowed).
      expect(loggingService.reportError).toHaveBeenCalledWith(
        expect.objectContaining({ error_name: 'drop-handler-threw' }),
      );
    });
  });
});
