// Tests for `useConnectionDrag` — the PR 5 drag-to-connect hook.
//
// Verifies (acceptance items from plan/figma-redesign.md:1028-1042):
//   - Drag-start: pointerdown on bound handle sets isCanvasGestureActive,
//     transitions dragState from null to {sourceNodeId, sourceSide, ...}.
//   - Drag-over: pointermove updates ghostPos and resolves targetNodeId
//     via DOM hit-test (`document.elementFromPoint` → walk to
//     `[data-tocb-node]` ancestor).
//   - Drop: pointerup over a target node fires `onConnect(source, target)`
//     exactly once and clears state.
//   - Drop over the source node itself or void: no onConnect call.
//   - Escape / pointercancel / second-pointer: cleanup, no onConnect.
//   - Stale-node guard: source or target deleted mid-drag → no onConnect,
//     loggingService.reportError stamped.
//   - Mutual exclusion: `isCanvasGestureActive=true` short-circuits start.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useConnectionDrag } from '../../src/hooks/useConnectionDrag';
import {
  isCanvasGestureActive,
  setCanvasGestureActive,
  _resetCanvasGestureStateForTest,
} from '../../src/hooks/_canvasGestureState';
import type { ToCData } from '../../src/types';

// Mock loggingService so stale-node aborts can be asserted.
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
  // Clean up any nodes appended to document.body
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sampleNode = (id: string) => ({
  id,
  title: id,
  text: '',
  connectionIds: [],
  connections: [],
  yPosition: 0,
});

const sampleData = (ids: string[] = ['source', 'target', 'other']): ToCData => ({
  sections: [
    {
      title: 'A',
      columns: [
        {
          nodes: ids.map(sampleNode),
        },
      ],
    },
  ],
});

/**
 * Append a fake node element to document.body bearing
 * `data-tocb-node="<id>"`. Returns the element so tests can patch
 * `getBoundingClientRect` on it to position the node for elementFromPoint.
 */
function appendFakeNode(id: string, rect: { x: number; y: number; w: number; h: number }) {
  const el = document.createElement('div');
  el.dataset.tocbNode = id;
  el.style.position = 'absolute';
  el.style.left = `${rect.x}px`;
  el.style.top = `${rect.y}px`;
  el.style.width = `${rect.w}px`;
  el.style.height = `${rect.h}px`;
  document.body.appendChild(el);
  return el;
}

function makeMockHandle(): HTMLDivElement {
  const el = document.createElement('div');
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.hasPointerCapture = vi.fn().mockReturnValue(true);
  return el;
}

function pointerDownEvent(init: {
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  button?: number;
  handleEl: HTMLElement;
}): React.PointerEvent {
  return {
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    pointerId: init.pointerId ?? 1,
    pointerType: 'mouse',
    button: init.button ?? 0,
    target: init.handleEl,
    currentTarget: init.handleEl,
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

interface HookArgs {
  data: ToCData;
  onConnect: ReturnType<typeof vi.fn>;
  editMode?: boolean;
}

function setupHook(args: HookArgs) {
  return renderHook(() =>
    useConnectionDrag({
      data: args.data,
      editMode: args.editMode ?? true,
      onConnect: args.onConnect,
    }),
  );
}

// `document.elementFromPoint` doesn't work in jsdom. We mock it to
// look at appended `[data-tocb-node]` elements and return the one
// containing the point.
function mockElementFromPoint() {
  document.elementFromPoint = vi.fn((x: number, y: number) => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('[data-tocb-node]'));
    for (const node of nodes) {
      const left = parseFloat(node.style.left || '0');
      const top = parseFloat(node.style.top || '0');
      const width = parseFloat(node.style.width || '0');
      const height = parseFloat(node.style.height || '0');
      if (x >= left && x <= left + width && y >= top && y <= top + height) {
        return node;
      }
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useConnectionDrag', () => {
  describe('drag-start', () => {
    it('sets isCanvasGestureActive on pointerdown', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });

      expect(isCanvasGestureActive()).toBe(false);
      expect(result.current.dragState).toBeNull();

      const handle = makeMockHandle();
      const e = pointerDownEvent({ clientX: 100, clientY: 50, handleEl: handle });
      act(() => {
        result.current.bindHandle('source', 'right').onPointerDown(e);
      });

      expect(isCanvasGestureActive()).toBe(true);
      expect(result.current.dragState).not.toBeNull();
      expect(result.current.dragState?.sourceNodeId).toBe('source');
      expect(result.current.dragState?.sourceSide).toBe('right');
    });

    it('short-circuits when another canvas gesture is in flight', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });

      // Simulate `usePointerDrag` (or `useWaypointDrag`) already
      // holding the gesture.
      act(() => setCanvasGestureActive(true));

      const handle = makeMockHandle();
      const e = pointerDownEvent({ clientX: 100, clientY: 50, handleEl: handle });
      act(() => {
        result.current.bindHandle('source', 'right').onPointerDown(e);
      });

      expect(result.current.dragState).toBeNull();
    });

    it('does not start drag when editMode=false', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect, editMode: false });

      const handle = makeMockHandle();
      const e = pointerDownEvent({ clientX: 100, clientY: 50, handleEl: handle });
      act(() => {
        result.current.bindHandle('source', 'right').onPointerDown(e);
      });

      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('drag-over', () => {
    it('updates ghostPos and targetNodeId on pointermove over a node', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });
      mockElementFromPoint();

      // Place the target node at (200..300, 0..50). We don't care
      // about the source's screen position; the hit-test uses cursor
      // coords only.
      appendFakeNode('target', { x: 200, y: 0, w: 100, h: 50 });

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(pointerDownEvent({ clientX: 50, clientY: 25, handleEl: handle }));
      });

      const move = pointerEvent('pointermove', { clientX: 250, clientY: 25 });
      act(() => {
        document.dispatchEvent(move);
      });

      expect(result.current.dragState?.targetNodeId).toBe('target');
      expect(result.current.dragState?.ghostPos).toEqual({ x: 250, y: 25 });
    });

    it('targetNodeId stays null when hovering over the source node itself', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });
      mockElementFromPoint();

      // Source node visually placed at (0..50, 0..50). Cursor inside it.
      appendFakeNode('source', { x: 0, y: 0, w: 50, h: 50 });

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(pointerDownEvent({ clientX: 0, clientY: 25, handleEl: handle }));
      });

      const move = pointerEvent('pointermove', { clientX: 25, clientY: 25 });
      act(() => {
        document.dispatchEvent(move);
      });

      expect(result.current.dragState?.targetNodeId).toBeNull();
    });

    it('targetNodeId is null when hovering over void (no node under cursor)', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });
      mockElementFromPoint();

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(pointerDownEvent({ clientX: 50, clientY: 50, handleEl: handle }));
      });

      const move = pointerEvent('pointermove', { clientX: 999, clientY: 999 });
      act(() => {
        document.dispatchEvent(move);
      });

      expect(result.current.dragState?.targetNodeId).toBeNull();
    });
  });

  describe('drop', () => {
    it('fires onConnect on pointerup over a target node', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });
      mockElementFromPoint();

      appendFakeNode('target', { x: 200, y: 0, w: 100, h: 50 });

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(pointerDownEvent({ clientX: 50, clientY: 25, handleEl: handle }));
      });

      const up = pointerEvent('pointerup', { clientX: 250, clientY: 25 });
      act(() => {
        document.dispatchEvent(up);
      });

      expect(onConnect).toHaveBeenCalledTimes(1);
      expect(onConnect).toHaveBeenCalledWith('source', 'target');
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });

    it('does not fire onConnect on pointerup over void', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });
      mockElementFromPoint();

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(pointerDownEvent({ clientX: 50, clientY: 25, handleEl: handle }));
      });

      const up = pointerEvent('pointerup', { clientX: 999, clientY: 999 });
      act(() => {
        document.dispatchEvent(up);
      });

      expect(onConnect).not.toHaveBeenCalled();
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });

    it('does not fire onConnect when dropping on the source node', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });
      mockElementFromPoint();

      appendFakeNode('source', { x: 0, y: 0, w: 50, h: 50 });

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(pointerDownEvent({ clientX: 0, clientY: 25, handleEl: handle }));
      });

      const up = pointerEvent('pointerup', { clientX: 25, clientY: 25 });
      act(() => {
        document.dispatchEvent(up);
      });

      expect(onConnect).not.toHaveBeenCalled();
    });
  });

  describe('escape cancel', () => {
    it('clears state on Escape, no onConnect', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(pointerDownEvent({ clientX: 50, clientY: 25, handleEl: handle }));
      });

      expect(isCanvasGestureActive()).toBe(true);

      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
      act(() => {
        document.dispatchEvent(esc);
      });

      expect(onConnect).not.toHaveBeenCalled();
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('pointer-cancel', () => {
    it('clears state on pointercancel, no onConnect', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(pointerDownEvent({ clientX: 50, clientY: 25, handleEl: handle }));
      });

      const cancel = pointerEvent('pointercancel', { clientX: 50, clientY: 25 });
      act(() => {
        document.dispatchEvent(cancel);
      });

      expect(onConnect).not.toHaveBeenCalled();
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('second-pointer cancel (pinch-zoom coexistence)', () => {
    it('cancels drag when a second pointer arrives mid-drag', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(
            pointerDownEvent({ clientX: 50, clientY: 25, pointerId: 1, handleEl: handle }),
          );
      });

      expect(isCanvasGestureActive()).toBe(true);

      const second = pointerEvent('pointerdown', { clientX: 500, clientY: 500, pointerId: 2 });
      act(() => {
        document.dispatchEvent(second);
      });

      expect(onConnect).not.toHaveBeenCalled();
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('stale-node abort', () => {
    it('aborts when target node was deleted between pointerdown and pointerup', () => {
      const onConnect = vi.fn();
      mockElementFromPoint();

      // Hook starts with source + target + other.
      const { result, rerender } = renderHook(
        ({ data }: { data: ToCData }) =>
          useConnectionDrag({
            data,
            editMode: true,
            onConnect,
          }),
        { initialProps: { data: sampleData() } },
      );

      appendFakeNode('target', { x: 200, y: 0, w: 100, h: 50 });

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(pointerDownEvent({ clientX: 50, clientY: 25, handleEl: handle }));
      });

      // Simulate cross-tab delete of `target`.
      rerender({ data: sampleData(['source', 'other']) });

      const up = pointerEvent('pointerup', { clientX: 250, clientY: 25 });
      act(() => {
        document.dispatchEvent(up);
      });

      expect(onConnect).not.toHaveBeenCalled();
      expect(loggingService.reportError).toHaveBeenCalledTimes(1);
      expect((loggingService.reportError as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(
        expect.objectContaining({ error_name: 'stale-connection-target' }),
      );
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);
    });
  });

  describe('same-task press and release (effect-free listener install)', () => {
    it('hears a pointerup dispatched before passive effects flush, then runs the next drag from its own source', () => {
      const onConnect = vi.fn();
      appendFakeNode('target', { x: 500, y: 500, w: 100, h: 50 });
      mockElementFromPoint();
      const { result } = setupHook({ data: sampleData(), onConnect });

      // Down + up inside ONE act() callback: the passive effect that
      // used to install the document listeners has not run when the
      // pointerup dispatches (a trackpad tap whose up lands before
      // React's effect flush).
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(
            pointerDownEvent({ clientX: 10, clientY: 10, handleEl: makeMockHandle() }),
          );
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 10, clientY: 10 }));
      });

      // The gesture completes instead of jamming: a stuck gesture blocks
      // every later drag and would hand the next drop the wrong source.
      expect(onConnect).not.toHaveBeenCalled();
      expect(result.current.dragState).toBeNull();
      expect(isCanvasGestureActive()).toBe(false);

      act(() => {
        result.current
          .bindHandle('other', 'right')
          .onPointerDown(
            pointerDownEvent({ clientX: 20, clientY: 20, handleEl: makeMockHandle() }),
          );
      });
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 520, clientY: 520 }));
      });
      expect(onConnect).toHaveBeenCalledTimes(1);
      expect(onConnect).toHaveBeenCalledWith('other', 'target');
    });
  });

  describe('selection suppression', () => {
    const MARK = 'tocb-canvas-gesture';
    const start = (result: ReturnType<typeof setupHook>['result']) => {
      const e = pointerDownEvent({ clientX: 100, clientY: 50, handleEl: makeMockHandle() });
      act(() => {
        result.current.bindHandle('source', 'right').onPointerDown(e);
      });
    };

    it('suppresses text selection from the press until the drop', () => {
      const { result } = setupHook({ data: sampleData(), onConnect: vi.fn() });
      start(result);
      expect(document.documentElement.classList.contains(MARK)).toBe(true);
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 5, clientY: 5 }));
      });
      expect(document.documentElement.classList.contains(MARK)).toBe(false);
    });

    it('clears text that was highlighted before the press', () => {
      document.body.innerHTML = '<h1 id="t">Chart title</h1>';
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('t')!);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      const { result } = setupHook({ data: sampleData(), onConnect: vi.fn() });
      start(result);
      expect(window.getSelection()!.toString()).toBe('');
    });

    it.each([
      ['pointercancel', () => pointerEvent('pointercancel', {})],
      ['Escape', () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })],
    ])('restores selection on %s', (_name, make) => {
      const { result } = setupHook({ data: sampleData(), onConnect: vi.fn() });
      start(result);
      act(() => {
        document.dispatchEvent(make());
      });
      expect(document.documentElement.classList.contains(MARK)).toBe(false);
    });

    it('restores selection when the hook unmounts mid-drag', () => {
      const { result, unmount } = setupHook({ data: sampleData(), onConnect: vi.fn() });
      start(result);
      unmount();
      expect(document.documentElement.classList.contains(MARK)).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('clears isCanvasGestureActive when the hook unmounts mid-drag', () => {
      const onConnect = vi.fn();
      const { result, unmount } = setupHook({ data: sampleData(), onConnect });

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(pointerDownEvent({ clientX: 50, clientY: 25, handleEl: handle }));
      });

      expect(isCanvasGestureActive()).toBe(true);
      unmount();
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
        'pointerup',
        () => document.dispatchEvent(pointerEvent('pointerup', { clientX: 9, clientY: 9 })),
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
      const { result } = setupHook({ data: sampleData(), onConnect: vi.fn() });
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(
            pointerDownEvent({ clientX: 50, clientY: 25, handleEl: makeMockHandle() }),
          );
      });
      act(end);
      expect(isCanvasGestureActive()).toBe(false);

      act(() => setCanvasGestureActive(true));
      act(strayEvents);
      expect(isCanvasGestureActive()).toBe(true);
    });

    it('are released when the hook unmounts mid-drag', () => {
      const { result, unmount } = setupHook({ data: sampleData(), onConnect: vi.fn() });
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(
            pointerDownEvent({ clientX: 50, clientY: 25, handleEl: makeMockHandle() }),
          );
      });
      unmount();
      expect(isCanvasGestureActive()).toBe(false);

      act(() => setCanvasGestureActive(true));
      act(strayEvents);
      expect(isCanvasGestureActive()).toBe(true);
    });
  });

  describe('a throwing onConnect', () => {
    it('still ends the gesture, so the next drag can start', () => {
      const onConnect = vi.fn(() => {
        throw new Error('onConnect failed');
      });
      appendFakeNode('target', { x: 200, y: 0, w: 100, h: 50 });
      mockElementFromPoint();
      const { result } = setupHook({ data: sampleData(), onConnect });
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(
            pointerDownEvent({ clientX: 50, clientY: 25, handleEl: makeMockHandle() }),
          );
      });

      // jsdom reports an exception thrown by a listener as a window `error` event.
      const errors: unknown[] = [];
      const onError = (e: ErrorEvent) => {
        e.preventDefault();
        errors.push(e.error);
      };
      window.addEventListener('error', onError);
      act(() => {
        document.dispatchEvent(pointerEvent('pointerup', { clientX: 250, clientY: 25 }));
      });
      window.removeEventListener('error', onError);

      expect(errors).toEqual([expect.objectContaining({ message: 'onConnect failed' })]);
      expect(isCanvasGestureActive()).toBe(false);
      expect(result.current.dragState).toBeNull();
    });
  });

  describe('isActive flag', () => {
    it('exposes isActive=true while drag is in flight, false otherwise', () => {
      const onConnect = vi.fn();
      const { result } = setupHook({ data: sampleData(), onConnect });
      mockElementFromPoint();

      expect(result.current.isActive).toBe(false);

      const handle = makeMockHandle();
      act(() => {
        result.current
          .bindHandle('source', 'right')
          .onPointerDown(pointerDownEvent({ clientX: 50, clientY: 25, handleEl: handle }));
      });

      expect(result.current.isActive).toBe(true);

      const up = pointerEvent('pointerup', { clientX: 999, clientY: 999 });
      act(() => {
        document.dispatchEvent(up);
      });

      expect(result.current.isActive).toBe(false);
    });
  });
});
