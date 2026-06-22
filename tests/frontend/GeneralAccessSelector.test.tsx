// Tests for GeneralAccessSelector — the 3-mode access picker (plan
// §PR 2 Task 2.1 + Task 2.2).
//
// Two acceptance surfaces:
//   1. All three modes are selectable inline (no dropdown collapse) and
//      labelled with the exact strings per user-direction sticky:
//        - "Restricted"        — "Only approved people can view or edit."
//        - "Anyone can view"   — "Public view link. Editors must be approved."
//        - "Anyone can edit"   — "Public view and edit links. No approval needed."
//   2. Switching FROM a non-restricted mode TO 'restricted' triggers a
//      ConfirmModal gate (plan §170 Critical: embed silently breaks).
//      The five other transitions (restricted -> viewer, restricted ->
//      editor, viewer <-> editor) commit immediately.
//
// We don't snapshot pixel layout; preflight + manual smoke handle that.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GeneralAccessSelector } from '../../src/components/share/GeneralAccessSelector';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GeneralAccessSelector', () => {
  it('renders all three modes with their exact labels and subtexts', () => {
    render(<GeneralAccessSelector value="restricted" onChange={() => {}} />);

    // Labels.
    expect(screen.getByText('Restricted')).toBeInTheDocument();
    expect(screen.getByText('Anyone can view')).toBeInTheDocument();
    expect(screen.getByText('Anyone can edit')).toBeInTheDocument();

    // Subtexts (one-sentence each, per user-direction).
    expect(screen.getByText('Only approved people can view or edit.')).toBeInTheDocument();
    expect(screen.getByText('Public view link. Editors must be approved.')).toBeInTheDocument();
    expect(screen.getByText('Public view and edit links. No approval needed.')).toBeInTheDocument();
  });

  it('reflects the currently-selected mode (radio-style)', () => {
    render(<GeneralAccessSelector value="viewer" onChange={() => {}} />);
    // The selected option exposes aria-checked=true on its role=radio
    // affordance.
    const viewerRadio = screen.getByRole('radio', { name: /anyone can view/i });
    expect(viewerRadio).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /restricted/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('commits restricted -> viewer immediately (no confirmation)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GeneralAccessSelector value="restricted" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: /anyone can view/i }));
    expect(onChange).toHaveBeenCalledWith('viewer');
    // No ConfirmModal opened on this transition direction.
    expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
  });

  it('commits viewer -> editor immediately (no confirmation)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GeneralAccessSelector value="viewer" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: /anyone can edit/i }));
    expect(onChange).toHaveBeenCalledWith('editor');
    expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
  });

  it('asks for confirmation when changing viewer -> restricted (embed-break warning)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GeneralAccessSelector value="viewer" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: /restricted/i }));

    // ConfirmModal opens; its body mentions embed and Restricted;
    // onChange is NOT called until the user confirms.
    const modal = screen.getByTestId('confirm-modal');
    expect(modal).toBeInTheDocument();
    expect(modal.textContent).toMatch(/embed/i);
    expect(modal.textContent).toMatch(/restricted/i);
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('confirm-modal-confirm'));
    expect(onChange).toHaveBeenCalledWith('restricted');
  });

  it('asks for confirmation when changing editor -> restricted (embed-break warning)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GeneralAccessSelector value="editor" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: /restricted/i }));

    expect(screen.getByTestId('confirm-modal')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('confirm-modal-confirm'));
    expect(onChange).toHaveBeenCalledWith('restricted');
  });

  it('aborts the change when the user cancels the confirmation', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GeneralAccessSelector value="viewer" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: /restricted/i }));
    expect(screen.getByTestId('confirm-modal')).toBeInTheDocument();

    await user.click(screen.getByTestId('confirm-modal-cancel'));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
  });

  it('does not prompt when re-selecting the current mode', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<GeneralAccessSelector value="restricted" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: /restricted/i }));
    expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
    // No-op clicks do not redundantly call onChange (the contract is
    // "fires on actual mode change"); both behaviours are acceptable so
    // we accept either, just assert "no confirm popup".
  });

  it('disables interaction in read-only mode', () => {
    render(<GeneralAccessSelector value="viewer" onChange={() => {}} disabled />);
    const restrictedRadio = screen.getByRole('radio', { name: /restricted/i });
    expect(restrictedRadio).toBeDisabled();
  });
});
