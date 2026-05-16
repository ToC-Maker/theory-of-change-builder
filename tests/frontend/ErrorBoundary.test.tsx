// Tests for the App-root React error boundary.
//
// `loggingService.reportError` already exists for client-side error
// reporting (server-side `logging-reportError` endpoint). The boundary
// hooks `componentDidCatch` into that pipeline so production crashes
// land in the same observability store as fetch-failure reports.
//
// Acceptance:
//   - Throwing in a child triggers `loggingService.reportError` with
//     the error name, message, and a `component: 'ErrorBoundary'` tag
//     in the request_metadata.
//   - Fallback UI renders ("An error occurred. Please refresh." + reload).
//   - Stack trace is forwarded (sliced by loggingService).
//
// React logs the error to console.error by default during the boundary
// flow; tests suppress that to keep output readable.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';
import { loggingService } from '../../src/services/loggingService';

const Boom = (): JSX.Element => {
  throw new Error('boom');
};

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders children normally when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div data-testid="child">hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('renders fallback UI and calls loggingService.reportError on caught error', () => {
    const reportSpy = vi.spyOn(loggingService, 'reportError').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );

    // Fallback UI is visible.
    expect(screen.getByText(/an error occurred/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh|reload/i })).toBeInTheDocument();

    // loggingService got the error.
    expect(reportSpy).toHaveBeenCalledTimes(1);
    const call = reportSpy.mock.calls[0]?.[0];
    expect(call?.error_name).toBe('Error');
    expect(call?.error_message).toContain('boom');
    expect(call?.request_metadata).toMatchObject({ component: 'ErrorBoundary' });
    // Stack present (sliced by loggingService — we only assert it's a string).
    expect(typeof call?.stack_trace).toBe('string');
  });
});
