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
});
