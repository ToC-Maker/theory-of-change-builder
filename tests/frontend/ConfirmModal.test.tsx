// PR 5 Task 5.3 regression test for ConfirmModal.
//
// Pins the contract the FileMenu and ColumnDeleteAffordance depend on:
//   - `open=false` renders nothing.
//   - `open=true` portals into document.body (modal is not nested).
//   - Cancel + backdrop click + Escape all fire onCancel.
//   - Confirm button + Enter both fire onConfirm.
//   - Enter inside a textarea does NOT trigger confirm.
//   - `confirmVariant=danger` adds the red color class.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { ConfirmModal } from '../../src/components/ConfirmModal';

afterEach(() => {
  cleanup();
});

const noop = () => undefined;

describe('ConfirmModal', () => {
  it('renders nothing when open=false', () => {
    render(
      <ConfirmModal open={false} title="Title" body="Body" onConfirm={noop} onCancel={noop} />,
    );
    expect(screen.queryByTestId('confirm-modal')).toBeNull();
  });

  it('renders into document.body when open=true', () => {
    const { container } = render(
      <ConfirmModal open={true} title="Title" body="Body" onConfirm={noop} onCancel={noop} />,
    );
    // Portaled — should NOT be inside the test container.
    expect(container.querySelector('[data-testid="confirm-modal"]')).toBeNull();
    expect(screen.getByTestId('confirm-modal')).toBeInTheDocument();
  });

  it('confirm button click fires onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal open={true} title="T" body="B" onConfirm={onConfirm} onCancel={noop} />);
    fireEvent.click(screen.getByTestId('confirm-modal-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('cancel button click fires onCancel', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal open={true} title="T" body="B" onConfirm={noop} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('confirm-modal-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('backdrop click fires onCancel', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal open={true} title="T" body="B" onConfirm={noop} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId('confirm-modal-backdrop'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape key fires onCancel', () => {
    const onCancel = vi.fn();
    render(<ConfirmModal open={true} title="T" body="B" onConfirm={noop} onCancel={onCancel} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Enter key fires onConfirm', () => {
    const onConfirm = vi.fn();
    render(<ConfirmModal open={true} title="T" body="B" onConfirm={onConfirm} onCancel={noop} />);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('Enter inside a textarea does NOT trigger onConfirm', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmModal
        open={true}
        title="T"
        body={<textarea defaultValue="" data-testid="my-textarea" />}
        onConfirm={onConfirm}
        onCancel={noop}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('my-textarea'), { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirmVariant=danger adds the red color class to the confirm button', () => {
    render(
      <ConfirmModal
        open={true}
        title="T"
        body="B"
        confirmVariant="danger"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const btn = screen.getByTestId('confirm-modal-confirm');
    expect(btn.className).toContain('bg-red-600');
  });

  it('confirmVariant=primary uses indigo instead of red', () => {
    render(
      <ConfirmModal
        open={true}
        title="T"
        body="B"
        confirmVariant="primary"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const btn = screen.getByTestId('confirm-modal-confirm');
    expect(btn.className).toContain('bg-indigo-600');
    expect(btn.className).not.toContain('bg-red-600');
  });

  it('shows custom confirmLabel and cancelLabel when supplied', () => {
    render(
      <ConfirmModal
        open={true}
        title="T"
        body="B"
        confirmLabel="Yes, delete"
        cancelLabel="Never mind"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByTestId('confirm-modal-confirm').textContent).toBe('Yes, delete');
    expect(screen.getByTestId('confirm-modal-cancel').textContent).toBe('Never mind');
  });
});
