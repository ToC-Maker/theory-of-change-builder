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

  it('confirmVariant=purple uses purple instead of red (GenerateConfirmDialog unification)', () => {
    render(
      <ConfirmModal
        open={true}
        title="T"
        body="B"
        confirmVariant="purple"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const btn = screen.getByTestId('confirm-modal-confirm');
    expect(btn.className).toContain('bg-purple-600');
    expect(btn.className).not.toContain('bg-red-600');
    expect(btn.className).not.toContain('bg-indigo-600');
  });

  it('confirmVariant=blue uses blue instead of red (PrivacyPolicyPopup unification)', () => {
    render(
      <ConfirmModal
        open={true}
        title="T"
        body="B"
        confirmVariant="blue"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const btn = screen.getByTestId('confirm-modal-confirm');
    expect(btn.className).toContain('bg-blue-600');
    expect(btn.className).not.toContain('bg-red-600');
    expect(btn.className).not.toContain('bg-indigo-600');
    expect(btn.className).not.toContain('bg-purple-600');
  });

  it('renders supplied icon node above the title when provided', () => {
    render(
      <ConfirmModal
        open={true}
        title="T"
        body="B"
        icon={<span data-testid="confirm-modal-icon-fixture">icon</span>}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByTestId('confirm-modal-icon-fixture')).toBeInTheDocument();
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

  // singleAction mode (PrivacyPolicyPopup unification). A non-dismissable
  // single-button modal: no cancel button, backdrop click is inert, and
  // Escape doesn't close. Needed for the privacy gate that demands an
  // explicit acknowledgment.
  describe('singleAction mode', () => {
    it('renders only the confirm button when singleAction=true', () => {
      render(
        <ConfirmModal
          open={true}
          title="T"
          body="B"
          singleAction
          onConfirm={noop}
          onCancel={noop}
        />,
      );
      expect(screen.getByTestId('confirm-modal-confirm')).toBeInTheDocument();
      expect(screen.queryByTestId('confirm-modal-cancel')).toBeNull();
    });

    it('backdrop click does NOT fire onCancel when singleAction=true', () => {
      const onCancel = vi.fn();
      render(
        <ConfirmModal
          open={true}
          title="T"
          body="B"
          singleAction
          onConfirm={noop}
          onCancel={onCancel}
        />,
      );
      fireEvent.click(screen.getByTestId('confirm-modal-backdrop'));
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('Escape key does NOT fire onCancel when singleAction=true', () => {
      const onCancel = vi.fn();
      render(
        <ConfirmModal
          open={true}
          title="T"
          body="B"
          singleAction
          onConfirm={noop}
          onCancel={onCancel}
        />,
      );
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('Enter still fires onConfirm when singleAction=true', () => {
      const onConfirm = vi.fn();
      render(
        <ConfirmModal
          open={true}
          title="T"
          body="B"
          singleAction
          onConfirm={onConfirm}
          onCancel={noop}
        />,
      );
      fireEvent.keyDown(document, { key: 'Enter' });
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  // extras slot — renders supplemental UI (checkbox row, policy link, etc.)
  // between the body and the action buttons. Used by PrivacyPolicyPopup
  // for the "Help improve AI" opt-in + policy link row.
  it('renders extras node between body and action buttons', () => {
    render(
      <ConfirmModal
        open={true}
        title="T"
        body="B"
        extras={<span data-testid="confirm-modal-extras-fixture">extras</span>}
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    expect(screen.getByTestId('confirm-modal-extras-fixture')).toBeInTheDocument();
  });
});
