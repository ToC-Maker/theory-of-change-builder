// useChartSave — the one path that persists the chart: edits, JSON
// imports, AI replacements, undo and redo all call `saveChart(data)`.
//
// Three rules keep a save from losing or reordering work:
//
//   1. At most one save is in flight. An edit made meanwhile waits and goes
//      out when the running save lands, so an older save can never land
//      after a newer one and overwrite it.
//   2. A landing save clears the pending edits only if nothing changed
//      since it was sent. Clearing unconditionally dropped any edit made
//      during the request (the "Saved" pill then showed over data the
//      server never received).
//   3. A failed save keeps the edits pending and the failure visible, and
//      retries a bounded number of times with growing delays for network
//      errors and 5xx. 401/403 (auth and permission) and other 4xx are
//      not retried: no retry changes the answer, and the session-expired
//      banner owns the recovery. The next edit starts a fresh attempt.
//
// `pendingChangesRef` is the latest data the server is not known to hold.
// It is also what the chart sync (`useChartSync`) and the beforeunload
// warning read, so it is written synchronously and stays set from the
// edit until a save of that exact data succeeds. With no edit token (the
// chart does not exist yet) edits are marked pending but nothing is sent.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { SaveError } from '../components/top-bar/SaveIndicator';
import { ChartApiError, ChartService } from '../services/chartService';
import type { ToCData } from '../types';

const SAVE_DEBOUNCE_MS = 300;
// Delay before each retry of a failed save; its length bounds the retries.
const RETRY_DELAYS_MS = [1000, 2000, 4000];

// Map a thrown error from a save attempt into the SaveIndicator shape.
// Strips fetch metadata that isn't useful in the pill.
export function asSaveError(err: unknown): SaveError {
  if (err instanceof Error) {
    return { message: err.message };
  }
  return { message: typeof err === 'string' ? err : 'Save failed' };
}

// A network failure carries no status; a 5xx may pass. Anything else the
// server answered (401/403, 404, 400, ...) will answer the same again.
const isRetryable = (err: unknown): boolean => !(err instanceof ChartApiError) || err.status >= 500;

export interface UseChartSaveArgs {
  /** Edit token of the open chart; null before the chart exists. */
  editToken: string | null;
  /** Called with the latest unsaved data after each failed attempt (local backup). */
  onSaveFailed?: (data: ToCData) => void;
}

export interface UseChartSaveResult {
  /** A save is waiting out its debounce, in flight, or waiting to retry. */
  isSaving: boolean;
  /** Set by a failed save (or another failing operation); cleared by the next successful save. */
  saveError: SaveError | null;
  setSaveError: (error: SaveError | null) => void;
  /** State mirror of `pendingChangesRef.current !== null`, for rendering. */
  hasPendingChanges: boolean;
  /** Latest data the server is not known to hold; null once it is saved. */
  pendingChangesRef: MutableRefObject<ToCData | null>;
  /** Record `data` as the latest local state and schedule it to be saved. */
  saveChart: (data: ToCData) => void;
}

export function useChartSave({ editToken, onSaveFailed }: UseChartSaveArgs): UseChartSaveResult {
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [hasPendingChanges, setHasPendingChanges] = useState(false);

  const pendingChangesRef = useRef<ToCData | null>(null);
  // Debounce timer, or the retry-delay timer after a failure. Null when
  // neither is armed.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const retryCountRef = useRef(0);

  const editTokenRef = useRef(editToken);
  const onSaveFailedRef = useRef(onSaveFailed);
  useEffect(() => {
    editTokenRef.current = editToken;
    onSaveFailedRef.current = onSaveFailed;
  }, [editToken, onSaveFailed]);

  // Sends the latest pending data. When a save is already in flight it
  // does nothing: the landing handler sends the newer data itself.
  const flush = useCallback(function flush() {
    timerRef.current = null;
    const sent = pendingChangesRef.current;
    const token = editTokenRef.current;
    if (!sent || !token) {
      setIsSaving(false);
      return;
    }
    if (inFlightRef.current) return;

    inFlightRef.current = true;
    setIsSaving(true);
    console.log('Saving to database');
    ChartService.updateChart(token, sent).then(
      () => {
        inFlightRef.current = false;
        retryCountRef.current = 0;
        setSaveError(null);
        if (pendingChangesRef.current === sent) {
          console.log('Database save successful');
          pendingChangesRef.current = null;
          setHasPendingChanges(false);
          setIsSaving(false);
        } else if (timerRef.current === null) {
          // Edited during the request and its debounce already came due
          // (and was held back): send it now. With the debounce still
          // armed, it sends itself.
          flush();
        }
      },
      (err: unknown) => {
        inFlightRef.current = false;
        console.error('Failed to save to database:', err);
        setSaveError(asSaveError(err));
        const latest = pendingChangesRef.current;
        if (latest) onSaveFailedRef.current?.(latest);

        const delay = isRetryable(err) ? RETRY_DELAYS_MS[retryCountRef.current] : undefined;
        if (delay === undefined) {
          setIsSaving(false);
          return;
        }
        retryCountRef.current += 1;
        // A newer edit's armed debounce retries sooner than the backoff.
        if (timerRef.current === null) timerRef.current = setTimeout(flush, delay);
      },
    );
  }, []);

  const saveChart = useCallback(
    (data: ToCData) => {
      pendingChangesRef.current = data;
      setHasPendingChanges(true);
      if (!editTokenRef.current) return;

      retryCountRef.current = 0;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setIsSaving(true);
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  // Leaving the editor must not drop an edit still waiting out its delay.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        flush();
      }
    };
  }, [flush]);

  return { isSaving, saveError, setSaveError, hasPendingChanges, pendingChangesRef, saveChart };
}
