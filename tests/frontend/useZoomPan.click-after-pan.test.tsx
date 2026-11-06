// A pan drag that starts on a clickable canvas element must not also fire
// that element's click on release.
//
// Panning moves the content with the cursor, so the element pressed
// (a "+ Column" / "+ Section" gutter, a section title, ...) is still under
// the pointer at `mouseup`: the browser dispatches a `click` on it, and the
// gutter adds a column or section the user never asked for. `useZoomPan`
// swallows the click that immediately follows a pan which travelled past the
// shared tap dead-zone (`MOVE_THRESHOLD_PX`), and leaves plain clicks alone.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, act, cleanup, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { useZoomPan } from '../../src/hooks/useZoomPan';
import { MOVE_THRESHOLD_PX } from '../../src/hooks/usePointerDrag';
import { GutterAffordance } from '../../src/components/canvas/GutterAffordance';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
});

function Harness({ onAdd, zoomRef }: { onAdd: () => void; zoomRef: { zoomIn?: () => void } }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const { zoomIn } = useZoomPan({
    containerSize: { width: 800, height: 600 },
    containerRef,
    // Mirror App.tsx: only buttons / nodes / editors are excluded; a gutter
    // is a plain div, so a press on it pans.
    excludeFromPan: () => false,
  });
  zoomRef.zoomIn = zoomIn;
  return <GutterAffordance kind="column" width={48} onClick={onAdd} testId="gutter" />;
}

function setup() {
  const onAdd = vi.fn();
  const zoomRef: { zoomIn?: () => void } = {};
  const utils = render(<Harness onAdd={onAdd} zoomRef={zoomRef} />);
  // Panning only arms once zoomed past fit.
  act(() => zoomRef.zoomIn!());
  return { onAdd, gutter: utils.getByTestId('gutter') };
}

/** One press / optional move / release, then the browser's trailing click. */
function gesture(
  gutter: HTMLElement,
  { dx = 0, dy = 0, detail = 1 }: { dx?: number; dy?: number; detail?: number } = {},
) {
  act(() => {
    gutter.dispatchEvent(
      new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: 100,
        clientY: 100,
      }),
    );
  });
  if (dx !== 0 || dy !== 0) {
    act(() => {
      document.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 100 + dx, clientY: 100 + dy }),
      );
    });
  }
  act(() => {
    gutter.dispatchEvent(
      new MouseEvent('mouseup', { bubbles: true, clientX: 100 + dx, clientY: 100 + dy }),
    );
  });
  fireEvent.click(gutter, { detail, clientX: 100 + dx, clientY: 100 + dy });
}

describe('useZoomPan: click that follows a pan', () => {
  it('a plain click (no movement) still activates the gutter exactly once', () => {
    const { onAdd, gutter } = setup();
    gesture(gutter);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('a press-drag past the dead-zone pans and does not activate the gutter on release', () => {
    const { onAdd, gutter } = setup();
    gesture(gutter, { dx: 60, dy: 40 });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('suppresses a drag along either axis alone', () => {
    const { onAdd, gutter } = setup();
    gesture(gutter, { dx: MOVE_THRESHOLD_PX + 1 });
    gesture(gutter, { dy: -(MOVE_THRESHOLD_PX + 1) });
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('keeps clicks whose pointer jitter stays inside the dead-zone', () => {
    const { onAdd, gutter } = setup();
    gesture(gutter, { dx: MOVE_THRESHOLD_PX, dy: -MOVE_THRESHOLD_PX });
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('only swallows the click of the drag itself: the next click and keyboard activation work', async () => {
    const { onAdd, gutter } = setup();
    gesture(gutter, { dx: 60 });
    expect(onAdd).not.toHaveBeenCalled();

    // The suppression is cleared once the release's own click had its chance,
    // so a later keyboard activation (a click with detail 0 and no preceding
    // press) and a later plain click both go through.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(gutter, { detail: 0 });
    expect(onAdd).toHaveBeenCalledTimes(1);
    gesture(gutter);
    expect(onAdd).toHaveBeenCalledTimes(2);
  });
});
