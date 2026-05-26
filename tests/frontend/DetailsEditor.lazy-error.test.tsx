// Tests for `DetailsEditor` — focused on the failure mode where the
// lazy `MDXEditor` chunk fails to load (chunk hash rotated after deploy,
// transient CDN error, network blip).
//
// Before the local ErrorBoundary fix, a rejected `lazy(() => import())`
// promise propagated past <Suspense> to the root ErrorBoundary, which
// rendered a full-screen "Please refresh." UI and lost the user's
// in-progress typing in the rest of NodeEditor.
//
// The fix wraps the Suspense in a local boundary that:
//   1. Logs to loggingService.reportError with component='DetailsEditor'.
//   2. Renders an inline error fallback inside the editor section
//      ("Editor failed to load. Retry").
//   3. Leaves the rest of NodeEditor (title input, width, color, delete
//      button) functional (out-of-scope here — covered by the
//      surrounding NodeEditor tests).
//
// Acceptance:
//   - Rejected dynamic import → inline error UI inside the editor
//     section (NOT the root ErrorBoundary), with a Retry button.
//   - loggingService.reportError is called with the component tag.
//
// Note: PR 7 dropped the "Edit details" toggle; the MDXEditor now
// mounts directly with the editor. The lazy-load test no longer has
// to click the toggle first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { lazy } from 'react';
import { DetailsEditor } from '../../src/components/node-editor/DetailsEditor';
import { loggingService } from '../../src/services/loggingService';

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  // React logs the boundary catch to console.error; suppress for clean output.
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  consoleErrorSpy.mockRestore();
  vi.restoreAllMocks();
});

/** Build a lazy component whose import promise rejects synchronously. */
function buildFailingLazy() {
  return lazy(() =>
    Promise.reject(new Error('chunk-load-failed: simulated lazy import rejection')),
  );
}

describe('DetailsEditor — lazy-load failure', () => {
  // Longer test timeout: the full preflight runs this alongside the
  // workerd pool, which can stretch the React commit window past the
  // default 5s on slow CI / contended hosts.
  it('shows inline error UI with Retry when the MDXEditor chunk fails to load', async () => {
    const reportSpy = vi.spyOn(loggingService, 'reportError').mockImplementation(() => {});

    render(<DetailsEditor markdown="" onChange={() => {}} lazyFactory={buildFailingLazy} />);

    // No toggle to click — the lazy import kicks off on mount (the
    // accordion was removed in PR 7 / feedback-editor). Wait for the
    // inline error UI to render after the rejection commits.
    await waitFor(
      () => {
        expect(screen.getByText(/editor failed to load/i)).toBeInTheDocument();
      },
      { timeout: 10000 },
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

    // The root error boundary's reload UI must NOT be visible. We
    // assert by absence of its hallmark copy.
    expect(screen.queryByText(/please refresh to recover/i)).not.toBeInTheDocument();

    // loggingService got the error with the DetailsEditor tag.
    expect(reportSpy).toHaveBeenCalled();
    const call = reportSpy.mock.calls[0]?.[0];
    expect(call?.request_metadata).toMatchObject({ component: 'DetailsEditor' });
  }, 15000);
});
