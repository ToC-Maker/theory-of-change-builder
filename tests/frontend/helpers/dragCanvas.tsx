// Shared scaffolding for tests that drag a node across the rendered canvas.
//
// jsdom has no layout, so the columns' rects, the grabbed node's rect and
// its width are stubbed; everything else (layout snapshot, drag hook,
// placement maths) is the real thing. Container coordinates equal client
// coordinates: the container's own rect is all zeros.
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { ToC } from '../../../src/components/TheoryOfChangeGraph';
import type { ToCData } from '../../../src/types';
import { deepFreeze } from './deepFreeze';

export function rect(left: number, top: number, right: number, bottom: number): DOMRect {
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

export interface CanvasLayout {
  /** `data-column` key (`sectionIdx-columnIdx`) → [left, right]. */
  columns: Record<string, [number, number]>;
  columnTop: number;
  columnBottom: number;
  /** The node the test grabs: its id, rect and measured width. */
  grabbed: { id: string; rect: DOMRect; width: number };
}

/** Stubs the DOM measurements the drag reads. Undo with `vi.restoreAllMocks()`. */
export function stubCanvasLayout(layout: CanvasLayout) {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.id === `node-${layout.grabbed.id}` ? layout.grabbed.width : 0;
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const column = (this as HTMLElement).dataset?.column;
    if (column && layout.columns[column]) {
      const [left, right] = layout.columns[column];
      return rect(left, layout.columnTop, right, layout.columnBottom);
    }
    if (this.id === `node-${layout.grabbed.id}`) return layout.grabbed.rect;
    return rect(0, 0, 0, 0);
  });
}

export function pointer(type: string, x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
  });
  return event;
}

export const move = (x: number, y: number) =>
  act(() => void document.dispatchEvent(pointer('pointermove', x, y)));

export const release = (x: number, y: number) =>
  act(async () => void document.dispatchEvent(pointer('pointerup', x, y)));

export const pressEscape = () =>
  act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

/** The editable canvas on frozen data (an updater that writes into it throws). */
export const canvas = (data: ToCData, onDataChange?: (data: ToCData) => void) => (
  <ToC data={deepFreeze(data)} showEditButton={true} onDataChange={onDataChange} />
);

/**
 * Renders `ui` and presses on the grabbed node at (`x`, `y`). Waits first
 * for the layout hook's rAF-coalesced rect refresh to read the stubbed
 * rects.
 */
export async function startDrag(ui: ReactElement, grab: { id: string; x: number; y: number }) {
  const view = render(ui);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  fireEvent.pointerDown(document.getElementById(`node-${grab.id}`)!, {
    clientX: grab.x,
    clientY: grab.y,
    button: 0,
    pointerId: 1,
  });
  return view;
}

/** The absolutely positioned slot wrapper that carries a node's inline `top`. */
export const nodeWrapper = (id: string) =>
  document.getElementById(`node-${id}`)!.closest('.absolute') as HTMLElement;
