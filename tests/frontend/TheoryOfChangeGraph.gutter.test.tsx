// PR 5 Task 5.1 regression tests: always-on add affordances.
//
// Asserts the layout-mode gate has been removed from the column-gutter
// and section-padding divs. In edit mode they render unconditionally;
// hover-only label visibility is a CSS concern (driven by the
// `group-hover:opacity-100` Tailwind utility); clicking adds the
// corresponding column or section via the standard mutation path.
//
// We don't ship a `layoutMode` toggle in the rendered surface anymore
// (Task 5.4 deletes the state outright), so the tests express the
// expected behavior post-removal: gutters present in edit mode, absent
// in view mode.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { ToC } from '../../src/components/TheoryOfChangeGraph';
import type { ToCData } from '../../src/types';

afterEach(() => {
  cleanup();
});

// Several click-handlers in TheoryOfChangeGraph mutate `prevData.sections`
// via `.splice()` inside the `setDataAndNotify` updater (the surrounding
// `{ ...prevData }` is only a shallow copy). That mutation leaks into a
// shared `makeBaseData()` fixture across tests, so each test gets a fresh deep
// clone. Fixing the underlying mutation is out of PR 5 scope — see
// `.implementation-log.md` "Deviations" for the follow-up.
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
      ],
    },
    {
      title: 'Outputs',
      columns: [{ nodes: [] }],
    },
  ],
});

describe('TheoryOfChangeGraph (PR 5 Task 5.1 always-on gutters)', () => {
  it('renders the before-section gutter for every section in edit mode', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    // Two sections → two before-section gutters (one per section).
    const gutters = document.querySelectorAll('[data-testid="add-section-before"]');
    expect(gutters.length).toBe(2);
  });

  it('renders the after-last-section gutter in edit mode', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    const last = document.querySelector('[data-testid="add-section-after-last"]');
    expect(last).not.toBeNull();
  });

  it('renders the before-first-column gutter for each section in edit mode', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    // Two sections → one before-first-column gutter per section.
    // testid = add-column-before-${sectionIndex}-${colIndex} with colIndex=0.
    const s0 = document.querySelector('[data-testid="add-column-before-0-0"]');
    const s1 = document.querySelector('[data-testid="add-column-before-1-0"]');
    expect(s0).not.toBeNull();
    expect(s1).not.toBeNull();
  });

  it('renders the after-column gutter for every column in edit mode', () => {
    render(<ToC data={makeBaseData()} showEditButton={true} />);
    // Section 0 has 1 column → 1 after-column gutter.
    // Section 1 has 1 column → 1 after-column gutter.
    expect(document.querySelector('[data-testid="add-column-after-0-0"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="add-column-after-1-0"]')).not.toBeNull();
  });

  it('does NOT render any gutters in view-only mode', () => {
    render(<ToC data={makeBaseData()} showEditButton={false} />);
    expect(document.querySelectorAll('[data-testid="add-section-before"]').length).toBe(0);
    expect(document.querySelector('[data-testid="add-section-after-last"]')).toBeNull();
    expect(document.querySelector('[data-testid^="add-column-before-"]')).toBeNull();
    expect(document.querySelector('[data-testid^="add-column-after-"]')).toBeNull();
  });

  it('clicking the before-section gutter splices a new section at that index', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    const beforeFirst = document.querySelectorAll('[data-testid="add-section-before"]')[0];
    expect(beforeFirst).toBeTruthy();
    fireEvent.click(beforeFirst);

    // `onDataChange` is flushed via queueMicrotask in useGraphMutation;
    // we wait for the microtask then assert.
    return Promise.resolve().then(() => {
      // The new section is inserted at index 0; existing sections
      // shift right.
      expect(onDataChange).toHaveBeenCalled();
      const arg = onDataChange.mock.calls[onDataChange.mock.calls.length - 1][0] as ToCData;
      expect(arg.sections.length).toBe(3);
      expect(arg.sections[0].title).toBe('New Section');
      expect(arg.sections[1].title).toBe('Inputs');
    });
  });

  it('clicking the before-first-column gutter splices a new column at index 0', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    const gutter = document.querySelector('[data-testid="add-column-before-0-0"]')!;
    fireEvent.click(gutter);

    return Promise.resolve().then(() => {
      expect(onDataChange).toHaveBeenCalled();
      const arg = onDataChange.mock.calls[onDataChange.mock.calls.length - 1][0] as ToCData;
      // Section 0 now has 2 columns; the new one is at index 0 with no nodes.
      expect(arg.sections[0].columns.length).toBe(2);
      expect(arg.sections[0].columns[0].nodes.length).toBe(0);
      expect(arg.sections[0].columns[1].nodes.length).toBe(1);
    });
  });

  it('clicking the after-column gutter splices a new column after that column', () => {
    const onDataChange = vi.fn();
    render(<ToC data={makeBaseData()} showEditButton={true} onDataChange={onDataChange} />);
    const gutter = document.querySelector('[data-testid="add-column-after-0-0"]')!;
    fireEvent.click(gutter);

    return Promise.resolve().then(() => {
      expect(onDataChange).toHaveBeenCalled();
      const arg = onDataChange.mock.calls[onDataChange.mock.calls.length - 1][0] as ToCData;
      expect(arg.sections[0].columns.length).toBe(2);
      // Original column stays at index 0; new one is at index 1.
      expect(arg.sections[0].columns[0].nodes.length).toBe(1);
      expect(arg.sections[0].columns[1].nodes.length).toBe(0);
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
