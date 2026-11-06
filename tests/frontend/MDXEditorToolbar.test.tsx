// Tests for `MDXEditorComponent`'s toolbar layout (PR 34 feedback #48).
//
// The editor mounts inside the 288px-wide NodeEditor panel. The full
// control set is ~466px laid out in a single row, and MDXEditor's
// stock toolbar resolves overflow with `overflow-x: auto` — i.e. a
// horizontal scrollbar inside the tiny panel. The fix splits the
// controls into two explicit rows (`.mdx-toolbar-rows` >
// `.mdx-toolbar-row`) so everything stays visible without scrolling.
//
// jsdom can't measure layout (scrollWidth/clientWidth are always 0),
// so the geometric "no horizontal overflow" assertion lives in a
// browser check (rodney) run during review. What this test pins:
//   1. The two-row structure exists (a regression to the flat
//      single-row config would re-introduce the scrollbar).
//   2. Which controls are configured, and which row each lives in —
//      row 1: undo/redo + bold/italic/underline; row 2: the three
//      list toggles + the text-style select.
//   3. The text-style select is labelled "Text style" (the library's
//      default, "Block type", reads as jargon), while the library's
//      other strings, such as the "Heading 1" option, keep their text.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MDXEditorComponent } from '../../src/components/MDXEditor';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

// Toolbar buttons render an accessible name via title (TooltipWrap)
// or aria-label (the text-style select trigger).
function controlNames(row: HTMLElement): string[] {
  return Array.from(row.querySelectorAll('button')).map(
    (b) => b.getAttribute('title') ?? b.getAttribute('aria-label') ?? '',
  );
}

describe('MDXEditorComponent toolbar', () => {
  it('lays the formatting controls out in two rows (no single-row overflow)', async () => {
    render(<MDXEditorComponent markdown="Hello" />);

    // The toolbar mounts synchronously with the editor (no lazy chunk
    // at this level), but give Lexical a tick to settle.
    const toolbar = await screen.findByRole('toolbar');

    const rows = toolbar.querySelectorAll<HTMLElement>('.mdx-toolbar-rows > .mdx-toolbar-row');
    expect(rows).toHaveLength(2);

    // Row 1: history + inline formatting.
    expect(controlNames(rows[0])).toEqual([
      'Undo Ctrl+Z',
      'Redo Ctrl+Y',
      'Bold',
      'Italic',
      'Underline',
    ]);

    // Row 2: list toggles + text style select.
    expect(controlNames(rows[1])).toEqual([
      'Bulleted list',
      'Numbered list',
      'Check list',
      'Text style',
    ]);

    // The text-style select is the combobox in row 2.
    expect(within(rows[1]).getByRole('combobox', { name: 'Text style' })).toBeInTheDocument();
  });

  it('uses the same wording in the select tooltip', async () => {
    render(<MDXEditorComponent markdown="Hello" />);

    const trigger = await screen.findByRole('combobox', { name: 'Text style' });
    fireEvent.focus(trigger);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Select text style');
  });

  it('keeps the library default text for the select options', async () => {
    // Radix Select positions its popup with floating-ui (needs
    // ResizeObserver) and scrolls the active option into view; jsdom
    // provides neither.
    HTMLElement.prototype.scrollIntoView = () => {};
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    render(<MDXEditorComponent markdown="Hello" />);

    const trigger = await screen.findByRole('combobox', { name: 'Text style' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual([
      'Paragraph',
      'Quote',
      'Heading 1',
      'Heading 2',
      'Heading 3',
      'Heading 4',
      'Heading 5',
      'Heading 6',
    ]);
  });
});
