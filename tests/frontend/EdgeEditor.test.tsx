// Tests for `EdgeEditor` — the unified anchored edge-property editor.
//
// Acceptance gates (per plan §3.3):
//   - Renders when a (sourceId, targetId) edge is selected.
//   - Confidence slider mutates via mutateDebounced + commit on
//     pointerup.
//   - Evidence / assumptions edits buffer locally and commit on blur.
//   - Delete button removes the connection from the source node and
//     fires onRequestClose.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { EdgeEditor } from '../../src/components/edge-editor/EdgeEditor';
import { TOP_BAR_HEIGHT_PX } from '../../src/hooks/useViewportOffset';
import type { ToCData } from '../../src/types';

function makeMutationApi(initial: ToCData) {
  const dataRef = { current: initial };
  const apply = (prev: ToCData, updater: ((p: ToCData) => ToCData) | ToCData): ToCData =>
    typeof updater === 'function' ? (updater as (p: ToCData) => ToCData)(prev) : updater;
  return {
    mutate: vi.fn((updater) => {
      dataRef.current = apply(dataRef.current, updater);
    }),
    mutateDebounced: vi.fn((updater) => {
      dataRef.current = apply(dataRef.current, updater);
    }),
    commit: vi.fn(),
    dataRef,
  };
}

function makeData(waypoints?: Array<{ x: number; y: number }>): ToCData {
  return {
    sections: [
      {
        title: 'S',
        columns: [
          {
            nodes: [
              {
                id: 'a',
                title: 'A',
                text: '',
                connectionIds: ['b'],
                connections: [
                  {
                    targetId: 'b',
                    confidence: 60,
                    evidence: '',
                    assumptions: '',
                    ...(waypoints !== undefined ? { waypoints } : {}),
                  },
                ],
              },
              { id: 'b', title: 'B', text: '', connectionIds: [] },
            ],
          },
        ],
      },
    ],
  };
}

function renderEdgeEditor(props: {
  data?: ToCData;
  api?: ReturnType<typeof makeMutationApi>;
  onRequestClose?: () => void;
  onResetPath?: () => void;
}) {
  const data = props.data ?? makeData();
  const api = props.api ?? makeMutationApi(data);
  const anchor = document.createElement('div');
  anchor.id = 'edge-anchor';
  document.body.appendChild(anchor);
  const anchorRef = { current: anchor } as React.RefObject<HTMLElement>;
  const utils = render(
    <EdgeEditor
      sourceId="a"
      targetId="b"
      data={data}
      mutate={api.mutate}
      mutateDebounced={api.mutateDebounced}
      commit={api.commit}
      anchorRef={anchorRef}
      camera={{ x: 0, y: 0, z: 1 }}
      onRequestClose={props.onRequestClose ?? (() => {})}
      onResetPath={props.onResetPath}
    />,
  );
  return { ...utils, api, anchor };
}

afterEach(() => {
  cleanup();
  document.querySelectorAll('#edge-anchor').forEach((el) => el.remove());
});

describe('EdgeEditor', () => {
  it('renders the current confidence value', () => {
    renderEdgeEditor({});
    const slider = screen.getByRole('slider', { name: /confidence/i }) as HTMLInputElement;
    expect(slider.value).toBe('60');
  });

  it('streams confidence via mutateDebounced; commits on pointerup', () => {
    const { api } = renderEdgeEditor({});
    const slider = screen.getByRole('slider', { name: /confidence/i });

    fireEvent.change(slider, { target: { value: '75' } });
    fireEvent.change(slider, { target: { value: '85' } });

    expect(api.mutateDebounced).toHaveBeenCalledTimes(2);
    const keys = api.mutateDebounced.mock.calls.map((c) => c[1]);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^confidence-/);

    expect(api.commit).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(api.commit).toHaveBeenCalledTimes(1);
    expect(api.commit.mock.calls[0]?.[0]).toMatch(/^confidence-/);
  });

  it('buffers evidence + assumptions and commits on blur', () => {
    const { api } = renderEdgeEditor({});

    const evidence = screen.getByRole('textbox', { name: /evidence/i }) as HTMLTextAreaElement;
    fireEvent.change(evidence, { target: { value: 'new evidence' } });
    fireEvent.blur(evidence);

    const assumptions = screen.getByRole('textbox', {
      name: /assumptions/i,
    }) as HTMLTextAreaElement;
    fireEvent.change(assumptions, { target: { value: 'new assumptions' } });
    fireEvent.blur(assumptions);

    const commitKeys = api.commit.mock.calls.map((c) => c[0]);
    expect(commitKeys.some((k) => typeof k === 'string' && k.startsWith('evidence-'))).toBe(true);
    expect(commitKeys.some((k) => typeof k === 'string' && k.startsWith('assumptions-'))).toBe(
      true,
    );
  });

  describe('Reset path button (PR #34 round-7 issue 78)', () => {
    // Discoverable counterpart of the dblclick-on-handle reset. Only
    // offered when the connection actually HAS a custom waypoint; the
    // action goes through the same `useWaypointDrag.resetWaypoints`
    // seam (threaded in as `onResetPath`), and the editor stays open.

    it('is hidden when the connection has no custom waypoint', () => {
      renderEdgeEditor({ onResetPath: vi.fn() });
      expect(screen.queryByRole('button', { name: /reset path/i })).toBeNull();
    });

    it('is hidden when no onResetPath handler is provided (read-only hosts)', () => {
      renderEdgeEditor({ data: makeData([{ x: 10, y: 20 }]) });
      expect(screen.queryByRole('button', { name: /reset path/i })).toBeNull();
    });

    it('shows with a custom waypoint, calls onResetPath, and does NOT close the editor', () => {
      const onResetPath = vi.fn();
      const onRequestClose = vi.fn();
      renderEdgeEditor({
        data: makeData([{ x: 10, y: 20 }]),
        onResetPath,
        onRequestClose,
      });

      const btn = screen.getByRole('button', { name: /reset path/i });
      fireEvent.click(btn);

      expect(onResetPath).toHaveBeenCalledTimes(1);
      expect(onRequestClose).not.toHaveBeenCalled();
    });

    it('shows for legacy multi-waypoint connections too', () => {
      renderEdgeEditor({
        data: makeData([
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ]),
        onResetPath: vi.fn(),
      });
      expect(screen.getByRole('button', { name: /reset path/i })).toBeTruthy();
    });
  });

  it('deletes the connection and fires onRequestClose', () => {
    const onRequestClose = vi.fn();
    const { api } = renderEdgeEditor({ onRequestClose });

    const del = screen.getByRole('button', { name: /delete connection/i });
    fireEvent.click(del);

    expect(api.mutate).toHaveBeenCalledTimes(1);
    expect(onRequestClose).toHaveBeenCalled();

    const after = api.dataRef.current;
    const aNode = after.sections[0].columns[0].nodes.find((n) => n.id === 'a');
    expect(aNode?.connections ?? []).toEqual([]);
    expect(aNode?.connectionIds).toEqual([]);
  });

  describe('keeping inside the window', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    interface Box {
      left: number;
      top: number;
      width: number;
      height: number;
    }

    // jsdom does no layout: fake a 1000x700 window, a connection midpoint
    // and a panel with the given box and content. `content` is the panel's
    // scrollHeight and clientHeight, which differ when the panel is capped
    // and scrolls.
    function fakeLayout(
      opts: {
        midpoint?: Box;
        panel?: Box;
        content?: { scrollHeight: number; clientHeight: number };
      } = {},
    ) {
      const midpoint = opts.midpoint ?? { left: 900, top: 600, width: 1, height: 1 };
      const panel = opts.panel ?? { left: 0, top: 0, width: 320, height: 330 };
      const content = opts.content ?? { scrollHeight: 328, clientHeight: 328 };
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const r = this.classList.contains('edge-editor') ? panel : midpoint;
        return {
          ...r,
          right: r.left + r.width,
          bottom: r.top + r.height,
          x: r.left,
          y: r.top,
          toJSON: () => ({}),
        } as DOMRect;
      });
      vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(content.scrollHeight);
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(content.clientHeight);
    }

    function openPanel() {
      renderEdgeEditor({});
      return document.querySelector('.edge-editor') as HTMLElement;
    }

    it('moves to the left of the midpoint and up when it would leave the window', () => {
      fakeLayout();
      const panel = openPanel();

      // Right of the point would end at 901 + 12 + 320 > 992: flip left.
      expect(panel.style.left).toBe(`${900 - 12 - 320}px`);
      // 600 + 330 > 692: slide up until the bottom margin.
      expect(panel.style.top).toBe(`${700 - 8 - 330}px`);
    });

    it('caps its height to the usable band and scrolls past it', () => {
      fakeLayout();
      const panel = openPanel();

      // The band runs from the top bar (41) + 8 to the bottom edge - 8.
      expect(panel.style.maxHeight).toBe(`${700 - 8 - (41 + 8)}px`);
      expect(panel.className).toContain('overflow-y-auto');
    });

    it('stays below the top bar when its midpoint is scrolled up behind it', () => {
      fakeLayout({ midpoint: { left: 500, top: -300, width: 1, height: 1 } });
      const panel = openPanel();

      expect(parseFloat(panel.style.top)).toBeGreaterThanOrEqual(TOP_BAR_HEIGHT_PX);
    });

    describe('the mouse wheel', () => {
      // A capped, scrolling panel: its content is far taller than its box.
      const scrollingPanel = {
        panel: { left: 0, top: 0, width: 320, height: 330 },
        content: { scrollHeight: 900, clientHeight: 328 },
      };

      function wheelReachingCanvas(panel: HTMLElement, init: WheelEventInit) {
        const canvasWheel = vi.fn();
        document.addEventListener('wheel', canvasWheel);
        try {
          fireEvent.wheel(panel, init);
        } finally {
          document.removeEventListener('wheel', canvasWheel);
        }
        return canvasWheel.mock.calls.length > 0;
      }

      it('scrolls the panel instead of panning the canvas when the panel can scroll', () => {
        fakeLayout(scrollingPanel);
        const panel = openPanel();

        expect(wheelReachingCanvas(panel, { deltaY: 100 })).toBe(false);
      });

      it('still zooms the canvas on Ctrl+wheel over a scrolling panel', () => {
        fakeLayout(scrollingPanel);
        const panel = openPanel();

        expect(wheelReachingCanvas(panel, { deltaY: -100, ctrlKey: true })).toBe(true);
      });
    });
  });
});
