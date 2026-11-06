// Wiring of the drag landing indicator in the canvas: it appears once a
// node drag has left the tap dead-zone, sits where the drop will place the
// node, and is gone on drop, Escape and unmount.
//
// jsdom has no layout, so the columns' and the grabbed node's rects are
// stubbed; everything else (layout snapshot, drag hook, placement maths)
// is the real thing.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import type { ToCData } from '../../src/types';
import { deepFreeze } from './helpers/deepFreeze';

const makeData = (): ToCData => ({
  title: 'Test',
  sections: [
    {
      title: 'Inputs',
      columns: [
        {
          nodes: [
            { id: 'n-1', title: 'A', text: '', connectionIds: [], connections: [], yPosition: 200 },
          ],
        },
        { nodes: [] },
      ],
    },
  ],
});

const COLUMN_RECTS: Record<string, [number, number]> = { '0-0': [50, 250], '0-1': [274, 474] };
const COLUMN_TOP = 100;
const NODE_TOP = 262;

function rect(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const column = (this as HTMLElement).dataset?.column;
    if (column && COLUMN_RECTS[column]) {
      const [left, right] = COLUMN_RECTS[column];
      return rect(left, COLUMN_TOP, right, 900);
    }
    if (this.id === 'node-n-1') return rect(50, NODE_TOP, 242, NODE_TOP + 76);
    return rect(0, 0, 0, 0);
  });
});

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  vi.restoreAllMocks();
});

const indicator = () =>
  document.querySelector<HTMLElement>('[data-testid="drop-landing-indicator"]');

function pointer(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
  });
  return event;
}

async function startDrag(onDataChange?: (data: ToCData) => void) {
  render(<ToC data={deepFreeze(makeData())} showEditButton={true} onDataChange={onDataChange} />);
  // Let the layout hook's rAF-coalesced rect refresh read the stubbed rects.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const node = document.getElementById('node-n-1')!;
  // Grab 30px below the node's top edge.
  fireEvent.pointerDown(node, { clientX: 100, clientY: NODE_TOP + 30, button: 0, pointerId: 1 });
}

const move = (x: number, y: number) =>
  act(() => void document.dispatchEvent(pointer('pointermove', x, y)));

// The first ToC render in a worker pays the lazy-import and JIT warm-up, which
// can pass the 5s default on a busy machine.
describe('TheoryOfChangeGraph drag landing indicator', { timeout: 20_000 }, () => {
  it('is absent before the pointer leaves the tap dead-zone', async () => {
    await startDrag();
    move(102, NODE_TOP + 31);
    expect(indicator()).toBeNull();
  });

  it('shows an insertion line at the dropped node top edge once the drag is under way', async () => {
    await startDrag();
    // Cursor over column 0-0 at container y 400 = column-local 300; grab
    // offset 30 → node top at column-local 270 → container y 370.
    move(100, 400);
    const el = indicator();
    expect(el).not.toBeNull();
    expect(el!.dataset.kind).toBe('line');
    expect(el!.style.left).toBe('50px');
    expect(el!.style.width).toBe('200px');
    // 3px line centred on 370.
    expect(el!.style.top).toBe('368.5px');
  });

  it('follows the cursor into another column', async () => {
    await startDrag();
    move(100, 400);
    move(350, 500);
    const el = indicator();
    expect(el!.style.left).toBe('274px');
    // column-local 400 - 30 = 370 → container y 470.
    expect(el!.style.top).toBe('468.5px');
  });

  it('highlights the gutter when the cursor is between two columns', async () => {
    await startDrag();
    move(262, 400);
    const el = indicator();
    expect(el!.dataset.kind).toBe('gutter');
    expect(el!.style.left).toBe('250px');
    expect(el!.style.width).toBe('24px');
  });

  it('is removed on Escape', async () => {
    await startDrag();
    move(100, 400);
    expect(indicator()).not.toBeNull();
    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(indicator()).toBeNull();
  });

  it('is removed on drop', async () => {
    await startDrag();
    move(100, 400);
    expect(indicator()).not.toBeNull();
    act(() => void document.dispatchEvent(pointer('pointerup', 100, 400)));
    expect(indicator()).toBeNull();
  });

  it('is removed when the pointer is cancelled', async () => {
    await startDrag();
    move(100, 400);
    expect(indicator()).not.toBeNull();
    act(() => void document.dispatchEvent(pointer('pointercancel', 100, 400)));
    expect(indicator()).toBeNull();
  });

  it('dropping on another column moves the node there and leaves the previous state intact', async () => {
    const onDataChange = vi.fn();
    await startDrag(onDataChange);
    move(300, 400);
    await act(async () => {
      document.dispatchEvent(pointer('pointerup', 300, 400));
    });
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const next = onDataChange.mock.calls[0][0] as ToCData;
    expect(next.sections[0].columns.map((c) => c.nodes.map((n) => n.id))).toEqual([[], ['n-1']]);
  });

  it('is gone when the canvas unmounts mid-drag', async () => {
    await startDrag();
    move(100, 400);
    expect(indicator()).not.toBeNull();
    cleanup();
    expect(indicator()).toBeNull();
  });
});
