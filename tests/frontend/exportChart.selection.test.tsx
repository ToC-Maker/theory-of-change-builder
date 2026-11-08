// A PNG/PDF export shows the whole chart as published: whatever the canvas
// is currently highlighting (a selected node and the faded rest of the
// chart, a hovered node, a hovered or selected connection) is cleared for
// the capture and the selection is put back once it is taken.
//
// html-to-image is mocked so `toPng` reports what the DOM looks like at the
// moment the capture starts; the canvas is the real ToC.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import { exportToPng } from '../../src/utils/exportChart';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import { deepFreeze } from './helpers/deepFreeze';
import type { ToCData } from '../../src/types';

interface CaptureView {
  selectedNodes: string[];
  dimmedNodes: string[];
  hoverTintedNodes: string[];
  fadedConnections: number;
  glowingConnections: number;
  transitionsDisabled: boolean;
}

const { captured, state } = vi.hoisted(() => ({
  captured: [] as CaptureView[],
  state: { root: null as HTMLElement | null },
}));

const nodeIdsWithClass = (root: HTMLElement, cls: string) =>
  [...root.querySelectorAll<HTMLElement>('[data-tocb-node]')]
    .filter((el) => el.className.split(/\s+/).includes(cls))
    .map((el) => el.getAttribute('data-tocb-node')!);

function readView(root: HTMLElement): CaptureView {
  // The visible connection paths are the ones with an arrowhead outside the
  // excluded editing aids; the glow layer is the one blurred behind them.
  const arrows = [...root.querySelectorAll<SVGPathElement>('svg path[marker-end]')].filter(
    (p) => !p.closest('[data-export-exclude]'),
  );
  return {
    selectedNodes: nodeIdsWithClass(root, 'ring-black'),
    dimmedNodes: nodeIdsWithClass(root, 'opacity-30'),
    hoverTintedNodes: nodeIdsWithClass(root, 'from-indigo-25'),
    fadedConnections: arrows.filter((p) => p.style.opacity === '0.01').length,
    glowingConnections: arrows.filter(
      (p) => p.style.filter === 'blur(3px)' && p.style.opacity === '1',
    ).length,
    transitionsDisabled: [...document.querySelectorAll('style')].some((s) =>
      /transition:\s*none/.test(s.textContent ?? ''),
    ),
  };
}

vi.mock('html-to-image', () => ({
  toPng: vi.fn(async () => {
    captured.push(readView(state.root!));
    return 'data:image/png;base64,AAAA';
  }),
  toCanvas: vi.fn(),
  getFontEmbedCSS: vi.fn(async () => ''),
}));

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  document.body.innerHTML = '';
  captured.length = 0;
  vi.restoreAllMocks();
});

// n-a -> n-b are connected; n-c is not connected to either.
const makeData = (): ToCData => ({
  title: 'Test',
  sections: [
    {
      title: 'Inputs',
      columns: [
        {
          nodes: [
            {
              id: 'n-a',
              title: 'A',
              text: '',
              connectionIds: [],
              connections: [{ targetId: 'n-b', confidence: 75 }],
              yPosition: 100,
            },
            { id: 'n-c', title: 'C', text: '', connectionIds: [], yPosition: 300 },
          ],
        },
        {
          nodes: [{ id: 'n-b', title: 'B', text: '', connectionIds: [], yPosition: 100 }],
        },
      ],
    },
  ],
});

async function renderCanvas() {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const view = render(<ToC data={deepFreeze(makeData())} showEditButton={true} />);
  await act(async () => {
    await Promise.resolve();
  });
  state.root = view.container;
  return view;
}

const nodeEl = (id: string) => document.querySelector<HTMLElement>(`[data-tocb-node="${id}"]`)!;

async function runExport() {
  await act(async () => {
    await exportToPng(state.root!, 'chart');
  });
  expect(captured).toHaveLength(1);
  return captured[0];
}

describe('export clears the canvas selection', () => {
  it('captures a chart with no selected node and nothing faded, then selects the node again', async () => {
    await renderCanvas();
    fireEvent.click(nodeEl('n-a'));
    expect(readView(state.root!)).toMatchObject({
      selectedNodes: ['n-a'],
      dimmedNodes: ['n-c'],
      fadedConnections: 0,
    });

    const during = await runExport();

    expect(during).toMatchObject({
      selectedNodes: [],
      dimmedNodes: [],
      hoverTintedNodes: [],
      fadedConnections: 0,
    });
    // The selection is back for the user once the capture is taken.
    expect(readView(state.root!)).toMatchObject({
      selectedNodes: ['n-a'],
      dimmedNodes: ['n-c'],
    });
  });

  it('leaves no connection faded when the selected node has none', async () => {
    await renderCanvas();
    // n-c has no connections, so selecting it fades the n-a -> n-b connection.
    fireEvent.click(nodeEl('n-c'));
    expect(readView(state.root!).fadedConnections).toBe(1);

    const during = await runExport();

    expect(during.fadedConnections).toBe(0);
    expect(readView(state.root!).fadedConnections).toBe(1);
  });

  it('captures a hovered node and a hovered connection as they are published', async () => {
    await renderCanvas();
    fireEvent.mouseEnter(nodeEl('n-c'));
    const hitPath = document.querySelector('path.cursor-pointer')!;
    fireEvent.mouseEnter(hitPath.parentElement!);
    expect(readView(state.root!)).toMatchObject({
      hoverTintedNodes: ['n-c'],
      glowingConnections: 1,
    });

    const during = await runExport();

    expect(during).toMatchObject({ hoverTintedNodes: [], glowingConnections: 0 });
  });

  it('closes a selected connection for the capture and selects it again after', async () => {
    await renderCanvas();
    fireEvent.click(document.querySelector('path.cursor-pointer')!);
    expect(document.querySelector('.edge-editor')).not.toBeNull();

    let editorDuringCapture: Element | null = document.body;
    const { toPng } = await import('html-to-image');
    vi.mocked(toPng).mockImplementationOnce(async () => {
      editorDuringCapture = document.querySelector('.edge-editor');
      return 'data:image/png;base64,AAAA';
    });
    await act(async () => {
      await exportToPng(state.root!, 'chart');
    });

    expect(editorDuringCapture).toBeNull();
    expect(document.querySelector('.edge-editor')).not.toBeNull();
  });

  it('holds transitions off while the cleared state is captured, so nothing is caught mid-fade', async () => {
    await renderCanvas();
    fireEvent.click(nodeEl('n-a'));

    const during = await runExport();

    expect(during.transitionsDisabled).toBe(true);
    expect(readView(state.root!).transitionsDisabled).toBe(false);
  });

  it('puts the selection back even when the capture fails', async () => {
    await renderCanvas();
    fireEvent.click(nodeEl('n-a'));
    const { toPng } = await import('html-to-image');
    vi.mocked(toPng).mockRejectedValueOnce(new Error('boom'));

    await act(async () => {
      await expect(exportToPng(state.root!, 'chart')).rejects.toThrow('boom');
    });

    expect(readView(state.root!).selectedNodes).toEqual(['n-a']);
    expect(readView(state.root!).transitionsDisabled).toBe(false);
  });
});
