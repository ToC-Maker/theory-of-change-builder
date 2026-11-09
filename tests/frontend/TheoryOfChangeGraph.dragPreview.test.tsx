// Live preview of the other nodes making room while a node is dragged over
// a column. The shifted nodes render at their make-room positions as a
// render-time override: nothing is written to the data, the parent is told
// of nothing, and the nodes return when the pointer leaves the column or
// the drag is cancelled.
//
// Layout: column 0-0 holds the dragged n-1 (centre 200) and n-2 (centre
// 500); column 0-1 holds n-3 (centre 300) and n-4 (centre 400). jsdom
// measures no heights, so every node is the renderer's 76px default.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { cleanup, act } from '@testing-library/react';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import type { ToCData } from '../../src/types';
import {
  move,
  nodeWrapper,
  pointer,
  pressEscape,
  rect,
  startDrag as startCanvasDrag,
  stubCanvasLayout,
} from './helpers/dragCanvas';

const node = (id: string, yPosition: number) => ({
  id,
  title: id,
  text: '',
  connectionIds: [],
  connections: [],
  yPosition,
});

const makeData = (): ToCData => ({
  title: 'Test',
  sections: [
    {
      title: 'Inputs',
      columns: [
        { nodes: [node('n-1', 200), node('n-2', 500)] },
        { nodes: [node('n-3', 300), node('n-4', 400)] },
      ],
    },
  ],
});

const COLUMN_TOP = 100;
const NODE_TOP = 262;

beforeEach(() => {
  stubCanvasLayout({
    columns: { '0-0': [50, 250], '0-1': [274, 474] },
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

// Grab 30px below the node's top edge.
const startDrag = (onDataChange?: (data: ToCData) => void) =>
  startCanvasDrag(makeData(), { id: 'n-1', x: 100, y: NODE_TOP + 30 }, onDataChange);

const tops = (...ids: string[]) => ids.map((id) => nodeWrapper(id).style.top);

// Pointer at container y 420 over column 0-1: column-local 320, grab offset
// 30 → landing centre 328, box 290..366. n-3 (above its centre) moves up to
// bottom 274 → centre 236 → top 198; n-4 (below) moves down to top 382.
const OVER_COLUMN_1 = [350, 420] as const;

describe('TheoryOfChangeGraph live make-room preview', { timeout: 20_000 }, () => {
  it('renders no shift before the drag leaves the tap dead-zone', async () => {
    await startDrag();
    move(102, NODE_TOP + 31);
    expect(tops('n-3', 'n-4')).toEqual(['262px', '362px']);
  });

  it('shifts the crowded nodes of the target column to their make-room positions', async () => {
    await startDrag();
    move(...OVER_COLUMN_1);
    expect(tops('n-3', 'n-4')).toEqual(['198px', '382px']);
  });

  it('leaves the nodes of other columns where they are', async () => {
    await startDrag();
    move(...OVER_COLUMN_1);
    // n-1 is the dragged node (still at its slot), n-2 sits in column 0-0.
    expect(tops('n-1', 'n-2')).toEqual(['162px', '462px']);
  });

  it('leaves clear nodes where they are', async () => {
    await startDrag();
    // Landing centre 128 (pointer column-local 120): both nodes are clear
    // of box 90..166, since n-3 starts at 262.
    move(350, 220);
    expect(tops('n-3', 'n-4')).toEqual(['262px', '362px']);
  });

  it('writes nothing to the data while dragging', async () => {
    const onDataChange = vi.fn();
    await startDrag(onDataChange);
    move(...OVER_COLUMN_1);
    await act(async () => {});
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it('follows the pointer: the shifts are recomputed as it moves', async () => {
    await startDrag();
    move(...OVER_COLUMN_1);
    // Landing centre 428 (box 390..466): both nodes are above it now. n-4
    // (362..438) must end at bottom 374 → top 298, and pulls n-3 (262..338)
    // up to bottom 282 → top 206.
    move(350, 520);
    expect(tops('n-3', 'n-4')).toEqual(['206px', '298px']);
  });

  it('returns the nodes when the pointer leaves the column', async () => {
    await startDrag();
    move(...OVER_COLUMN_1);
    move(262, 420); // the gap between the columns
    expect(tops('n-3', 'n-4')).toEqual(['262px', '362px']);
  });

  it('returns the nodes on Escape', async () => {
    await startDrag();
    move(...OVER_COLUMN_1);
    pressEscape();
    expect(tops('n-3', 'n-4')).toEqual(['262px', '362px']);
  });

  it('returns the nodes when the pointer is cancelled', async () => {
    await startDrag();
    move(...OVER_COLUMN_1);
    act(() => void document.dispatchEvent(pointer('pointercancel', ...OVER_COLUMN_1)));
    expect(tops('n-3', 'n-4')).toEqual(['262px', '362px']);
  });

  it('makes room in the node’s own column without counting its original slot', async () => {
    await startDrag();
    // Column 0-0, pointer column-local 472 → landing centre 480 (box 442..518).
    // n-2 (462..538) is below → top 534. n-1's own slot pushes nothing.
    move(100, 572);
    expect(tops('n-2')).toEqual(['534px']);
    expect(tops('n-1')).toEqual(['162px']);
  });

  it('eases the nodes while a drag is under way and not otherwise', async () => {
    await startDrag();
    expect(nodeWrapper('n-3').className).not.toContain('transition');
    move(...OVER_COLUMN_1);
    expect(nodeWrapper('n-3').className).toContain('transition-[top]');
    expect(nodeWrapper('n-3').className).toContain('motion-reduce:transition-none');
    pressEscape();
    expect(nodeWrapper('n-3').className).not.toContain('transition');
  });
});
