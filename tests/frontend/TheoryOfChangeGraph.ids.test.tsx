// The canvas keeps no copy of the chart: a remote chart landing in the middle of
// a gesture changes the sections, columns and nodes under it, so state that
// outlives one event is keyed by id, new containers get random ids, a drop
// re-reads the layout at release, and a selection never holds a node that is gone.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import { _resetSwallowNextClickGuardForTest } from '../../src/hooks/useDismissOnOutsideEvent';
import type { ChartInput, ToCData } from '../../src/types';
import { columnsOf, edit, findNode, node, nodeIn, removeNode } from '../shared/chart-fixtures';
import { renderToC } from './helpers/renderToC';

vi.mock('../../src/services/loggingService', () => ({
  loggingService: { reportError: vi.fn() },
}));

// Containers carry no ids, so they get the positional ones the normaliser
// derives: sections s0, s1; columns c0.0, c0.1, c1.0.
const idLessChart = (): ChartInput => ({
  title: 'T',
  sections: [
    { title: 'One', columns: [{ nodes: [node('n-1')] }, { nodes: [node('n-2', 300)] }] },
    { title: 'Two', columns: [{ nodes: [node('n-3')] }] },
  ],
});

afterEach(() => {
  cleanup();
  _resetCanvasGestureStateForTest();
  _resetSwallowNextClickGuardForTest();
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const flushMicrotasks = () =>
  act(async () => {
    await Promise.resolve();
  });

const q = (selector: string) => {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`expected an element for ${selector}`);
  return el;
};

const sectionIds = (chart: ToCData) => chart.sections.map((s) => s.id);
const columnIds = (chart: ToCData) => columnsOf(chart).map((c) => c.id);

describe('containers get random ids when they are created', () => {
  it('insert_section_mints_random_ids', async () => {
    const { doc } = renderToC(idLessChart());

    fireEvent.click(q('[data-testid="add-section-after-last"]'));
    await flushMicrotasks();

    const added = doc.getCommitted().sections[2];
    expect(added.id).toMatch(/^sec-[0-9a-z]{10}$/);
    expect(added.columns[0].id).toMatch(/^col-[0-9a-z]{10}$/);
  });

  it('insert_column_mints_a_random_id', async () => {
    const { doc } = renderToC(idLessChart());

    fireEvent.click(q('[data-testid="add-column-after-0-0"]'));
    await flushMicrotasks();

    const columns = doc.getCommitted().sections[0].columns;
    expect(columns).toHaveLength(3);
    expect(columns[1].id).toMatch(/^col-[0-9a-z]{10}$/);
    expect(columnIds(doc.getCommitted())).toEqual(['c0.0', columns[1].id, 'c0.1', 'c1.0']);
  });

  it('a_keyboard_move_into_a_section_without_columns_mints_its_column_id', async () => {
    const chart = idLessChart();
    chart.sections[1].columns = [];
    const { doc } = renderToC(chart);
    fireEvent.click(q('[data-tocb-node="n-2"]'));

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await flushMicrotasks();

    const target = doc.getCommitted().sections[1];
    expect(target.columns).toHaveLength(1);
    expect(target.columns[0].id).toMatch(/^col-[0-9a-z]{10}$/);
    expect(target.columns[0].nodes.map((n) => n.id)).toEqual(['n-2']);
  });
});

describe('state that outlives an event follows ids', () => {
  it('section_title_edit_follows_section_after_remote_insert', () => {
    const { doc, land } = renderToC(idLessChart());
    fireEvent.click(screen.getByText('Two'));
    const input = screen.getByDisplayValue('Two');

    act(() =>
      land((draft) => {
        draft.sections.unshift({
          id: 'sec-remote',
          title: 'Remote',
          columns: [{ id: 'col-remote', nodes: [] }],
        });
      }),
    );
    fireEvent.change(input, { target: { value: 'Two, edited' } });

    expect(input.isConnected).toBe(true);
    const titles = Object.fromEntries(doc.getLive().sections.map((s) => [s.id, s.title]));
    expect(titles).toEqual({ 'sec-remote': 'Remote', s0: 'One', s1: 'Two, edited' });
  });

  it('delete_confirm_targets_original_column', async () => {
    const { doc, land } = renderToC(idLessChart());
    fireEvent.click(screen.getByTestId('column-delete-0-1'));

    act(() =>
      land((draft) => {
        draft.sections[0].columns.unshift({ id: 'col-remote', nodes: [] });
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await flushMicrotasks();

    expect(doc.getCommitted().sections[0].columns.map((c) => c.id)).toEqual(['col-remote', 'c0.0']);
  });

  it('delete_confirm_targets_original_section', async () => {
    const { doc, land } = renderToC(idLessChart());
    fireEvent.click(screen.getByTestId('section-delete-1'));

    act(() =>
      land((draft) => {
        draft.sections.unshift({
          id: 'sec-remote',
          title: 'Remote',
          columns: [{ id: 'col-remote', nodes: [] }],
        });
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await flushMicrotasks();

    expect(sectionIds(doc.getCommitted())).toEqual(['sec-remote', 's0']);
  });
});

describe('the selection never holds a node that is gone', () => {
  it('pruned_selection_keeps_identity_when_nothing_pruned', () => {
    const onHighlightedNodesChange = vi.fn<(nodes: Set<string>) => void>();
    const { doc } = renderToC(idLessChart(), { onHighlightedNodesChange });
    fireEvent.click(q('[data-tocb-node="n-1"]'));
    const reported = onHighlightedNodesChange.mock.calls.length;
    const selection = onHighlightedNodesChange.mock.calls.at(-1)![0];
    expect(selection.has('n-1')).toBe(true);

    act(() =>
      doc.preview((chart) =>
        edit(chart, (draft) => {
          nodeIn(draft, 'n-1').title = 'typed';
        }),
      ),
    );
    act(() =>
      doc.preview((chart) =>
        edit(chart, (draft) => {
          nodeIn(draft, 'n-3').title = 'elsewhere';
        }),
      ),
    );

    expect(onHighlightedNodesChange).toHaveBeenCalledTimes(reported);
    expect(onHighlightedNodesChange.mock.calls.at(-1)![0]).toBe(selection);
  });

  it('remote_delete_of_open_node_closes_node_editor', () => {
    const onHighlightedNodesChange = vi.fn<(nodes: Set<string>) => void>();
    const { land } = renderToC(idLessChart(), { onHighlightedNodesChange });
    fireEvent.click(q('[data-tocb-node="n-1"]'));
    expect(document.querySelector('.node-editor')).not.toBeNull();

    act(() => land((draft) => removeNode(draft, 'n-1')));

    expect(document.querySelector('.node-editor')).toBeNull();
    expect(onHighlightedNodesChange.mock.calls.at(-1)![0].has('n-1')).toBe(false);
  });
});

// jsdom has no layout: the columns' rects come from a table the test swaps to
// model a landing re-flowing the canvas, keyed by `data-column="section-column"`.
describe('a drop between columns', () => {
  const COLUMN_TOP = 100;
  const NODE_TOP = 262;
  let columnRects: Record<string, [number, number]> = {};

  const rect = (left: number, top: number, right: number, bottom: number): DOMRect => ({
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  });

  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element,
    ) {
      const column = (this as HTMLElement).dataset?.column;
      if (column && columnRects[column]) {
        const [left, right] = columnRects[column];
        return rect(left, COLUMN_TOP, right, 900);
      }
      if (this.id === 'node-n-1') return rect(50, NODE_TOP, 242, NODE_TOP + 76);
      return rect(0, 0, 0, 0);
    });
  });

  const pointer = (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientX: { value: x },
      clientY: { value: y },
      pointerId: { value: 1 },
      pointerType: { value: 'mouse' },
    });
    return event;
  };
  const move = (x: number, y: number) =>
    act(() => void document.dispatchEvent(pointer('pointermove', x, y)));
  const release = async (x: number, y: number) => {
    act(() => void document.dispatchEvent(pointer('pointerup', x, y)));
    await flushMicrotasks();
  };

  it('a_drop_between_columns_creates_a_column_with_a_random_id', async () => {
    columnRects = { '0-0': [50, 250], '0-1': [274, 474] };
    const chart: ChartInput = {
      title: 'T',
      sections: [{ title: 'One', columns: [{ nodes: [node('n-1', 200)] }, { nodes: [] }] }],
    };
    const { doc } = renderToC(chart);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    fireEvent.pointerDown(document.getElementById('node-n-1')!, {
      clientX: 100,
      clientY: NODE_TOP + 30,
      button: 0,
      pointerId: 1,
    });
    move(262, 400); // the gutter between the two columns
    await release(262, 400);

    const columns = doc.getCommitted().sections[0].columns;
    expect(columns).toHaveLength(3);
    expect(columns[1].id).toMatch(/^col-[0-9a-z]{10}$/);
    expect(columns[1].nodes.map((n) => n.id)).toEqual(['n-1']);
    expect(findNode(doc.getCommitted(), 'n-1')).toBeDefined();
  });
});
