// Edit mode lays the chart out exactly like view mode: the add controls
// are overlays, so nothing inside the graph may depend on `editMode`.
//
// jsdom has no layout engine, so this compares the layout *inputs* both
// modes hand to the browser (gaps, widths, size budgets, node offsets).
// The pixel-level comparison of rendered nodes and connection paths is
// done in a real browser.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, fireEvent, act } from '@testing-library/react';
import type { ChartInput } from '../../src/types';
import { renderToC } from './helpers/renderToC';

// The first graph render in a worker pulls in lazily loaded editor code, and
// the parity tests render the whole graph twice, so the 5s default is tight.
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  cleanup();
});

const node = (id: string, title: string, yPosition: number, width?: number) => ({
  id,
  title,
  text: '',
  connectionIds: [],
  connections: [],
  yPosition,
  ...(width ? { width } : {}),
});

const makeData = (overrides: Partial<ChartInput> = {}): ChartInput => ({
  title: 'Programme',
  sections: [
    {
      title: 'Inputs',
      columns: [
        { nodes: [node('a', 'Funding', 100, 240), node('b', 'Staff', 300)] },
        { nodes: [] },
      ],
    },
    {
      title: 'A section title much longer than its single narrow column',
      columns: [{ nodes: [node('c', 'Workshops', 150, 128)] }],
    },
    { title: 'Outcomes', columns: [{ nodes: [node('d', 'Skills', 900)] }] },
  ],
  ...overrides,
});

interface Geometry {
  graphGap: string;
  sections: {
    bar: { minWidth: string; width: string };
    columnsGap: string;
    columns: { width: string; nodes: { top: string; left: string; width: string }[] }[];
  }[];
  size: { width: number; height: number } | undefined;
}

async function geometryOf(data: ChartInput, editMode: boolean): Promise<Geometry> {
  let size: Geometry['size'];
  const { container } = renderToC(data, {
    showEditButton: editMode,
    onSizeChange: (s) => {
      size = s;
    },
  });
  await act(async () => {
    await Promise.resolve();
  });
  const graph = container.querySelector<HTMLElement>('div.min-w-fit')!;
  const sections = [...container.querySelectorAll<HTMLElement>('[data-section-index]')].map(
    (section) => {
      const bar = section.children[0] as HTMLElement;
      const columnsRow = section.children[1] as HTMLElement;
      return {
        bar: { minWidth: bar.style.minWidth, width: bar.style.width },
        columnsGap: columnsRow.style.gap,
        columns: [...columnsRow.querySelectorAll<HTMLElement>('[data-column]')].map((column) => ({
          width: column.style.width,
          nodes: [...column.children]
            .filter((child) => child.querySelector('[data-tocb-node]'))
            .map((wrapper) => {
              const { top, left, width } = (wrapper as HTMLElement).style;
              return { top, left, width };
            }),
        })),
      };
    },
  );
  cleanup();
  return { graphGap: graph.style.gap, sections, size };
}

describe('edit mode uses view mode geometry', () => {
  it('titled chart: gaps, section bars, column widths, node offsets and chart size match', async () => {
    const data = makeData();
    expect(await geometryOf(data, true)).toEqual(await geometryOf(data, false));
  });

  it('untitled chart: the missing title block costs no height in edit mode', async () => {
    const data = makeData({ title: '' });
    expect(await geometryOf(data, true)).toEqual(await geometryOf(data, false));
  });

  it('section bars follow the view-mode rule: at least the column width, as wide as the title', async () => {
    const { sections } = await geometryOf(makeData(), true);
    for (const { bar } of sections) {
      expect(bar.width).toBe('max-content');
      expect(bar.minWidth).toMatch(/^\d+px$/);
    }
  });

  it('column bodies keep an explicit height in edit mode so empty space stays double-clickable', async () => {
    const data = makeData({
      title: '',
      sections: [{ title: 'Inputs', columns: [{ nodes: [node('a', 'Funding', 100)] }] }],
    });
    const { container } = renderToC(data);
    await act(async () => {
      await Promise.resolve();
    });
    // Untitled: the 800px minimum canvas less the 62px section header, and
    // no title block (it is not in the layout).
    const body = container.querySelector<HTMLElement>('[data-column="0-0"]')!;
    expect(body.style.height).toBe('738px');
  });
});

describe('view mode markup', () => {
  it('keeps column bodies as direct children of the columns row, as before edit mode shared its layout', async () => {
    const { container } = renderToC(makeData(), { showEditButton: false });
    await act(async () => {
      await Promise.resolve();
    });
    for (const section of container.querySelectorAll<HTMLElement>('[data-section-index]')) {
      const columnsRow = section.children[1];
      for (const column of columnsRow.querySelectorAll('[data-column]')) {
        expect(column.parentElement).toBe(columnsRow);
      }
    }
  });
});

describe('section title bar while its label is edited', () => {
  const barFor = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('[data-section-index="1"]')!.children[0] as HTMLElement;

  it('keeps the width it had before editing, at any zoom, and releases it afterwards', async () => {
    const { container } = renderToC(makeData(), { zoomScale: 0.5 });
    await act(async () => {
      await Promise.resolve();
    });
    const bar = barFor(container);
    // On screen (zoomed) the bar is 120px wide, i.e. 240 content px.
    bar.getBoundingClientRect = () => ({ width: 120 }) as DOMRect;
    expect(bar.style.width).toBe('max-content');

    fireEvent.click(bar.querySelector('h2')!);
    expect(barFor(container).style.width).toBe('240px');
    const input = barFor(container).querySelector('input')!;
    fireEvent.change(input, { target: { value: 'A different, much longer section title' } });
    expect(barFor(container).style.width).toBe('240px');

    fireEvent.blur(input);
    expect(barFor(container).style.width).toBe('max-content');
  });
});

describe('untitled chart in edit mode', () => {
  it('offers "Click to add title" as an overlay that exports leave out and that opens the editor', async () => {
    const { container, getByText } = renderToC(makeData({ title: '' }));
    await act(async () => {
      await Promise.resolve();
    });
    const placeholder = getByText('Click to add title');
    expect(placeholder.closest('[data-export-exclude]')).not.toBeNull();
    expect(container.querySelector('h1')).toBeNull();

    fireEvent.click(placeholder);
    expect(container.querySelector('input[type="text"]')).not.toBeNull();
  });

  it('reserves the title block in the chart size once a title is being typed', async () => {
    const sizes: { width: number; height: number }[] = [];
    const data = makeData({ title: '' });
    const { getByText } = renderToC(data, { onSizeChange: (size) => sizes.push(size) });
    await act(async () => {
      await Promise.resolve();
    });
    const heightBefore = sizes[sizes.length - 1].height;

    fireEvent.click(getByText('Click to add title'));
    await act(async () => {
      await Promise.resolve();
    });

    expect(sizes[sizes.length - 1].height).toBe(heightBefore + 80);
  });

  it('keeps the prompt at a readable on-screen size when the chart is zoomed out', async () => {
    const promptAt = (zoomScale: number) => {
      const { getByText } = renderToC(makeData({ title: '' }), { zoomScale });
      return getByText('Click to add title');
    };

    // Content pixels divided by the zoom make the on-screen size constant.
    expect(promptAt(0.25).style.transform).toContain('scale(4)');
    cleanup();
    expect(promptAt(2).style.transform).toContain('scale(0.5)');
  });

  it('shows no placeholder in view mode', async () => {
    const { queryByText } = renderToC(makeData({ title: '' }), { showEditButton: false });
    expect(queryByText('Click to add title')).toBeNull();
  });
});
