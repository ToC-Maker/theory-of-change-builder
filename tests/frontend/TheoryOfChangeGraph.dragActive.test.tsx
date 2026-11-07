// The canvas tells its parent when a pointer gesture is in flight: App pauses
// the poll while the flag is set, so a chart does not land under a drag. A node
// drag, a connection drag and a bend drag each have their own hook; every one of
// them has to reach `onDragActiveChange`, and the flag has to clear when the
// gesture ends or the canvas unmounts mid-gesture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent } from '@testing-library/react';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import type { ChartInput } from '../../src/types';
import { renderToC } from './helpers/renderToC';

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const chart = (): ChartInput => ({
  title: 'Test',
  sections: [
    {
      title: 'Inputs',
      columns: [
        {
          nodes: [
            {
              id: 'n-source',
              title: 'Source',
              text: '',
              connectionIds: [],
              connections: [{ targetId: 'n-target', confidence: 75 }],
              yPosition: 100,
            },
            {
              id: 'n-target',
              title: 'Target',
              text: '',
              connectionIds: [],
              connections: [],
              yPosition: 200,
            },
          ],
        },
      ],
    },
  ],
});

const POINTER = { pointerId: 1, button: 0 };
const press = (el: Element) =>
  fireEvent.pointerDown(el, { ...POINTER, clientX: 100, clientY: 100 });
const release = () => fireEvent.pointerUp(document, { ...POINTER, clientX: 140, clientY: 100 });

function startNodeDrag() {
  press(document.getElementById('node-n-source')!);
}

function startConnectionDrag() {
  // The drop looks for a node under the pointer; there is none.
  document.elementFromPoint = vi.fn(() => null);
  fireEvent.mouseEnter(document.querySelector('[data-tocb-node="n-source"]')!);
  press(document.querySelector('[data-tocb-connection-handle="n-source|right"]')!);
}

function startBendDrag() {
  const path = document.querySelector('svg path.cursor-pointer')!;
  fireEvent.mouseOver(path, { relatedTarget: document.body });
  press(document.querySelector('[data-tocb-midpoint-handle]')!);
}

const gestures: [string, () => void][] = [
  ['a node drag', startNodeDrag],
  ['a connection drag', startConnectionDrag],
  ['a bend drag', startBendDrag],
];

describe('the canvas reports pointer gestures through onDragActiveChange', () => {
  it.each(gestures)(
    '%s sets the flag when it starts and clears it when it ends',
    (_name, start) => {
      const onDragActiveChange = vi.fn<(isActive: boolean) => void>();
      renderToC(chart(), { onDragActiveChange });
      expect(onDragActiveChange).toHaveBeenLastCalledWith(false);

      start();
      expect(onDragActiveChange).toHaveBeenLastCalledWith(true);

      release();
      expect(onDragActiveChange).toHaveBeenLastCalledWith(false);
      expect(onDragActiveChange.mock.calls.filter(([active]) => active)).toHaveLength(1);
    },
  );

  it.each(gestures)('%s is not left set when the canvas unmounts mid-gesture', (_name, start) => {
    const onDragActiveChange = vi.fn<(isActive: boolean) => void>();
    const { unmount } = renderToC(chart(), { onDragActiveChange });

    start();
    expect(onDragActiveChange).toHaveBeenLastCalledWith(true);
    unmount();

    expect(onDragActiveChange).toHaveBeenLastCalledWith(false);
  });
});
