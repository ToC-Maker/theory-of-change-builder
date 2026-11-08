// PR #34 fb7 issue 77: dismissing an editor must not trigger canvas
// actions.
//
// With NodeEditor or EdgeEditor open, a click that lands on an add
// affordance (column gutter, section gutter, double-click-to-create on
// a column body) used to BOTH dismiss the editor (document mousedown,
// via `useDismissOnOutsideEvent`) AND fire the affordance (click /
// dblclick of the same physical gesture) — closing a modal surprise-
// created a column. Expected: the dismissing gesture is consumed; the
// first click closes only, a second click performs canvas actions.
//
// Scenario matrix (reviewer-specified):
//   1. dismiss-over-gutter            → editor closes, NO column added
//   2. dismiss-over-empty-canvas      → editor closes, nothing else
//   3. click node B while editing A   → editor SWITCHES (still works)
//   4. Cmd/Ctrl+click node B          → multi-select (still works)
//   5. dismiss, then second gutter click → column added (one-shot)
// Plus:
//   6. dblclick-to-create while editor open → swallowed (no node)
//      [control: same gesture with no editor open DOES create]
//   7. EdgeEditor: dismiss-over-gutter → closes, no column added
//   8. click a connection while editing a node → EdgeEditor opens
//      (connection hit paths are switch targets, not canvas actions)
//   9. press on a control OUTSIDE the canvas (the top bar's File
//      menu) → editor closes AND the click acts in the same gesture.
//      The guard exists for canvas affordances only; top-bar, chat
//      panel and dialog controls are explicit actions and must not
//      need a second click.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import { FileMenu } from '../../src/components/top-bar/FileMenu';
import type { ChartInput, ToCData } from '../../src/types';
import { _resetSwallowNextClickGuardForTest } from '../../src/hooks/useDismissOnOutsideEvent';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import { makeDoc, renderToC } from './helpers/renderToC';

// FileMenu reads the signed-in user; anonymous is all scenario 9 needs.
vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({ user: undefined, isAuthenticated: false, isLoading: false }),
}));

afterEach(() => {
  cleanup();
  _resetSwallowNextClickGuardForTest();
  _resetCanvasGestureStateForTest();
  document.body.innerHTML = '';
});

// A fresh object per test; the helper deep-freezes the normalised chart, so
// an updater that writes into the state it receives throws.
const makeData = (): ChartInput => ({
  title: 'Test',
  sections: [
    {
      title: 'Inputs',
      columns: [
        {
          nodes: [
            {
              id: 'n-1',
              title: 'A',
              text: '',
              connectionIds: [],
              connections: [{ targetId: 'n-2', confidence: 75 }],
              yPosition: 100,
            },
          ],
        },
      ],
    },
    {
      title: 'Outputs',
      columns: [
        {
          nodes: [
            {
              id: 'n-2',
              title: 'B',
              text: '',
              connectionIds: [],
              connections: [],
              yPosition: 100,
            },
          ],
        },
      ],
    },
  ],
});

const at = (x: number, y: number) => ({ clientX: x, clientY: y });

/** One physical click: mousedown → mouseup → click, same coords. */
function gestureClick(el: Element, coords: { clientX: number; clientY: number }) {
  fireEvent.mouseDown(el, coords);
  fireEvent.mouseUp(el, coords);
  fireEvent.click(el, coords);
}

/** One physical double-click: two clicks then dblclick, same coords. */
function gestureDblClick(el: Element, coords: { clientX: number; clientY: number }) {
  gestureClick(el, coords);
  gestureClick(el, coords);
  fireEvent.dblClick(el, coords);
}

/**
 * The canvas commits a gesture's change to the store on a microtask, so
 * data-driven DOM changes (added columns/sections/nodes) land one
 * microtask after the click. Every count assertion — including the
 * "nothing changed" ones, which would otherwise false-pass on a stale
 * read — flushes first.
 */
async function flushMutations() {
  await act(async () => {
    await Promise.resolve();
  });
}

function q(selector: string): Element {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`expected element for selector: ${selector}`);
  return el;
}

function openNodeEditor(nodeId: string) {
  // Opening uses a plain gesture too — no editor is mounted yet, so the
  // mousedown dismisses nothing and the click selects.
  gestureClick(q(`[data-tocb-node="${nodeId}"]`), at(10, 10));
  expect(document.querySelector('.node-editor')).not.toBeNull();
}

function nodeCount(chart: ToCData): number {
  return chart.sections.flatMap((s) => s.columns.flatMap((c) => c.nodes)).length;
}

function columnCount(): number {
  return document.querySelectorAll('[data-column]').length;
}

describe('TheoryOfChangeGraph dismissal guard (fb7 issue 77)', () => {
  it('1. dismissing over a column gutter closes the editor without adding a column', async () => {
    renderToC(makeData());
    openNodeEditor('n-1');
    const before = columnCount();

    gestureClick(q('[data-testid="add-column-after-0-0"]'), at(200, 200));
    await flushMutations();

    expect(document.querySelector('.node-editor')).toBeNull();
    expect(columnCount()).toBe(before);
  });

  it('1b. dismissing over a section gutter closes the editor without adding a section', async () => {
    renderToC(makeData());
    openNodeEditor('n-1');
    const before = document.querySelectorAll('[data-testid="add-section-before"]').length;

    gestureClick(q('[data-testid="add-section-after-last"]'), at(300, 200));
    await flushMutations();

    expect(document.querySelector('.node-editor')).toBeNull();
    expect(document.querySelectorAll('[data-testid="add-section-before"]').length).toBe(before);
  });

  it('2. dismissing over empty canvas (column body) only closes the editor', async () => {
    renderToC(makeData());
    openNodeEditor('n-1');
    const nodesBefore = document.querySelectorAll('[data-tocb-node]').length;
    const colsBefore = columnCount();

    gestureClick(q('[data-column="0-0"]'), at(150, 300));
    await flushMutations();

    expect(document.querySelector('.node-editor')).toBeNull();
    expect(document.querySelectorAll('[data-tocb-node]').length).toBe(nodesBefore);
    expect(columnCount()).toBe(colsBefore);
  });

  it('3. clicking node B while editing node A switches the editor (not swallowed)', () => {
    renderToC(makeData());
    openNodeEditor('n-1');

    gestureClick(q('[data-tocb-node="n-2"]'), at(400, 100));

    // Editor still up, now anchored to B (single selection, B ringed).
    const editor = document.querySelector('.node-editor');
    expect(editor).not.toBeNull();
    expect(editor!.textContent).not.toMatch(/Editing\s+\d+\s+nodes/);
    expect(q('[data-tocb-node="n-2"]').className).toContain('ring-2');
  });

  it('4. Cmd/Ctrl+click node B extends the selection (not dismissed, not swallowed)', () => {
    renderToC(makeData());
    openNodeEditor('n-1');

    const nodeB = q('[data-tocb-node="n-2"]');
    fireEvent.mouseDown(nodeB, { ...at(400, 100), metaKey: true });
    fireEvent.mouseUp(nodeB, { ...at(400, 100), metaKey: true });
    fireEvent.click(nodeB, { ...at(400, 100), metaKey: true });

    const editor = document.querySelector('.node-editor');
    expect(editor).not.toBeNull();
    expect(editor!.textContent).toMatch(/Editing\s+2\s+nodes/);
  });

  it('5. a second, separate gutter click after the dismissal adds the column', async () => {
    renderToC(makeData());
    openNodeEditor('n-1');
    const before = columnCount();

    const gutter = q('[data-testid="add-column-after-0-0"]');
    gestureClick(gutter, at(200, 200)); // dismissing gesture — consumed
    await flushMutations();
    expect(document.querySelector('.node-editor')).toBeNull();
    expect(columnCount()).toBe(before);

    gestureClick(gutter, at(200, 200)); // deliberate second click — acts
    await flushMutations();
    expect(columnCount()).toBe(before + 1);
  });

  // Node creation is observable in the committed chart, and in its other
  // atomic side effect: `createNewNode` auto-selects the new node, which
  // mounts the NodeEditor. No other gesture here opens an editor, so
  // editor-mounted <=> a node was created.
  it('6. double-click-to-create while an editor is open is consumed (no node)', async () => {
    const { doc } = renderToC(makeData());
    openNodeEditor('n-1');
    const nodesBefore = nodeCount(doc.getCommitted());

    gestureDblClick(q('[data-column="0-0"]'), at(150, 300));
    await flushMutations();

    // The open editor was dismissed by the press and the create was
    // swallowed: no new node was created+auto-selected, so the editor
    // stays closed.
    expect(document.querySelector('.node-editor')).toBeNull();
    expect(nodeCount(doc.getCommitted())).toBe(nodesBefore);
  });

  it('6b. control: the same double-click gesture with no editor open creates a node', async () => {
    const { doc } = renderToC(makeData());
    expect(document.querySelector('.node-editor')).toBeNull();
    const nodesBefore = nodeCount(doc.getCommitted());

    gestureDblClick(q('[data-column="0-0"]'), at(150, 300));
    await flushMutations();

    // No guard armed (no editor was open), so the create ran: the new
    // node was auto-selected, mounting its NodeEditor. Pin the contrast
    // with scenario 6 — same gesture, opposite outcome.
    expect(document.querySelector('.node-editor')).not.toBeNull();
    expect(nodeCount(doc.getCommitted())).toBe(nodesBefore + 1);
  });

  it('7. EdgeEditor: dismissing over a column gutter closes it without adding a column', async () => {
    renderToC(makeData());
    // Open the EdgeEditor by clicking the connection's invisible hit
    // path (no recorded pointerdown → opens unconditionally).
    fireEvent.click(q('[data-tocb-connection-hitpath]'));
    expect(document.querySelector('.edge-editor')).not.toBeNull();
    const before = columnCount();

    gestureClick(q('[data-testid="add-column-after-0-0"]'), at(200, 200));
    await flushMutations();

    expect(document.querySelector('.edge-editor')).toBeNull();
    expect(columnCount()).toBe(before);
  });

  it('8. clicking a connection while editing a node opens the EdgeEditor (switch flow)', () => {
    renderToC(makeData());
    openNodeEditor('n-1');

    gestureClick(q('[data-tocb-connection-hitpath]'), at(250, 150));

    expect(document.querySelector('.node-editor')).toBeNull();
    expect(document.querySelector('.edge-editor')).not.toBeNull();
  });

  // Scenario 9 renders the real File menu beside the canvas. It stands
  // for every control outside the canvas: they all sit outside the
  // `[data-tocb-canvas]` root, so what holds for File holds for them.
  describe('9. controls outside the canvas keep their click', () => {
    const renderWithFileMenu = () =>
      render(
        <MemoryRouter>
          <FileMenu
            isAuthenticated={false}
            isOwner={false}
            currentEditToken="tok"
            currentChartId="chart"
            onDeleteChart={() => {}}
          />
          <ToC store={makeDoc(makeData()).doc} showEditButton />
        </MemoryRouter>,
      );
    const fileButton = () => screen.getByRole('button', { name: /file/i });
    const fileMenuIsOpen = () => screen.queryByText(/new toc/i) !== null;

    it('9a. one click on File closes a NodeEditor AND opens the menu', () => {
      renderWithFileMenu();
      openNodeEditor('n-1');

      gestureClick(fileButton(), at(30, 20));

      expect(document.querySelector('.node-editor')).toBeNull();
      expect(fileMenuIsOpen()).toBe(true);
    });

    it('9b. one click on File closes an EdgeEditor AND opens the menu', () => {
      renderWithFileMenu();
      fireEvent.click(q('[data-tocb-connection-hitpath]'));
      expect(document.querySelector('.edge-editor')).not.toBeNull();

      gestureClick(fileButton(), at(30, 20));

      expect(document.querySelector('.edge-editor')).toBeNull();
      expect(fileMenuIsOpen()).toBe(true);
    });
  });
});
