// useChartSave — sends the chart document's saves to the server.
//
// The document decides what is sent and what each answer means (`takeSave`,
// then one of `saveSucceeded`, `saveConflicted`, `saveFailed`); this hook owns
// the timing. Three rules keep a save from losing or reordering work:
//
//   1. At most one save is in flight (the document hands out one at a time).
//      An edit made meanwhile waits and goes out when the running save lands,
//      so an older save can never land after a newer one and overwrite it.
//   2. A landing save clears the unsaved state only if nothing changed since
//      it was sent: the document compares, so "Saved" never covers data the
//      server did not receive.
//   3. A failed save keeps the edits pending and the failure visible, and
//      retries for as long as they stay pending: three quick retries with
//      growing delays, then one every RETRY_CAP_MS, for network errors and
//      5xx. Coming back online or returning to the tab retries at once. A
//      401/403 can come from an auth token that failed to resolve this
//      once, so it is retried too, but only every RETRY_CAP_MS and never
//      cut short: a refusal that is real will not clear up in seconds. Any
//      other 4xx gets no retry, since the server will answer the same
//      again; the next edit starts a fresh attempt.
//
// A save the server answers with a newer chart (409) is merged by the document
// and sent again at once. A chart the merge cannot handle, or a server that
// went back to an older version, ends saving for this editor: the pill shows
// why and one report goes out with versions only, never chart content.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SaveError } from '../components/top-bar/SaveIndicator';
import { ChartApiError, ChartService } from '../services/chartService';
import { loggingService } from '../services/loggingService';
import type { ChartDocument } from '../sync/ChartDocument';
import { ChartShapeError } from '../../shared/chart-model';
import type { ToCData } from '../types';

const SAVE_DEBOUNCE_MS = 300;
// Delays before the first retries of a failed save; every later retry
// waits RETRY_CAP_MS.
const QUICK_RETRY_DELAYS_MS = [1000, 2000, 4000];
const RETRY_CAP_MS = 30_000;

// Map a thrown error from a save attempt into the SaveIndicator shape.
// Strips fetch metadata that isn't useful in the pill.
export function asSaveError(err: unknown): SaveError {
  if (err instanceof Error) {
    return { message: err.message };
  }
  return { message: typeof err === 'string' ? err : 'Save failed' };
}

/**
 * Reports a save or poll that cannot continue. Only versions go out: an error
 * message may name an id, but the chart is deliberately not attached.
 */
export function reportSyncFailure(
  errorName: 'ChartMergeFailed' | 'ChartVersionWentBackwards',
  error: unknown,
  baseVersion: number,
  serverVersion?: number,
): void {
  loggingService.reportError({
    error_name: errorName,
    error_message: error instanceof Error ? error.message : String(error),
    chart_id: loggingService.getCurrentChartId() ?? undefined,
    request_metadata: { baseVersion, serverVersion },
  });
}

const isAuthRefusal = (err: unknown): boolean =>
  err instanceof ChartApiError && (err.status === 401 || err.status === 403);

// A network failure carries no status; a 5xx may pass, and so may a 401/403
// from a token that failed to resolve. Anything else the server answered
// (404, 400, ...) will answer the same again.
const isRetryable = (err: unknown): boolean =>
  !(err instanceof ChartApiError) || err.status >= 500 || isAuthRefusal(err);

export interface UseChartSaveArgs {
  doc: ChartDocument;
  /** Called with the unsaved chart after each failed attempt (local backup). */
  onSaveFailed?: (data: ToCData) => void;
}

export interface UseChartSaveResult {
  /** A save is waiting out its debounce, in flight, or waiting to retry. */
  isSaving: boolean;
  /** Set by a failed save (or another failing operation); cleared by the next successful save. */
  saveError: SaveError | null;
  setSaveError: (error: SaveError | null) => void;
}

export function useChartSave({ doc, onSaveFailed }: UseChartSaveArgs): UseChartSaveResult {
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<SaveError | null>(null);

  // Debounce timer, or the retry-delay timer after a failure. Null when
  // neither is armed.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True while `timerRef` holds a retry delay that coming online or
  // returning to the tab may cut short: not a debounce, and not the slow
  // wait after a 401/403.
  const retryWaitRef = useRef(false);
  const retryCountRef = useRef(0);
  // A save that fails after the editor has gone gets no further retries.
  const mountedRef = useRef(true);
  // Set once saving cannot continue (merge failure, terminal document error).
  const stoppedRef = useRef(false);
  // The document notifies synchronously inside the calls this hook makes to
  // settle a save; those notifications are not edits and must not re-arm the debounce.
  const settlingRef = useRef(false);

  const onSaveFailedRef = useRef(onSaveFailed);
  useEffect(() => {
    onSaveFailedRef.current = onSaveFailed;
  }, [onSaveFailed]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    retryWaitRef.current = false;
  }, []);

  const whileSettling = useCallback(<T>(call: () => T): T => {
    settlingRef.current = true;
    try {
      return call();
    } finally {
      settlingRef.current = false;
    }
  }, []);

  const stopSaving = useCallback(
    (error: SaveError) => {
      stoppedRef.current = true;
      setSaveError(error);
      onSaveFailedRef.current?.(doc.getCommitted());
      setIsSaving(false);
    },
    [doc],
  );

  // Sends the document's pending save. When one is already in flight there is
  // nothing to take: the landing handler sends the newer data itself.
  const flush = useCallback(
    function flush() {
      clearTimer();
      if (stoppedRef.current) return;
      const save = whileSettling(() => doc.takeSave());
      if (!save) {
        setIsSaving(doc.getStatus().saving);
        return;
      }

      setIsSaving(true);
      console.log('Saving to database');
      ChartService.updateChart(save.editToken, save.chart, save.baseVersion).then(
        (outcome) => {
          retryCountRef.current = 0;
          if (outcome.status === 'conflict') {
            try {
              whileSettling(() => doc.saveConflicted(outcome.theirs));
            } catch (err) {
              // Instead of retrying: this chart will not merge, and would not next time either.
              reportSyncFailure('ChartMergeFailed', err, save.baseVersion, outcome.theirs.version);
              stopSaving(asSaveError(err));
              return;
            }
            const { terminalError } = doc.getStatus();
            if (terminalError) {
              reportSyncFailure(
                'ChartVersionWentBackwards',
                terminalError,
                save.baseVersion,
                outcome.theirs.version,
              );
              stopSaving({ message: terminalError });
              return;
            }
            // The merged chart goes out on the server's version with no further wait.
            flush();
            return;
          }

          whileSettling(() => doc.saveSucceeded(outcome.version));
          console.log('Database save successful');
          setSaveError(null);
          if (!doc.getStatus().unsaved) {
            setIsSaving(false);
          } else if (timerRef.current === null) {
            // Edited during the request and its debounce already came due (and was
            // held back): send it now. With the debounce still armed, it sends itself.
            flush();
          }
        },
        (err: unknown) => {
          whileSettling(() => doc.saveFailed());
          console.error('Failed to save to database:', err);
          if (err instanceof ChartShapeError) {
            // Instead of retrying: the server's latest chart is not one the merge can use.
            reportSyncFailure('ChartMergeFailed', err, save.baseVersion);
            stopSaving(asSaveError(err));
            return;
          }
          setSaveError(asSaveError(err));
          onSaveFailedRef.current?.(doc.getCommitted());

          if (!isRetryable(err) || !mountedRef.current) {
            setIsSaving(false);
            return;
          }
          const refused = isAuthRefusal(err);
          const delay = refused
            ? RETRY_CAP_MS
            : (QUICK_RETRY_DELAYS_MS[retryCountRef.current] ?? RETRY_CAP_MS);
          retryCountRef.current += 1;
          // A newer edit's armed debounce retries sooner than the backoff.
          if (timerRef.current === null) {
            timerRef.current = setTimeout(flush, delay);
            retryWaitRef.current = !refused;
          }
        },
      );
    },
    [doc, clearTimer, whileSettling, stopSaving],
  );

  // An edit, or the chart getting its server, starts the debounce. A chart with
  // no server has nowhere to send edits yet: they wait for `attachServer`.
  useEffect(() => {
    const armDebounce = () => {
      if (settlingRef.current || stoppedRef.current) return;
      const { unsaved, editToken, serverVersion, terminalError } = doc.getStatus();
      if (!unsaved || !editToken || serverVersion === null || terminalError) return;
      retryCountRef.current = 0;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setIsSaving(true);
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
      retryWaitRef.current = false;
    };
    stoppedRef.current = false;
    armDebounce();
    return doc.subscribe(armDebounce);
  }, [doc, flush]);

  // Coming back online or returning to the tab ends a retry wait early:
  // the connection that failed the save may be back.
  useEffect(() => {
    mountedRef.current = true;
    const retryNow = () => {
      if (!retryWaitRef.current || timerRef.current === null) return;
      flush();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') retryNow();
    };
    window.addEventListener('online', retryNow);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('online', retryNow);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [flush]);

  // Leaving the editor must not drop an edit still waiting out its delay.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) flush();
    };
  }, [flush]);

  return { isSaving, saveError, setSaveError };
}
