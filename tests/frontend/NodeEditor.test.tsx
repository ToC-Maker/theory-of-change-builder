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
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { NodeEditor } from '../../src/components/node-editor/NodeEditor';
import type { ToCData } from '../../src/types';

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
  return {
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
  };
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

  describe('keeping inside the window', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    // jsdom does no layout: fake a node mid-window and a panel far taller
    // than the room around it.
    function fakeLayout() {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 });
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: HTMLElement,
      ) {
        const r = this.classList.contains('node-editor')
          ? { left: 0, top: 0, width: 288, height: 2000 }
          : { left: 400, top: 300, width: 80, height: 40 };
        return {
          ...r,
          right: r.left + r.width,
          bottom: r.top + r.height,
          x: r.left,
          y: r.top,
          toJSON: () => ({}),
        } as DOMRect;
      });
      vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(1998);
      vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(1998);
    }

    it('caps its height to the room next to the node and scrolls past it', () => {
      fakeLayout();
      renderEditor({ selectedNodeIds: ['a'], data: makeData([{ id: 'a' }]) });
      const panel = document.querySelector('.node-editor') as HTMLElement;

      // Below the node: 700 - 8 - (340 + 12) = 340px; above only 239px.
      expect(panel.style.top).toBe('352px');
      expect(panel.style.maxHeight).toBe('340px');
      expect(panel.className).toContain('overflow-y-auto');
    });

    it('keeps the wheel for its own scrolling, except for zoom', () => {
      fakeLayout();
      renderEditor({ selectedNodeIds: ['a'], data: makeData([{ id: 'a' }]) });
      const panel = document.querySelector('.node-editor') as HTMLElement;
      const canvasWheel = vi.fn();
      document.addEventListener('wheel', canvasWheel);
      try {
        fireEvent.wheel(panel, { deltaY: 100 });
        expect(canvasWheel).not.toHaveBeenCalled();
        fireEvent.wheel(panel, { deltaY: -100, ctrlKey: true });
        expect(canvasWheel).toHaveBeenCalledTimes(1);
      } finally {
        document.removeEventListener('wheel', canvasWheel);
      }
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
