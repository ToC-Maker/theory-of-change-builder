// Tests for `NodeEditor` — the unified anchored node-property editor.
//
// Acceptance gates (per plan §3.2):
//   - Single-select: header omits the count.
//   - Multi-select: header shows "Editing N nodes".
//   - Click outside → closes (the parent's onRequestClose fires).
//   - Buffered title/details flush on unmount (cleanup effect calls
//     `commitTitle()` + `commitDetails()`).
//   - `onDragStartedElsewhere` callback closes the editor when invoked
//     (this is the seam PR 4 uses to dismiss the editor when a node
//     drag starts somewhere else on the canvas).
import { afterEach, describe, it, expect, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { NodeEditor } from '../../src/components/node-editor/NodeEditor';
import { TOP_BAR_HEIGHT_PX } from '../../src/hooks/useViewportOffset';
import type { ToCData } from '../../src/types';
import { deepFreeze } from './helpers/deepFreeze';

// Minimal `useGraphMutation`-shaped API so `useNodeProperties` works
// without spinning up the real hook. Records calls so we can assert
// on commit cadence.
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

function makeData(
  nodes: { id: string; title?: string; text?: string; width?: number; color?: string }[],
): ToCData {
  return deepFreeze({
    sections: [
      {
        title: 'Section A',
        columns: [
          {
            nodes: nodes.map((n) => ({
              id: n.id,
              title: n.title ?? '',
              text: n.text ?? '',
              connectionIds: [],
              width: n.width,
              color: n.color,
            })),
          },
        ],
      },
    ],
  });
}

function renderEditor(props: {
  selectedNodeIds: string[];
  data: ToCData;
  api?: ReturnType<typeof makeMutationApi>;
  onRequestClose?: () => void;
  registerOnDragStartedElsewhere?: (cb: () => void) => void;
}) {
  const api = props.api ?? makeMutationApi(props.data);
  const anchor = document.createElement('div');
  anchor.id = 'anchor';
  document.body.appendChild(anchor);
  const anchorRef = { current: anchor } as React.RefObject<HTMLElement>;
  const utils = render(
    <NodeEditor
      selectedNodeIds={props.selectedNodeIds}
      data={props.data}
      mutate={api.mutate}
      mutateDebounced={api.mutateDebounced}
      commit={api.commit}
      anchorRef={anchorRef}
      camera={{ x: 0, y: 0, z: 1 }}
      onRequestClose={props.onRequestClose ?? (() => {})}
      registerOnDragStartedElsewhere={props.registerOnDragStartedElsewhere}
    />,
  );
  return { ...utils, api, anchor };
}

afterEach(() => {
  cleanup();
  // Tear down any anchor divs the test mounted on the document body so
  // they don't leak across tests.
  document.querySelectorAll('#anchor').forEach((el) => el.remove());
});

describe('NodeEditor', () => {
  it('renders without a count header for single selection', () => {
    const { container } = renderEditor({
      selectedNodeIds: ['a'],
      data: makeData([{ id: 'a', title: 'A' }]),
    });
    // No "Editing N nodes" prefix when N=1.
    expect(container.textContent).not.toMatch(/Editing\s+\d+\s+nodes/);
  });

  it('renders "Editing N nodes" for multi-selection', () => {
    renderEditor({
      selectedNodeIds: ['a', 'b', 'c'],
      data: makeData([{ id: 'a' }, { id: 'b' }, { id: 'c' }]),
    });
    expect(screen.getByText(/Editing\s+3\s+nodes/i)).toBeInTheDocument();
  });

  it('calls onRequestClose when a click lands outside the editor', () => {
    const onRequestClose = vi.fn();
    const { container } = renderEditor({
      selectedNodeIds: ['a'],
      data: makeData([{ id: 'a', title: 'A' }]),
      onRequestClose,
    });

    // The editor's portal lives outside container; we synthesize an
    // outside click on document.body itself.
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    fireEvent.mouseDown(outside);

    expect(onRequestClose).toHaveBeenCalled();
    outside.remove();
    void container;
  });

  it('flushes buffered title + details on unmount', () => {
    const api = makeMutationApi(makeData([{ id: 'a', title: 'old', text: 'old detail' }]));
    const { unmount } = renderEditor({
      selectedNodeIds: ['a'],
      data: api.dataRef.current,
      api,
    });

    // Simulate user typing in the title input. `getByRole('textbox')`
    // singles out the title <input> (the slider has `role='slider'`).
    const titleInput = screen.getByRole('textbox', { name: /node title/i }) as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'new title' } });

    // mutateDebounced was called; commit hasn't fired yet.
    expect(api.mutateDebounced).toHaveBeenCalled();
    expect(api.commit).not.toHaveBeenCalled();

    // Unmount the editor → the cleanup effect should flush buffered
    // title (commit('title-...')) and details (commit('details-...')).
    unmount();

    const commitKeys = api.commit.mock.calls.map((c) => c[0]);
    expect(commitKeys.some((k) => typeof k === 'string' && k.startsWith('title-'))).toBe(true);
    expect(commitKeys.some((k) => typeof k === 'string' && k.startsWith('details-'))).toBe(true);
  });

  describe('following changes made by someone else', () => {
    function renderOpenEditor(initial: ToCData) {
      const api = makeMutationApi(initial);
      const anchor = document.createElement('div');
      anchor.id = 'anchor';
      document.body.appendChild(anchor);
      const element = (data: ToCData) => (
        <NodeEditor
          selectedNodeIds={['a']}
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

    const titleInput = () =>
      screen.getByRole('textbox', { name: /node title/i }) as HTMLInputElement;
    const detailsContent = () =>
      waitFor(() => {
        const el = document.querySelector<HTMLElement>('.node-editor [contenteditable="true"]');
        expect(el).not.toBeNull();
        return el!;
      });

    it('shows a title a collaborator saved while the editor was open', () => {
      const { rerenderWith } = renderOpenEditor(makeData([{ id: 'a', title: 'Old' }]));

      rerenderWith(makeData([{ id: 'a', title: 'Renamed' }]));

      expect(titleInput().value).toBe('Renamed');
    });

    it('keeps the title being typed when a collaborator changes the details', () => {
      const { rerenderWith } = renderOpenEditor(makeData([{ id: 'a', title: 'Old', text: 'x' }]));

      fireEvent.change(titleInput(), { target: { value: 'Old plus mine' } });
      rerenderWith(makeData([{ id: 'a', title: 'Old plus mine', text: 'their details' }]));

      expect(titleInput().value).toBe('Old plus mine');
    });

    it('shows details a collaborator saved while the editor was open', async () => {
      const { rerenderWith } = renderOpenEditor(makeData([{ id: 'a', text: 'old details' }]));
      const before = await detailsContent();
      expect(before.textContent).toBe('old details');

      rerenderWith(makeData([{ id: 'a', text: 'their details' }]));

      await waitFor(async () => expect((await detailsContent()).textContent).toBe('their details'));
    }, 20000);

    it('opening a node whose details are not in the editor normal form writes nothing', async () => {
      const { api } = renderOpenEditor(makeData([{ id: 'a', text: '- a\n- b  ' }]));
      await detailsContent();
      // MDXEditor reports its normalised text shortly after opening.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 300));
      });

      expect(api.mutateDebounced).not.toHaveBeenCalled();
      expect(api.mutate).not.toHaveBeenCalled();
      expect(api.commit).not.toHaveBeenCalled();
    }, 20000);
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

    // jsdom does no layout: fake a 1000x700 window, a node, and a panel
    // with the given box and content. `content` is the panel's scrollHeight
    // and clientHeight, which differ when the panel is capped and scrolls.
    function fakeLayout(
      opts: {
        node?: Box;
        panel?: Box;
        content?: { scrollHeight: number; clientHeight: number };
      } = {},
    ) {
      const node = opts.node ?? { left: 400, top: 300, width: 80, height: 40 };
      const panel = opts.panel ?? { left: 0, top: 0, width: 288, height: 2000 };
      const content = opts.content ?? { scrollHeight: 1998, clientHeight: 1998 };
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const r = this.classList.contains('node-editor') ? panel : node;
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
      renderEditor({ selectedNodeIds: ['a'], data: makeData([{ id: 'a' }]) });
      return document.querySelector('.node-editor') as HTMLElement;
    }

    it('caps its height to the room next to the node and scrolls past it', () => {
      fakeLayout();
      const panel = openPanel();

      // Below the node: 700 - 8 - (340 + 12) = 340px; above only 239px.
      expect(panel.style.top).toBe('352px');
      expect(panel.style.maxHeight).toBe('340px');
      expect(panel.className).toContain('overflow-y-auto');
    });

    it('moves above a node near the bottom of the window when it does not fit below', () => {
      // Room below: 692 - (640 + 12) = 40px; above: 600 - 12 - 49 = 539px.
      fakeLayout({
        node: { left: 400, top: 600, width: 80, height: 40 },
        panel: { left: 0, top: 0, width: 288, height: 400 },
        content: { scrollHeight: 398, clientHeight: 398 },
      });
      const panel = openPanel();

      expect(panel.style.top).toBe(`${600 - 12 - 400}px`);
    });

    it('stays below the top bar when its node is scrolled up behind it', () => {
      fakeLayout({
        node: { left: 400, top: -300, width: 80, height: 40 },
        panel: { left: 0, top: 0, width: 288, height: 400 },
        content: { scrollHeight: 398, clientHeight: 398 },
      });
      const panel = openPanel();

      expect(parseFloat(panel.style.top)).toBeGreaterThanOrEqual(TOP_BAR_HEIGHT_PX);
    });

    describe('the mouse wheel', () => {
      // A capped, scrolling panel: its content is far taller than its box.
      const scrollingPanel = {
        panel: { left: 0, top: 0, width: 288, height: 340 },
        content: { scrollHeight: 1998, clientHeight: 338 },
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

      it.each([{ ctrlKey: true }, { metaKey: true }])(
        'still zooms the canvas on a wheel with %o over a scrolling panel',
        (modifier) => {
          fakeLayout(scrollingPanel);
          const panel = openPanel();

          expect(wheelReachingCanvas(panel, { deltaY: -100, ...modifier })).toBe(true);
        },
      );

      it('pans the canvas when the panel has nothing to scroll', () => {
        fakeLayout({
          panel: { left: 0, top: 0, width: 288, height: 200 },
          content: { scrollHeight: 198, clientHeight: 198 },
        });
        const panel = openPanel();

        expect(wheelReachingCanvas(panel, { deltaY: 100 })).toBe(true);
      });
    });
  });

  it('closes when the parent invokes the registered onDragStartedElsewhere callback', () => {
    const onRequestClose = vi.fn();
    let registeredCb: (() => void) | null = null;
    renderEditor({
      selectedNodeIds: ['a'],
      data: makeData([{ id: 'a' }]),
      onRequestClose,
      registerOnDragStartedElsewhere: (cb) => {
        registeredCb = cb;
      },
    });

    expect(registeredCb).toBeTruthy();
    registeredCb!();
    expect(onRequestClose).toHaveBeenCalled();
  });
});
