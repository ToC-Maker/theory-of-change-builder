// SaveIndicator — small pill in the right side of the TopBar.
//
// States (PR 7 round-2 feedback (57): "it should be clear when the
// chart is not saved, not just when it's saving or saved"):
//   - Saving:           spinner + "Saving"   (a save attempt in flight)
//   - Unsaved changes:  amber dot + "Unsaved changes" (local edits not
//                       persisted yet)
//   - Unsaved changes,  red dot + "Unsaved changes" + tooltip with the
//     failed save:      failure message. A failed save must NEVER show
//                       a stale "Saved" — the round-2 signed-in 401/403
//                       report was exactly this: every autosave 403'd
//                       while the pill suggested all was well.
//   - Error:            red dot + "Error" + tooltip — failures that do
//                       NOT leave unsaved edits behind (e.g. a failed
//                       chart delete reported via the same channel).
//   - Saved:            green check + "Saved".
//
// Priority: error/unsaved-failed > saving > unsaved > saved. The
// failure state outranks "Saving" so a retry attempt doesn't blink the
// warning away; success clears `saveError` and the pill recovers.
//
// When in a failure state, we fire `loggingService.reportError` exactly
// once per transition into error (debounced via a ref of the previous
// fingerprint). Re-renders that keep the same error don't re-report;
// a recovery clears the fingerprint, so a *new* failure later does
// report again. This mirrors the SaveIndicator-failure-path resolution
// in the redesign plan §0 (red-team finding "SaveIndicator failure-path
// display").
//
// The pill returns null when no edit token exists and no error is set —
// pre-share state has no DB save target to report on (edits persist to
// localStorage until the chart is created).
import { useEffect, useRef } from 'react';
import { Tooltip } from 'react-tooltip';
import { loggingService } from '../../services/loggingService';

export interface SaveError {
  message: string;
}

interface Props {
  isSaving: boolean;
  hasEditToken: boolean;
  saveError: SaveError | null;
  /**
   * True while local edits exist that have not been persisted to the
   * server (App mirrors its `pendingChangesRef` into state). Drives the
   * "Unsaved changes" state — including after a FAILED save, when the
   * edits silently survive only in memory/localStorage.
   */
  hasPendingChanges: boolean;
}

export function SaveIndicator({ isSaving, hasEditToken, saveError, hasPendingChanges }: Props) {
  // Fingerprint of the last reported error transition. We re-fire only
  // when the fingerprint changes (so re-renders with the *same* error
  // don't spam logging).
  const lastReportedFingerprintRef = useRef<string | null>(null);

  useEffect(() => {
    if (!saveError) {
      // Recovery: clear the fingerprint so the next failure reports.
      lastReportedFingerprintRef.current = null;
      return;
    }
    if (lastReportedFingerprintRef.current === saveError.message) return;
    lastReportedFingerprintRef.current = saveError.message;
    loggingService.reportError({
      error_name: 'SaveError',
      error_message: saveError.message,
      request_metadata: { component: 'SaveIndicator' },
    });
  }, [saveError]);

  // No status to show before the chart has a save target.
  if (!hasEditToken && !saveError) return null;

  if (saveError) {
    const tooltipId = 'save-indicator-error-tooltip';
    // Failed save with edits still pending: say what it means for the
    // user's data ("Unsaved changes"), not just that something errored.
    // Failures without pending edits (e.g. delete) keep the generic
    // "Error" label — the chart content itself is not at risk.
    const label = hasPendingChanges ? 'Unsaved changes' : 'Error';
    return (
      <div
        role="status"
        data-state={hasPendingChanges ? 'unsaved' : 'error'}
        className="flex items-center gap-1 px-1 sm:px-2 py-1 text-red-700 text-sm cursor-help"
        data-tooltip-id={tooltipId}
        data-tooltip-content={saveError.message}
      >
        <span className="inline-block w-2 h-2 rounded-full bg-red-500" aria-hidden="true" />
        <span className="hidden md:inline">{label}</span>
        <Tooltip id={tooltipId} place="bottom" />
      </div>
    );
  }

  if (isSaving) {
    return (
      <div
        role="status"
        data-state="saving"
        className="flex items-center gap-1 px-1 sm:px-2 py-1 text-gray-600 text-sm"
      >
        <svg
          className="animate-spin w-4 h-4"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
          />
        </svg>
        <span className="hidden md:inline">Saving</span>
      </div>
    );
  }

  if (hasPendingChanges) {
    // Dirty but no save in flight and no error: the debounce window,
    // or any future code path that defers persistence. Amber — a
    // heads-up, not an alarm.
    return (
      <div
        role="status"
        data-state="unsaved"
        className="flex items-center gap-1 px-1 sm:px-2 py-1 text-amber-700 text-sm"
      >
        <span className="inline-block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
        <span className="hidden md:inline">Unsaved changes</span>
      </div>
    );
  }

  return (
    <div
      role="status"
      data-state="saved"
      className="flex items-center gap-1 px-1 sm:px-2 py-1 text-gray-600 text-sm"
    >
      <svg
        className="w-4 h-4 text-green-600"
        fill="currentColor"
        viewBox="0 0 20 20"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
          clipRule="evenodd"
        />
      </svg>
      <span className="hidden md:inline">Saved</span>
    </div>
  );
}
