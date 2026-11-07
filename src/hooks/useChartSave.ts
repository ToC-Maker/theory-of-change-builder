// useChartSave — the one path that persists the chart: edits, JSON
// imports, AI replacements, undo and redo all call `saveChart(data)`.
//
// Three rules keep a save from losing or reordering work:
//
//   1. At most one save is in flight. An edit made meanwhile waits and goes
//      out when the running save lands, so an older save can never land
//      after a newer one and overwrite it.
//   2. A landing save clears the pending edits only if nothing changed
//      since it was sent. An edit made during the request has to stay
//      pending: clearing it would show "Saved" over data the server never
//      received.
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
// `pendingChangesRef` is the latest data the server is not known to hold.
// It is also what the chart sync (`useChartSync`) and the beforeunload
// warning read, so it is written synchronously and stays set from the
// edit until a save of that exact data succeeds. With no edit token (the
// chart does not exist yet) edits are marked pending and sent once the
// token arrives.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { SaveError } from '../components/top-bar/SaveIndicator';
import { ChartApiError, ChartService } from '../services/chartService';
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

const isAuthRefusal = (err: unknown): boolean =>
  err instanceof ChartApiError && (err.status === 401 || err.status === 403);

// A network failure carries no status; a 5xx may pass, and so may a 401/403
// from a token that failed to resolve. Anything else the server answered
// (404, 400, ...) will answer the same again.
const isRetryable = (err: unknown): boolean =>
  !(err instanceof ChartApiError) || err.status >= 500 || isAuthRefusal(err);

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
  // True while `timerRef` holds a retry delay that coming online or
  // returning to the tab may cut short: not a debounce, and not the slow
  // wait after a 401/403.
  const retryWaitRef = useRef(false);
  const inFlightRef = useRef(false);
  const retryCountRef = useRef(0);
  // A save that fails after the editor has gone gets no further retries.
  const mountedRef = useRef(true);

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
    retryWaitRef.current = false;
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
      retryWaitRef.current = false;
    },
    [flush],
  );

  // A chart is created on first Share or Generate, so edits can be made
  // before it has a token (and while it is being created). They were marked
  // pending with nowhere to go; send them once the token arrives instead of
  // waiting for another edit, which may never come.
  useEffect(() => {
    if (
      editToken &&
      pendingChangesRef.current &&
      timerRef.current === null &&
      !inFlightRef.current
    ) {
      setIsSaving(true);
      timerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    }
  }, [editToken, flush]);

  // Coming back online or returning to the tab ends a retry wait early:
  // the connection that failed the save may be back.
  useEffect(() => {
    mountedRef.current = true;
    const retryNow = () => {
      if (!retryWaitRef.current || timerRef.current === null) return;
      clearTimeout(timerRef.current);
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
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        flush();
      }
    };
  }, [flush]);

  return { isSaving, saveError, setSaveError, hasPendingChanges, pendingChangesRef, saveChart };
}
