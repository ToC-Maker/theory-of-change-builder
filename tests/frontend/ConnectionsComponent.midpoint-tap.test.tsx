// A connection whose line is only ~10 screen px long (vertically aligned
// nodes in neighbouring columns at the default 24px column gap) is
// covered end to end by the midpoint affordance's hit circle, so the
// line itself can never be clicked. A press on the midpoint that does
// not become a drag must therefore open the connection editor, exactly
// as a click on the line does; a press that becomes a drag still bends
// the connection and must not open it.
//
// Chrome delivers no `click` for a midpoint press (the circle unmounts
// on pointerdown), so these tests drive pointerdown/move/up as the
// browser does and assert on the editor and the waypoint handles. jsdom
// has no layout, so the geometry that makes the line unreachable is not
// exercised here; the gesture contract is.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import type { ToCData } from '../../src/types';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const makeData = (): ToCData => ({
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

function renderAndHoverMidpoint() {
  render(<ToC data={makeData()} showEditButton={true} onDataChange={vi.fn()} />);
  const fatPath = document.querySelector('svg path.cursor-pointer') as SVGPathElement;
  fireEvent.mouseOver(fatPath, { relatedTarget: document.body });
  const midpoint = document.querySelector('[data-tocb-midpoint-handle]') as SVGCircleElement;
  expect(midpoint).toBeTruthy();
  return midpoint;
}

const press = (el: Element, x: number, y: number) =>
  fireEvent.pointerDown(el, { ...POINTER, clientX: x, clientY: y });
const move = (x: number, y: number) =>
  fireEvent.pointerMove(document, { ...POINTER, clientX: x, clientY: y });
const release = (x: number, y: number) =>
  fireEvent.pointerUp(document, { ...POINTER, clientX: x, clientY: y });

describe('midpoint press on a connection', () => {
  it('opens the connection editor when released without moving', () => {
    const midpoint = renderAndHoverMidpoint();

    press(midpoint, 100, 100);
    release(100, 100);

    expect(document.querySelector('.edge-editor')).not.toBeNull();
    expect(document.querySelector('[data-tocb-waypoint-handle]')).toBeNull();
  });

  it('opens the connection editor when released within the move dead-zone', () => {
    const midpoint = renderAndHoverMidpoint();

    press(midpoint, 100, 100);
    move(101, 101);
    release(101, 101);

    expect(document.querySelector('.edge-editor')).not.toBeNull();
  });

  it('bends the connection and opens nothing when it becomes a drag', () => {
    const midpoint = renderAndHoverMidpoint();

    press(midpoint, 100, 100);
    move(140, 100);
    release(140, 100);

    expect(document.querySelector('.edge-editor')).toBeNull();
    expect(document.querySelectorAll('[data-tocb-waypoint-handle]')).toHaveLength(1);
  });

  it('opens nothing when a drag returns to the press point', () => {
    const midpoint = renderAndHoverMidpoint();

    press(midpoint, 100, 100);
    move(140, 100);
    move(100, 100);
    release(100, 100);

    expect(document.querySelector('.edge-editor')).toBeNull();
  });

  it('opens nothing when the press is cancelled with Escape', () => {
    const midpoint = renderAndHoverMidpoint();

    press(midpoint, 100, 100);
    fireEvent.keyDown(document, { key: 'Escape' });
    release(100, 100);

    expect(document.querySelector('.edge-editor')).toBeNull();
  });
});
