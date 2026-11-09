// Dropping a node commits the dropped node and every node that made room
// for it in ONE change, so one undo step reverts the whole drop, and the
// result is what the live preview showed.
//
// Layout: column 0-0 holds the dragged n-1 (centre 200) and n-2 (centre
// 500); column 0-1 holds n-3 (centre 300) and n-4 (centre 400). jsdom
// measures no heights, so every node is the renderer's 76px default.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, cleanup, fireEvent } from '@testing-library/react';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import type { ChartInput, ToCData } from '../../src/types';
import {
  move,
  nodeWrapper,
  release,
  rect,
  startDrag,
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

const makeData = (): ChartInput => ({
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

const NODE_TOP = 262;

beforeEach(() => {
  stubCanvasLayout({
    columns: { '0-0': [50, 250], '0-1': [274, 474] },
    columnTop: 100,
    columnBottom: 900,
    grabbed: { id: 'n-1', rect: rect(50, NODE_TOP, 242, NODE_TOP + 76), width: 192 },
  });
});

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  vi.restoreAllMocks();
});

const grab = { id: 'n-1', x: 100, y: NODE_TOP + 30 };
const yOf = (data: ToCData, id: string) =>
  data.sections[0].columns.flatMap((c) => c.nodes).find((n) => n.id === id)?.yPosition;
const idsIn = (data: ToCData, column: number) =>
  data.sections[0].columns[column].nodes.map((n) => n.id);

// Pointer at container y 420 over column 0-1: column-local 320, grab offset
// 30 → landing centre 328. n-3 moves up to centre 236, n-4 down to 420.
const OVER_COLUMN_1 = [350, 420] as const;

describe('TheoryOfChangeGraph drop commit', { timeout: 20_000 }, () => {
  it('writes the dropped node and every shifted node in one change', async () => {
    const { onCommit } = await startDrag(makeData(), grab);
    move(...OVER_COLUMN_1);
    await release(...OVER_COLUMN_1);

    expect(onCommit).toHaveBeenCalledTimes(1);
    const next = onCommit.mock.calls[0][0];
    expect(idsIn(next, 0)).toEqual(['n-2']);
    expect(idsIn(next, 1).sort()).toEqual(['n-1', 'n-3', 'n-4']);
    expect(yOf(next, 'n-1')).toBe(328);
    expect(yOf(next, 'n-3')).toBe(236);
    expect(yOf(next, 'n-4')).toBe(420);
    // Nodes that did not move keep their position.
    expect(yOf(next, 'n-2')).toBe(500);
  });

  it('lands the nodes where the preview showed them', async () => {
    await startDrag(makeData(), grab);
    move(...OVER_COLUMN_1);
    const previewTops = ['n-3', 'n-4'].map((id) => nodeWrapper(id).style.top);
    await release(...OVER_COLUMN_1);
    expect(['n-3', 'n-4'].map((id) => nodeWrapper(id).style.top)).toEqual(previewTops);
    // The dropped node sits where the copy was: centre 328 → top 290.
    expect(nodeWrapper('n-1').style.top).toBe('290px');
  });

  it('is undone by one undo', async () => {
    const { doc, onCommit } = await startDrag(makeData(), grab);
    const before = doc.getCommitted();
    move(...OVER_COLUMN_1);
    await release(...OVER_COLUMN_1);
    expect(onCommit).toHaveBeenCalledTimes(1);

    act(() => doc.undo());

    // One undo is all it took: nothing is left to undo, and the chart is
    // the one from before the drop.
    expect(doc.getStatus().canUndo).toBe(false);
    expect(doc.getCommitted()).toEqual(before);

    const columns = [...document.querySelectorAll('[data-column]')];
    const idsOf = (key: string) =>
      [
        ...columns
          .find((c) => (c as HTMLElement).dataset.column === key)!
          .querySelectorAll('[id^="node-"]'),
      ]
        .map((el) => el.id)
        .sort();
    expect(idsOf('0-0')).toEqual(['node-n-1', 'node-n-2']);
    expect(idsOf('0-1')).toEqual(['node-n-3', 'node-n-4']);
    expect(['n-1', 'n-2', 'n-3', 'n-4'].map((id) => nodeWrapper(id).style.top)).toEqual([
      '162px',
      '462px',
      '262px',
      '362px',
    ]);
  });

  it('makes room in the same column too, in one change', async () => {
    const { onCommit } = await startDrag(makeData(), grab);
    // Column 0-0, landing centre 480 (box 442..518): n-2 (462..538) → top 534.
    move(100, 572);
    await release(100, 572);

    expect(onCommit).toHaveBeenCalledTimes(1);
    const next = onCommit.mock.calls[0][0];
    expect(yOf(next, 'n-1')).toBe(480);
    expect(yOf(next, 'n-2')).toBe(572);
    expect(idsIn(next, 1)).toEqual(['n-3', 'n-4']);
    expect(yOf(next, 'n-3')).toBe(300);
  });

  it('writes the pushed-down landing spot when the nodes above cannot make room', async () => {
    // Column 0-1 holds 'top' (12..88), too near the column top to move up
    // out of the way of a landing box at 90..166 (pointer column-local 120,
    // grab offset 30 → centre 128). 'top' settles at the column top (centre
    // 38) and the landing spot moves down to 130, not the raw 128.
    const initial = (): ChartInput => ({
      title: 'Test',
      sections: [
        { title: 'Inputs', columns: [{ nodes: [node('n-1', 200)] }, { nodes: [node('top', 50)] }] },
      ],
    });
    const { onCommit } = await startDrag(initial(), grab);
    move(350, 220);
    await release(350, 220);

    expect(onCommit).toHaveBeenCalledTimes(1);
    const next = onCommit.mock.calls[0][0];
    expect(yOf(next, 'n-1')).toBe(130);
    expect(yOf(next, 'top')).toBe(38);
  });

  it('shifts nothing when the drop creates a new column', async () => {
    const { onCommit } = await startDrag(makeData(), grab);
    move(262, 420); // the gap between the two columns
    await release(262, 420);

    expect(onCommit).toHaveBeenCalledTimes(1);
    const next = onCommit.mock.calls[0][0];
    expect(next.sections[0].columns.map((c) => c.nodes.map((n) => n.id))).toEqual([
      ['n-2'],
      ['n-1'],
      ['n-3', 'n-4'],
    ]);
    expect(yOf(next, 'n-3')).toBe(300);
    expect(yOf(next, 'n-4')).toBe(400);
  });

  it('commits nothing when the drag is cancelled', async () => {
    const { onCommit } = await startDrag(makeData(), grab);
    move(...OVER_COLUMN_1);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
