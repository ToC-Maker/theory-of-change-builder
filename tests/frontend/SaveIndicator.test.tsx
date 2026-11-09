// Tests for SaveIndicator — the top-bar status pill.
//
// States (PR 7 round-2 feedback (57): "it should be clear when the
// chart is not saved, not just when it's saving or saved"):
//   - Saving:          spinner + "Saving" (a save attempt is in flight)
//   - Unsaved changes: amber dot + "Unsaved changes" (local edits not
//                      yet persisted)
//   - Unsaved changes (failed save): red dot + "Unsaved changes" +
//                      tooltip carrying the failure message. A failed
//                      save must NEVER show a stale "Saved" — this is
//                      exactly the silent-save-failure situation from
//                      the signed-in 401/403 report.
//   - Error:           red dot + "Error" + tooltip — failures that do
//                      not leave unsaved edits behind (e.g. a failed
//                      chart delete).
//   - Saved:           green check + "Saved".
//
// `loggingService.reportError` is called once per error-state transition
// (so re-renders while the error persists don't spam). The component
// debounces by tracking the last-reported transition.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SaveIndicator } from '../../src/components/top-bar/SaveIndicator';
import { loggingService } from '../../src/services/loggingService';

beforeEach(() => {
  vi.spyOn(loggingService, 'reportError').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SaveIndicator', () => {
  it('renders Saving copy with spinner when isSaving=true', () => {
    render(
      <SaveIndicator
        isSaving={true}
        hasEditToken={true}
        saveError={null}
        hasPendingChanges={true}
      />,
    );
    expect(screen.getByText(/saving/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'saving');
  });

  it('renders Saved copy when not saving, clean, and edit token is present', () => {
    render(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={null}
        hasPendingChanges={false}
      />,
    );
    expect(screen.getByText(/saved/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'saved');
  });

  it('renders "Unsaved changes" when local edits exist that have not been persisted', () => {
    // PR 7 fb (57): dirty-but-not-yet-saving must not read as "Saved".
    render(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={null}
        hasPendingChanges={true}
      />,
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('data-state', 'unsaved');
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
    expect(screen.queryByText(/^saved$/i)).toBeNull();
  });

  it('renders "Unsaved changes" with the failure tooltip when a save FAILS', () => {
    // The reviewer's 401/403 situation: autosave fails, edits remain
    // local-only. Must show "Unsaved changes" (with the reason on
    // hover) — not a stale "Saved", and not a bare "Error" that hides
    // the data-loss risk.
    render(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={{ message: 'Invalid or expired authentication. Please log in again.' }}
        hasPendingChanges={true}
      />,
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('data-state', 'unsaved');
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
    expect(region).toHaveAttribute(
      'data-tooltip-content',
      'Invalid or expired authentication. Please log in again.',
    );
    expect(screen.queryByText(/^saved$/i)).toBeNull();
  });

  it('keeps the plain Error state for failures without pending edits (e.g. delete failed)', () => {
    render(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={{ message: 'Failed to delete chart' }}
        hasPendingChanges={false}
      />,
    );
    const errorRegion = screen.getByRole('status');
    expect(errorRegion).toHaveAttribute('data-state', 'error');
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });

  it('shows Saving (not Unsaved changes) while a retry save is in flight', () => {
    // isSaving wins over the dirty flag: feedback that the app is
    // actively retrying. If the retry fails, the state falls back to
    // "Unsaved changes" via the saveError branch.
    render(
      <SaveIndicator
        isSaving={true}
        hasEditToken={true}
        saveError={null}
        hasPendingChanges={true}
      />,
    );
    expect(screen.getByRole('status')).toHaveAttribute('data-state', 'saving');
    expect(screen.queryByText(/unsaved changes/i)).toBeNull();
  });

  it('calls loggingService.reportError once on transition into a failed-save state', () => {
    const reportSpy = vi.spyOn(loggingService, 'reportError').mockImplementation(() => {});

    const { rerender } = render(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={null}
        hasPendingChanges={false}
      />,
    );
    expect(reportSpy).not.toHaveBeenCalled();

    // Transition into error.
    rerender(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={{ message: 'Network down' }}
        hasPendingChanges={true}
      />,
    );
    expect(reportSpy).toHaveBeenCalledTimes(1);
    expect(reportSpy.mock.calls[0]?.[0]).toMatchObject({
      error_name: 'SaveError',
      error_message: expect.stringMatching(/network down/i),
      request_metadata: { component: 'SaveIndicator' },
    });

    // Re-render with same error: no duplicate report.
    rerender(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={{ message: 'Network down' }}
        hasPendingChanges={true}
      />,
    );
    expect(reportSpy).toHaveBeenCalledTimes(1);
  });

  it('re-reports after a recovery and a fresh error', () => {
    const reportSpy = vi.spyOn(loggingService, 'reportError').mockImplementation(() => {});

    const { rerender } = render(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={{ message: 'first failure' }}
        hasPendingChanges={true}
      />,
    );
    expect(reportSpy).toHaveBeenCalledTimes(1);

    // Recover.
    rerender(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={null}
        hasPendingChanges={false}
      />,
    );
    expect(reportSpy).toHaveBeenCalledTimes(1);

    // Fresh error.
    rerender(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={{ message: 'second failure' }}
        hasPendingChanges={true}
      />,
    );
    expect(reportSpy).toHaveBeenCalledTimes(2);
  });

  it('renders nothing when there is no edit token and no error', () => {
    // Pre-share scratch state: the chart has no DB save target yet;
    // edits persist to localStorage. (Dirty-tracking applies once an
    // edit token exists.)
    const { container } = render(
      <SaveIndicator
        isSaving={false}
        hasEditToken={false}
        saveError={null}
        hasPendingChanges={true}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
