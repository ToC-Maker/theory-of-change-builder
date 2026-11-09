// Wiring of the dragged node's copy in the canvas: once a drag has left the
// tap dead-zone the copy snaps into the column under the pointer, centred
// and at the height the drop will place the node, with no line drawn in the
// column. Over a gap between columns it follows the cursor and the gap is
// tinted; it is gone on drop, Escape and unmount.
//
// jsdom has no layout, so the columns', the grabbed node's rects and its
// width are stubbed; everything else (layout snapshot, drag hook, placement
// maths) is the real thing.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, act } from '@testing-library/react';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import type { ToCData } from '../../src/types';
import {
  move,
  pointer,
  pressEscape,
  rect,
  release,
  startDrag as startCanvasDrag,
  stubCanvasLayout,
} from './helpers/dragCanvas';

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

beforeEach(() => {
  // The grabbed node is 192px wide; nothing else has a measured width.
  stubCanvasLayout({
    columns: COLUMN_RECTS,
    columnTop: COLUMN_TOP,
    columnBottom: 900,
    grabbed: { id: 'n-1', rect: rect(50, NODE_TOP, 242, NODE_TOP + 76), width: 192 },
  });
});

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  vi.restoreAllMocks();
});

const indicator = () =>
  document.querySelector<HTMLElement>('[data-testid="drop-landing-indicator"]');
const ghost = () => document.querySelector<HTMLElement>('[data-testid="node-drag-ghost"]');
// The ghost's vertical position is the outer element's `top`; its horizontal
// position is a translateX on the element inside it.
const ghostTop = () => ghost()!.style.top;
const ghostShift = () => (ghost()!.firstElementChild as HTMLElement).style.transform;

// Grab 30px below the node's top edge.
const startDrag = (onDataChange?: (data: ToCData) => void) =>
  startCanvasDrag(makeData(), { id: 'n-1', x: 100, y: NODE_TOP + 30 }, onDataChange);

// The first ToC render in a worker pays the lazy-import and JIT warm-up, which
// can pass the 5s default on a busy machine.
describe('TheoryOfChangeGraph dragged node copy', { timeout: 20_000 }, () => {
  it('is absent before the pointer leaves the tap dead-zone', async () => {
    await startDrag();
    move(102, NODE_TOP + 31);
    expect(ghost()).toBeNull();
    expect(indicator()).toBeNull();
  });

  it('snaps into the column under the pointer, centred, at the height the drop will use', async () => {
    await startDrag();
    // Cursor over column 0-0 at container y 400 = column-local 300; grab
    // offset 30 → node top at column-local 270 → container y 370. The
    // column's centre is 150, so the 192px copy starts at 54.
    move(100, 400);
    expect(ghostTop()).toBe('370px');
    expect(ghostShift()).toBe('translateX(54px)');
  });

  it('draws no line in the column', async () => {
    await startDrag();
    move(100, 400);
    expect(indicator()).toBeNull();
  });

  it('snaps into another column when the pointer crosses into it', async () => {
    await startDrag();
    move(100, 400);
    move(350, 500);
    // Column 0-1 centre is 374; column-local 400 - 30 = 370 → container y 470.
    expect(ghostShift()).toBe('translateX(278px)');
    expect(ghostTop()).toBe('470px');
  });

  it('tracks vertical pointer moves within the column at once', async () => {
    await startDrag();
    move(100, 400);
    move(120, 450);
    expect(ghostTop()).toBe('420px');
    expect(ghostShift()).toBe('translateX(54px)');
  });

  it('glides only sideways, only while snapped: the vertical position never transitions', async () => {
    await startDrag();
    move(100, 400);
    expect(ghost()!.className).not.toContain('transition');
    expect(ghost()!.firstElementChild!.className).toContain('transition-transform');
    expect(ghost()!.firstElementChild!.className).toContain('motion-reduce:transition-none');
    // Over a gap the copy follows the cursor, so it must not lag behind it.
    move(262, 450);
    expect(ghost()!.firstElementChild!.className).not.toContain('transition');
  });

  it('highlights the gap between two columns and follows the cursor there', async () => {
    await startDrag();
    move(262, 450);
    const el = indicator();
    expect(el!.dataset.kind).toBe('gutter');
    expect(el!.style.left).toBe('250px');
    expect(el!.style.width).toBe('24px');
    // Grab point (50, 30) stays under the cursor: left 262 - 50, top 450 - 30.
    expect(ghostShift()).toBe('translateX(212px)');
    expect(ghostTop()).toBe('420px');
  });

  it('follows the cursor outside every drop region', async () => {
    await startDrag();
    // Below the columns (y > 900): no region.
    move(100, 950);
    expect(indicator()).toBeNull();
    expect(ghostShift()).toBe('translateX(50px)');
    expect(ghostTop()).toBe('920px');
  });

  it('is removed on Escape', async () => {
    await startDrag();
    move(100, 400);
    expect(ghost()).not.toBeNull();
    pressEscape();
    expect(ghost()).toBeNull();
  });

  it('is removed on drop, with the gap tint', async () => {
    await startDrag();
    move(262, 450);
    expect(ghost()).not.toBeNull();
    expect(indicator()).not.toBeNull();
    await release(262, 450);
    expect(ghost()).toBeNull();
    expect(indicator()).toBeNull();
  });

  it('is removed when the pointer is cancelled', async () => {
    await startDrag();
    move(100, 400);
    expect(ghost()).not.toBeNull();
    act(() => void document.dispatchEvent(pointer('pointercancel', 100, 400)));
    expect(ghost()).toBeNull();
  });

  it('dropping on another column moves the node there and leaves the previous state intact', async () => {
    const onDataChange = vi.fn();
    await startDrag(onDataChange);
    move(300, 400);
    await release(300, 400);
    expect(onDataChange).toHaveBeenCalledTimes(1);
    const next = onDataChange.mock.calls[0][0] as ToCData;
    expect(next.sections[0].columns.map((c) => c.nodes.map((n) => n.id))).toEqual([[], ['n-1']]);
  });

  it('is gone when the canvas unmounts mid-drag', async () => {
    await startDrag();
    move(100, 400);
    expect(ghost()).not.toBeNull();
    cleanup();
    expect(ghost()).toBeNull();
  });
});
