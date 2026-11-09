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
import type { ToCData, WaypointOffset } from '../../src/types';
import { deepFreeze } from './helpers/deepFreeze';

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

function makeData(waypoints?: WaypointOffset[]): ToCData {
  return deepFreeze({
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
  });
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

  describe('following changes made by someone else', () => {
    function dataWith(evidence: string, assumptions: string, confidence: number): ToCData {
      return deepFreeze({
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
                    connections: [{ targetId: 'b', confidence, evidence, assumptions }],
                  },
                  { id: 'b', title: 'B', text: '', connectionIds: [] },
                ],
              },
            ],
          },
        ],
      });
    }

    function renderOpenEditor(initial: ToCData) {
      const api = makeMutationApi(initial);
      const anchor = document.createElement('div');
      anchor.id = 'edge-anchor';
      document.body.appendChild(anchor);
      const element = (data: ToCData) => (
        <EdgeEditor
          sourceId="a"
          targetId="b"
          data={data}
          mutate={api.mutate}
          mutateDebounced={api.mutateDebounced}
          commit={api.commit}
          anchorRef={{ current: anchor } as React.RefObject<HTMLElement>}
          camera={{ x: 0, y: 0, z: 1 }}
          onRequestClose={() => {}}
        />
      );
      const utils = render(element(initial));
      return { api, rerenderWith: (data: ToCData) => utils.rerender(element(data)) };
    }

    const evidenceBox = () =>
      screen.getByRole('textbox', { name: /evidence/i }) as HTMLTextAreaElement;
    const assumptionsBox = () =>
      screen.getByRole('textbox', { name: /assumptions/i }) as HTMLTextAreaElement;

    it('shows evidence and assumptions a collaborator saved while the editor was open', () => {
      const { rerenderWith } = renderOpenEditor(dataWith('old evidence', 'old assumptions', 60));

      rerenderWith(dataWith('their evidence', 'their assumptions', 60));

      expect(evidenceBox().value).toBe('their evidence');
      expect(assumptionsBox().value).toBe('their assumptions');
    });

    it('keeps the evidence being typed when a collaborator changes the other fields', () => {
      const { rerenderWith } = renderOpenEditor(dataWith('old evidence', 'old assumptions', 60));

      fireEvent.change(evidenceBox(), { target: { value: 'my evidence' } });
      rerenderWith(dataWith('my evidence', 'their assumptions', 90));

      expect(evidenceBox().value).toBe('my evidence');
      expect(assumptionsBox().value).toBe('their assumptions');
      expect((screen.getByRole('slider', { name: /confidence/i }) as HTMLInputElement).value).toBe(
        '90',
      );
    });
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
      renderEdgeEditor({ data: makeData([{ dx: 10, dy: 20 }]) });
      expect(screen.queryByRole('button', { name: /reset path/i })).toBeNull();
    });

    it('shows with a custom waypoint, calls onResetPath, and does NOT close the editor', () => {
      const onResetPath = vi.fn();
      const onRequestClose = vi.fn();
      renderEdgeEditor({
        data: makeData([{ dx: 10, dy: 20 }]),
        onResetPath,
        onRequestClose,
      });

      const btn = screen.getByRole('button', { name: /reset path/i });
      fireEvent.click(btn);

      expect(onResetPath).toHaveBeenCalledTimes(1);
      expect(onRequestClose).not.toHaveBeenCalled();
    });

    it('is hidden for old absolute {x, y} waypoints, which render as the automatic curve', () => {
      renderEdgeEditor({
        data: makeData([{ x: 10, y: 20 }] as unknown as WaypointOffset[]),
        onResetPath: vi.fn(),
      });
      expect(screen.queryByRole('button', { name: /reset path/i })).toBeNull();
    });

    it('shows for connections carrying several waypoints too', () => {
      renderEdgeEditor({
        data: makeData([
          { dx: 10, dy: 20 },
          { dx: 30, dy: 40 },
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
    // and scrolls; `textarea` is the same pair for its text fields, which
    // differ when their text overflows.
    function fakeLayout(
      opts: {
        midpoint?: Box;
        panel?: Box;
        content?: { scrollHeight: number; clientHeight: number };
        textarea?: { scrollHeight: number; clientHeight: number };
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
      const sizeOf = (el: Element) =>
        opts.textarea && el instanceof HTMLTextAreaElement ? opts.textarea : content;
      vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (
        this: Element,
      ) {
        return sizeOf(this).scrollHeight;
      });
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (
        this: Element,
      ) {
        return sizeOf(this).clientHeight;
      });
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

      function wheelReachingCanvas(target: HTMLElement, init: WheelEventInit) {
        const canvasWheel = vi.fn();
        document.addEventListener('wheel', canvasWheel);
        try {
          fireEvent.wheel(target, init);
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

      it.each([{ ctrlKey: true }, { metaKey: true }])(
        'still zooms the canvas on a wheel with %o over a scrolling panel',
        (modifier) => {
          fakeLayout(scrollingPanel);
          const panel = openPanel();

          expect(wheelReachingCanvas(panel, { deltaY: -100, ...modifier })).toBe(true);
        },
      );

      it('pans the canvas when the panel has nothing to scroll', () => {
        fakeLayout();
        const panel = openPanel();

        expect(wheelReachingCanvas(panel, { deltaY: 100 })).toBe(true);
      });

      // A long evidence text scrolls inside its textarea while the panel
      // around it fits the window.
      it('scrolls a text field whose text overflows instead of panning the canvas', () => {
        fakeLayout({ textarea: { scrollHeight: 300, clientHeight: 80 } });
        openPanel();
        const evidence = screen.getByRole('textbox', { name: /evidence/i });

        expect(wheelReachingCanvas(evidence, { deltaY: 100 })).toBe(false);
      });

      it('pans the canvas over a text field that holds all of its text', () => {
        fakeLayout({ textarea: { scrollHeight: 80, clientHeight: 80 } });
        openPanel();
        const evidence = screen.getByRole('textbox', { name: /evidence/i });

        expect(wheelReachingCanvas(evidence, { deltaY: 100 })).toBe(true);
      });
    });
  });
});
