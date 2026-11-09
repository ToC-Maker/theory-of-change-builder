// PR #34 follow-up (zoom coordinate-space mismatch): `refresh()` used to
// store snapshot rects as RAW viewport deltas (`gBCR(col) - gBCR(container)`),
// while `classifyRegion`'s input points are zoom-divided by the drag hook
// (`(clientX - containerRect.left) / zoomScale` → content-space). At
// fit-zoom ~0.633 every drag-drop landed ~30-300px off and frequently in
// the adjacent column.
//
// Invariant pinned here: **the snapshot is content-space** (zoom-
// normalized). `refresh()` divides every viewport delta by the zoom
// scale, so snapshot rects line up with (a) the hook's zoom-divided
// classify points, (b) `node.yPosition` data coordinates, and (c)
// waypoint coordinates — one coordinate space for the whole
// classify/drop path. A bonus property: content-space rects are
// zoom-invariant, so a zoom change alone never requires a rect reseed.
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { useGraphLayout, classifyRegion } from '../../src/hooks/useGraphLayout';
import type { ToCData } from '../../src/types';

afterEach(() => {
  cleanup();
});

const ZOOM = 0.5;

// Content-space geometry (what the CSS layout / node data uses):
//   container at viewport (10, 20), columns inside a scale(0.5) wrapper.
//   Column 0-0: content rect left 100..300, top 50..850 (rel. container).
//   One node in it: content top 170..230.
// Viewport gBCRs are therefore the content values × ZOOM, offset by the
// container's viewport origin.
const CONTAINER_LEFT = 10;
const CONTAINER_TOP = 20;

function mockRect(
  el: HTMLElement,
  r: { left: number; top: number; width: number; height: number },
) {
  el.getBoundingClientRect = () =>
    ({
      left: r.left,
      top: r.top,
      right: r.left + r.width,
      bottom: r.top + r.height,
      width: r.width,
      height: r.height,
      x: r.left,
      y: r.top,
      toJSON: () => ({}),
    }) as DOMRect;
}

function buildDom(): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  // Container itself: content size 1600x1700 → viewport 800x850 at 0.5.
  mockRect(container, { left: CONTAINER_LEFT, top: CONTAINER_TOP, width: 800, height: 850 });

  const column = document.createElement('div');
  column.dataset.column = '0-0';
  // Content left 100..300, top 50..850 → viewport deltas ×0.5.
  mockRect(column, {
    left: CONTAINER_LEFT + 100 * ZOOM,
    top: CONTAINER_TOP + 50 * ZOOM,
    width: 200 * ZOOM,
    height: 800 * ZOOM,
  });
  container.appendChild(column);

  const nodeWrapper = document.createElement('div');
  // Content top 170..230 → viewport deltas ×0.5.
  mockRect(nodeWrapper, {
    left: CONTAINER_LEFT + 100 * ZOOM,
    top: CONTAINER_TOP + 170 * ZOOM,
    width: 200 * ZOOM,
    height: 60 * ZOOM,
  });
  column.appendChild(nodeWrapper);

  return container;
}

const data: ToCData = {
  sections: [{ title: 'A', columns: [{ nodes: [] }] }],
};

function renderLayout(containerEl: HTMLDivElement) {
  return renderHook(() =>
    useGraphLayout({
      data,
      containerRef: { current: containerEl },
      columnPadding: 24,
      sectionPadding: 32,
      editMode: true,
      zoomScale: ZOOM,
    }),
  );
}

describe('useGraphLayout snapshot zoom normalization', () => {
  it('stores content-space (zoom-normalized) rects, not raw viewport deltas', () => {
    // Deterministic rAF: run the scheduled refresh synchronously.
    const realRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }) as typeof requestAnimationFrame;
    try {
      const container = buildDom();
      const { result } = renderLayout(container);
      const snap = result.current.getSnapshot();

      expect(snap.columnRects[0][0]).toEqual({ left: 100, right: 300, top: 50, bottom: 850 });
      expect(snap.nodeRects['0-0'][0]).toEqual({ left: 100, right: 300, top: 170, bottom: 230 });
      // Container dimensions follow the same invariant.
      expect(snap.containerWidth).toBe(1600);
      expect(snap.containerHeight).toBe(1700);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
  });

  it('agrees with the zoom-divided points classifyRegion receives from the drag hook', () => {
    const realRaf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }) as typeof requestAnimationFrame;
    try {
      const container = buildDom();
      const { result } = renderLayout(container);
      const snap = result.current.getSnapshot();

      // A cursor over the node at content-space (150, 200): the drag
      // hook computes point = (client - containerOrigin) / zoom.
      const clientX = CONTAINER_LEFT + 150 * ZOOM;
      const clientY = CONTAINER_TOP + 200 * ZOOM;
      const point = {
        x: (clientX - CONTAINER_LEFT) / ZOOM,
        y: (clientY - CONTAINER_TOP) / ZOOM,
      };
      const region = classifyRegion(snap, point);
      // Over the node (content y 170..230), column-local cursor y =
      // 200 - 50 = 150. Pre-fix, the scaled rects made this classify
      // miss the column entirely or hit the wrong band.
      expect(region).toEqual({
        kind: 'over-node',
        sectionIdx: 0,
        columnIdx: 0,
        yPosition: 150,
      });
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
  });
});
