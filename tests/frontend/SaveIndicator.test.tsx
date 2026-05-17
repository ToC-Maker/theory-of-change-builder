// Tests for SaveIndicator — the top-bar status pill.
//
// Three states it reports: Saving (spinner + "Saving"), Saved (green
// dot + "Saved"), and Error (red dot + tooltip + reportError fire).
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
    render(<SaveIndicator isSaving={true} hasEditToken={true} saveError={null} />);
    expect(screen.getByText(/saving/i)).toBeInTheDocument();
  });

  it('renders Saved copy when not saving and edit token is present', () => {
    render(<SaveIndicator isSaving={false} hasEditToken={true} saveError={null} />);
    expect(screen.getByText(/saved/i)).toBeInTheDocument();
  });

  it('renders Error copy with red dot when saveError is set', () => {
    render(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={{ message: 'Network down' }}
      />,
    );
    const errorRegion = screen.getByRole('status');
    expect(errorRegion).toHaveAttribute('data-state', 'error');
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });

  it('calls loggingService.reportError once on transition into error state', () => {
    const reportSpy = vi.spyOn(loggingService, 'reportError').mockImplementation(() => {});

    const { rerender } = render(
      <SaveIndicator isSaving={false} hasEditToken={true} saveError={null} />,
    );
    expect(reportSpy).not.toHaveBeenCalled();

    // Transition into error.
    rerender(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={{ message: 'Network down' }}
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
      />,
    );
    expect(reportSpy).toHaveBeenCalledTimes(1);

    // Recover.
    rerender(<SaveIndicator isSaving={false} hasEditToken={true} saveError={null} />);
    expect(reportSpy).toHaveBeenCalledTimes(1);

    // Fresh error.
    rerender(
      <SaveIndicator
        isSaving={false}
        hasEditToken={true}
        saveError={{ message: 'second failure' }}
      />,
    );
    expect(reportSpy).toHaveBeenCalledTimes(2);
  });

  it('renders nothing when there is no edit token and no error', () => {
    const { container } = render(
      <SaveIndicator isSaving={false} hasEditToken={false} saveError={null} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
