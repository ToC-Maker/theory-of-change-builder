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
}

// React passes `unknown` to the boundary lifecycle (`throw 'string'` and
// `throw null` are both legal), so we narrow before reaching for
// `.name` / `.message` / `.stack`.
interface State {
  error: unknown;
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, hasError: false };

  static getDerivedStateFromError(error: unknown): State {
    return { error, hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    // Fire-and-forget: never throws (loggingService.reportError swallows
    // network errors internally and falls back to sendBeacon).
    const e = error instanceof Error ? error : new Error(String(error));
    loggingService.reportError({
      error_name: e.name || 'Error',
      error_message: e.message || String(error),
      stack_trace: e.stack,
      request_metadata: {
        component: 'ErrorBoundary',
        componentStack: errorInfo.componentStack,
      },
    });
  }

  render(): ReactNode {
    if (this.state.hasError) {
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
