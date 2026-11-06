// Add controls for columns and sections.
//
// In edit mode every place a column or section can be added has an
// overlay zone: the outer edges of the chart, the gap between sections
// (three controls) and the gap between columns (one control). The zones
// are laid over the existing gaps, so they take no layout space; the
// controls show while the zone is hovered, and clicking one adds exactly
// one column or section through the standard mutation path. View mode has
// none of them.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import { MOVE_THRESHOLD_PX } from '../../src/hooks/usePointerDrag';
import type { ToCData } from '../../src/types';

afterEach(() => {
  cleanup();
});

// A fresh object per call, so no test sees another test's data.
const makeBaseData = (): ToCData => ({
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
              connections: [],
              yPosition: 100,
            },
          ],
        },
        { nodes: [] },
      ],
    },
    {
      title: 'Outputs',
      columns: [{ nodes: [] }],
    },
  ],
});

const testIdsIn = (zoneTestId: string) =>
  [...document.querySelectorAll(`[data-testid="${zoneTestId}"] [data-testid]`)].map((el) =>
    el.getAttribute('data-testid'),
  );

function lastData(onDataChange: ReturnType<typeof vi.fn>): ToCData {
  return onDataChange.mock.calls[onDataChange.mock.calls.length - 1][0] as ToCData;
}

describe('add controls', () => {
  it('lays one zone at each outer edge, one in each section gap and one in each column gap', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const zones = [...document.querySelectorAll('[data-testid^="add-zone-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(zones.sort()).toEqual([
      'add-zone-column-gap-0-0',
      'add-zone-edge-end',
      'add-zone-edge-start',
      'add-zone-section-gap-0',
    ]);
  });

  it('puts three controls in a section gap, in left-to-right order of what they add', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    expect(testIdsIn('add-zone-section-gap-0')).toEqual([
      'add-column-after-0-1',
      'add-section-before',
      'add-column-before-1-0',
    ]);
  });

  it('offers section and first-column adds at the start edge, last-column and section adds at the end edge', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    expect(testIdsIn('add-zone-edge-start')).toEqual([
      'add-section-before',
      'add-column-before-0-0',
    ]);
    expect(testIdsIn('add-zone-edge-end')).toEqual([
      'add-column-after-1-0',
      'add-section-after-last',
    ]);
  });

  it('puts a single column control in the gap between two columns', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    expect(testIdsIn('add-zone-column-gap-0-0')).toEqual(['add-column-after-0-0']);
  });

  it('renders no controls in view-only mode', () => {
    render(<ToC data={makeBaseData()} showEditButton={false} />);
    expect(document.querySelector('[data-testid^="add-"]')).toBeNull();
  });

  it('sizes each zone to the gap it covers and attaches it to the side facing that gap', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const zone = (testId: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.style;

    // Outer edges lie in the canvas card's padding (16px), the gap between
    // sections is sectionPadding (32px), the gap between columns is
    // columnPadding (24px).
    expect(zone('add-zone-edge-start')).toMatchObject({ width: '16px', right: '100%' });
    expect(zone('add-zone-edge-end')).toMatchObject({ width: '16px', left: '100%' });
    expect(zone('add-zone-section-gap-0')).toMatchObject({ width: '32px', left: '100%' });
    expect(zone('add-zone-column-gap-0-0')).toMatchObject({ width: '24px', left: '100%' });
  });

  it('marks every zone for exclusion from exports', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const zones = document.querySelectorAll('[data-testid^="add-zone-"]');
    expect(zones.length).toBeGreaterThan(0);
    zones.forEach((zone) => expect(zone.hasAttribute('data-export-exclude')).toBe(true));
  });

  it("hides a zone's controls until the pointer is over it", () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const zone = document.querySelector<HTMLElement>('[data-testid="add-zone-column-gap-0-0"]')!;
    const stack = zone.firstElementChild as HTMLElement;
    expect(stack.getAttribute('data-revealed')).toBe('false');

    fireEvent.mouseEnter(zone, { clientY: 200 });
    expect(stack.getAttribute('data-revealed')).toBe('true');

    fireEvent.mouseLeave(zone);
    expect(stack.getAttribute('data-revealed')).toBe('false');
  });

  it('does not reveal controls while a mouse button is held (a drag is under way)', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const zone = document.querySelector<HTMLElement>('[data-testid="add-zone-column-gap-0-0"]')!;
    fireEvent.mouseEnter(zone, { buttons: 1 });
    expect(zone.firstElementChild!.getAttribute('data-revealed')).toBe('false');
  });

  it('a section-gap click on "+ Section" adds one section between the two neighbours', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    const gapZone = document.querySelector('[data-testid="add-zone-section-gap-0"]')!;
    fireEvent.click(gapZone.querySelector('[data-testid="add-section-before"]')!);

    return Promise.resolve().then(() => {
      const sections = lastData(onDataChange).sections;
      expect(sections.map((section) => section.title)).toEqual([
        'Inputs',
        'New Section',
        'Outputs',
      ]);
    });
  });

  it('the first "+ Section" at the start edge adds one section before the first', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(
      document.querySelector(
        '[data-testid="add-zone-edge-start"] [data-testid="add-section-before"]',
      )!,
    );

    return Promise.resolve().then(() => {
      const sections = lastData(onDataChange).sections;
      expect(sections.map((section) => section.title)).toEqual([
        'New Section',
        'Inputs',
        'Outputs',
      ]);
    });
  });

  it('"+ Section" at the end edge adds one section after the last', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-section-after-last"]')!);

    return Promise.resolve().then(() => {
      const sections = lastData(onDataChange).sections;
      expect(sections.map((section) => section.title)).toEqual([
        'Inputs',
        'Outputs',
        'New Section',
      ]);
    });
  });

  it('"+ Column" before the first column of a section adds one column at index 0', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-column-before-0-0"]')!);

    return Promise.resolve().then(() => {
      const columns = lastData(onDataChange).sections[0].columns;
      expect(columns.map((column) => column.nodes.length)).toEqual([0, 1, 0]);
    });
  });

  it('"+ Column" in a section gap adds one column to the start of the section on its right', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-column-before-1-0"]')!);

    return Promise.resolve().then(() => {
      const data = lastData(onDataChange);
      expect(data.sections[0].columns.length).toBe(2);
      expect(data.sections[1].columns.length).toBe(2);
    });
  });

  it('"+ Column" in a section gap adds one column to the end of the section on its left', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-column-after-0-1"]')!);

    return Promise.resolve().then(() => {
      const columns = lastData(onDataChange).sections[0].columns;
      expect(columns.map((column) => column.nodes.length)).toEqual([1, 0, 0]);
    });
  });

  it('"+ Column" between two columns adds one column right after the left one', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-column-after-0-0"]')!);

    return Promise.resolve().then(() => {
      const columns = lastData(onDataChange).sections[0].columns;
      expect(columns.map((column) => column.nodes.length)).toEqual([1, 0, 0]);
    });
  });

  it('a section with no columns can still get its first column', () => {
    const onDataChange = vi.fn();
    const data = makeBaseData();
    data.sections[1].columns = [];
    render(<ToC data={data} showEditButton={true} onDataChange={onDataChange} />);
    fireEvent.click(document.querySelector('[data-testid="add-column-before-1-0"]')!);

    return Promise.resolve().then(() => {
      expect(lastData(onDataChange).sections[1].columns.length).toBe(1);
    });
  });

  describe('press-and-drag on a control', () => {
    const columnCount = () => document.querySelectorAll('[data-column]').length;
    const flush = () => act(async () => Promise.resolve());

    it('a press that travels past the click threshold adds nothing on release', async () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const control = document.querySelector('[data-testid="add-column-after-0-0"]')!;
      const before = columnCount();

      // The canvas pans with the content following the cursor, so the
      // control is still under the pointer when it is released and the
      // browser reports a click.
      fireEvent.pointerDown(control, { clientX: 100, clientY: 100 });
      fireEvent.click(control, { clientX: 100 + MOVE_THRESHOLD_PX + 1, clientY: 100 });
      await flush();

      expect(columnCount()).toBe(before);
    });

    it('a press that stays within the click threshold adds exactly one column', async () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const control = document.querySelector('[data-testid="add-column-after-0-0"]')!;
      const before = columnCount();

      fireEvent.pointerDown(control, { clientX: 100, clientY: 100 });
      fireEvent.click(control, { clientX: 100 + MOVE_THRESHOLD_PX, clientY: 100 });
      await flush();

      expect(columnCount()).toBe(before + 1);
    });

    it('a drag leaves no trace: the next plain click still adds one', async () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const control = document.querySelector('[data-testid="add-column-after-0-0"]')!;
      const before = columnCount();

      fireEvent.pointerDown(control, { clientX: 100, clientY: 100 });
      fireEvent.click(control, { clientX: 300, clientY: 100 });
      fireEvent.click(control, { clientX: 300, clientY: 100 });
      await flush();

      expect(columnCount()).toBe(before + 1);
    });

    it('controls are not <button>s, because a press on a button never starts a canvas pan', () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      const controls = document.querySelectorAll(
        '[data-testid^="add-column-"], [data-testid^="add-section-"]',
      );
      expect(controls.length).toBeGreaterThan(0);
      controls.forEach((control) => expect(control.closest('button')).toBeNull());
    });
  });

  // The add zones must not spill outside the canvas card, and column bodies
  // (the double-click-to-add-node area) must end where the card content does.
  describe('stay inside the canvas bounds', () => {
    it('graph container has no inline height in edit mode (content-driven)', async () => {
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      // updateSize fires in an effect; wait a microtask for the state flush.
      await Promise.resolve();
      const container = document.querySelector('div.min-w-fit') as HTMLElement;
      expect(container).not.toBeNull();
      expect(container.style.height).toBe('');
    });

    it('graph container keeps its explicit height in view mode', () => {
      render(<ToC data={makeBaseData()} showEditButton={false} />);
      const container = document.querySelector('div.min-w-fit') as HTMLElement;
      expect(container).not.toBeNull();
      expect(container.style.height).not.toBe('');
    });

    it('column bodies budget the chart title block only when it takes space', async () => {
      // With a title: 800px minimum canvas - 62px section header - 80px
      // title block. Without one the block is an overlay and is not in the
      // layout, so the body is 80px taller.
      render(<ToC data={makeBaseData()} showEditButton={true} />);
      await Promise.resolve();
      expect((document.querySelector('[data-column="0-0"]') as HTMLElement).style.height).toBe(
        '658px',
      );
      cleanup();
      render(<ToC data={{ ...makeBaseData(), title: '' }} showEditButton={true} />);
      await Promise.resolve();
      expect((document.querySelector('[data-column="0-0"]') as HTMLElement).style.height).toBe(
        '738px',
      );
    });
  });

  it('empty column body in edit mode shows the cursor-cell affordance class', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    // Section 1, column 0 is empty → its column div should carry
    // `cursor-cell` via the conditional class.
    const emptyCol = document.querySelector('[data-column="1-0"]') as HTMLElement | null;
    expect(emptyCol).not.toBeNull();
    expect(emptyCol!.className).toContain('cursor-cell');
  });

  it('non-empty column body does NOT carry cursor-cell (only empties do)', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const nonEmptyCol = document.querySelector('[data-column="0-0"]') as HTMLElement | null;
    expect(nonEmptyCol).not.toBeNull();
    expect(nonEmptyCol!.className).not.toContain('cursor-cell');
  });
});
