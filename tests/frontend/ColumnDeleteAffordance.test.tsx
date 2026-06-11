// PR 5 Task 5.3 regression test for ColumnDeleteAffordance.
//
// Asserts:
//   - × button renders unconditionally; its visibility is purely a CSS
//     concern (driven by the surrounding column / section's
//     `group-hover`), so we don't test opacity — only existence.
//   - Click opens the ConfirmModal.
//   - Confirm → calls `onDelete()`; modal closes.
//   - Cancel → does NOT call `onDelete()`; modal closes.
//   - Modal body copy adapts to node-count (empty vs non-empty).
//   - Both `column` and `section` scopes work and produce the right
//     test-id prefix.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ColumnDeleteAffordance } from '../../src/components/canvas/ColumnDeleteAffordance';

afterEach(() => {
  cleanup();
});

describe('ColumnDeleteAffordance', () => {
  it('renders the × button', () => {
    render(<ColumnDeleteAffordance nodeCount={0} scope="column" onDelete={vi.fn()} />);
    expect(screen.getByTestId('column-delete')).toBeInTheDocument();
  });

  it('renders with the optional testIdSuffix', () => {
    render(
      <ColumnDeleteAffordance nodeCount={0} scope="column" onDelete={vi.fn()} testIdSuffix="0-1" />,
    );
    expect(screen.getByTestId('column-delete-0-1')).toBeInTheDocument();
  });

  it('opens the confirm modal on click and shows empty-state copy when nodeCount=0', async () => {
    const user = userEvent.setup();
    render(<ColumnDeleteAffordance nodeCount={0} scope="column" onDelete={vi.fn()} />);
    await user.click(screen.getByTestId('column-delete'));
    const modal = screen.getByTestId('confirm-modal');
    expect(modal).toBeInTheDocument();
    expect(modal.textContent).toContain('Delete this empty column');
  });

  it('shows count-aware copy when nodeCount>0 (singular)', async () => {
    const user = userEvent.setup();
    render(<ColumnDeleteAffordance nodeCount={1} scope="column" onDelete={vi.fn()} />);
    await user.click(screen.getByTestId('column-delete'));
    const modal = screen.getByTestId('confirm-modal');
    expect(modal.textContent).toContain('1 node');
    expect(modal.textContent).toContain('that node');
  });

  it('shows count-aware copy when nodeCount>1 (plural)', async () => {
    const user = userEvent.setup();
    render(<ColumnDeleteAffordance nodeCount={3} scope="column" onDelete={vi.fn()} />);
    await user.click(screen.getByTestId('column-delete'));
    expect(screen.getByTestId('confirm-modal').textContent).toContain('3 nodes');
    expect(screen.getByTestId('confirm-modal').textContent).toContain('all of them');
  });

  it('confirms → calls onDelete and closes the modal', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<ColumnDeleteAffordance nodeCount={2} scope="column" onDelete={onDelete} />);
    await user.click(screen.getByTestId('column-delete'));
    await user.click(screen.getByTestId('confirm-modal-confirm'));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('confirm-modal')).toBeNull();
  });

  it('cancels → does NOT call onDelete and closes the modal', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    render(<ColumnDeleteAffordance nodeCount={2} scope="column" onDelete={onDelete} />);
    await user.click(screen.getByTestId('column-delete'));
    await user.click(screen.getByTestId('confirm-modal-cancel'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-modal')).toBeNull();
  });

  it('section scope produces section-prefixed test-ids and copy', async () => {
    const user = userEvent.setup();
    render(
      <ColumnDeleteAffordance nodeCount={5} scope="section" onDelete={vi.fn()} testIdSuffix="2" />,
    );
    expect(screen.getByTestId('section-delete-2')).toBeInTheDocument();
    await user.click(screen.getByTestId('section-delete-2'));
    const modal = screen.getByTestId('confirm-modal');
    expect(modal.textContent).toContain('Delete section');
    expect(modal.textContent).toContain('section contains 5 node');
  });

  it('click on × does not bubble (parent click handlers do not fire)', () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <ColumnDeleteAffordance nodeCount={0} scope="column" onDelete={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByTestId('column-delete'));
    expect(parentClick).not.toHaveBeenCalled();
  });

  // PR 7 round-2 feedback (issue 54): "The delete icons shouldn't have a
  // background and outline, just the cross, and maybe we should just use
  // a bin." Contract: the affordance is a bare trash glyph — no
  // background, border/outline, or shadow classes in ANY state (rest or
  // hover). The only permitted ring is the keyboard focus indicator
  // (`focus-visible:ring-*`), which is not the resting outline the
  // reviewer objected to.
  describe('bare-glyph visual contract', () => {
    it('column scope: no background / border / shadow classes; ring only behind focus-visible', () => {
      render(<ColumnDeleteAffordance nodeCount={0} scope="column" onDelete={vi.fn()} />);
      const btn = screen.getByTestId('column-delete');
      expect(btn.className).not.toMatch(/bg-/); // no resting or hover background
      expect(btn.className).not.toMatch(/border/); // no outline
      expect(btn.className).not.toMatch(/shadow/); // no elevation chip
      // Any ring-* must be gated on focus-visible (keyboard focus indicator).
      expect(btn.className.match(/(?<!focus-visible:)ring-/)).toBeNull();
    });

    it('column scope: renders a bin glyph, dark-on-light tone, hover-to-red', () => {
      render(<ColumnDeleteAffordance nodeCount={0} scope="column" onDelete={vi.fn()} />);
      const btn = screen.getByTestId('column-delete');
      expect(btn.querySelector('svg')).not.toBeNull();
      expect(btn.className).toContain('text-gray-400');
      expect(btn.className).toContain('hover:text-red-500');
    });

    it('section scope: light icon for the dark title bar (no bg/border/shadow either)', () => {
      render(<ColumnDeleteAffordance nodeCount={0} scope="section" onDelete={vi.fn()} />);
      const btn = screen.getByTestId('section-delete');
      expect(btn.className).not.toMatch(/bg-/);
      expect(btn.className).not.toMatch(/border/);
      expect(btn.className).not.toMatch(/shadow/);
      expect(btn.className).toContain('text-white/70');
      expect(btn.className).toContain('hover:text-white');
    });

    it('preserves the named-group hover-reveal scoping per scope', () => {
      render(
        <>
          <ColumnDeleteAffordance nodeCount={0} scope="column" onDelete={vi.fn()} />
          <ColumnDeleteAffordance nodeCount={0} scope="section" onDelete={vi.fn()} />
        </>,
      );
      const column = screen.getByTestId('column-delete');
      const section = screen.getByTestId('section-delete');
      expect(column.className).toContain('opacity-0');
      expect(column.className).toContain('group-hover/column:opacity-100');
      expect(section.className).toContain('opacity-0');
      expect(section.className).toContain('group-hover/section:opacity-100');
    });

    it('keyboard focus stays visible: focus-visible ring + opacity reveal', () => {
      render(<ColumnDeleteAffordance nodeCount={0} scope="column" onDelete={vi.fn()} />);
      const btn = screen.getByTestId('column-delete');
      expect(btn.className).toMatch(/focus-visible:ring-2/);
      expect(btn.className).toMatch(/focus-visible:opacity-100/);
    });
  });
});
