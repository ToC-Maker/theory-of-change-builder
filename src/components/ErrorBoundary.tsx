// React error boundary at the App root.
//
// Catches uncaught render-tree errors and ships them to
// `loggingService.reportError()` (already wired to the server-side
// `logging-reportError` endpoint), so production crashes land in the
// same observability store as fetch failures and client-side service
// errors. Distinct from sticky-rejected UI-event analytics — this is
// pure operational diagnostics.
//
// Fallback UI: minimal "An error occurred. Please refresh." with a
// reload button. No try-to-recover UX (state may be corrupt; the
// reload is the safe path).
//
// Why a class component: React's error-boundary API is class-only
// (`componentDidCatch` + `getDerivedStateFromError`). React 19 has no
// hooks-based equivalent.
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { loggingService } from '../services/loggingService';

interface Props {
  children: ReactNode;
  /**
   * Optional fallback. When omitted, the default reload UI is used. The
   * fallback receives the captured error and a `reset()` that resets the
   * boundary's own state (state may still be corrupt elsewhere).
   */
  fallback?: (args: { error: Error; reset: () => void }) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Fire-and-forget: never throws (loggingService.reportError swallows
    // network errors internally and falls back to sendBeacon).
    loggingService.reportError({
      error_name: error.name || 'Error',
      error_message: error.message || String(error),
      stack_trace: error.stack,
      request_metadata: {
        component: 'ErrorBoundary',
        componentStack: errorInfo.componentStack,
      },
    });
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      if (this.props.fallback) {
        return this.props.fallback({ error, reset: this.reset });
      }
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50 p-8">
          <div className="max-w-md w-full bg-white rounded-lg shadow p-8 text-center">
            <h1 className="text-2xl font-semibold text-gray-900 mb-2">An error occurred.</h1>
            <p className="text-gray-600 mb-6">Please refresh to recover.</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md font-medium transition-colors"
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
