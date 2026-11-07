// useChartSync — the edit-mode check for other people's changes.
//
// Every POLL_MS an open, active editor asks the server for the chart's
// version (`pollChart`), naming the version its document holds. The server
// sends the chart back only when the versions differ, and the document merges
// it (`receiveRemote`), so a quiet tick moves a few bytes.
//
// One self-rescheduling timer drives it, so there is one request at a time and
// a slow answer pushes the next check back instead of piling up. A check is
// skipped, not stopped, while the tab is hidden, after IDLE_MS without
// activity, during a canvas pointer drag (a landing could move the dragged
// node under the pointer), while a save is in flight (its own answer brings
// the newer chart), while the document has nowhere to poll and once it has
// gone terminal (every check would fetch the whole chart again for nothing). A
// response that arrives after a drag began is dropped; the next check fetches
// the same chart again.
//
// A failed check waits FAILURE_WAIT_MS and carries on. A chart that cannot be
// used (it is not a chart, or the merge refuses it) is reported once, with
// versions only, and `onSyncFailed` tells the user: an idle tab has no save to
// fail, so this is the only sign that others' edits have stopped arriving. The
// document is left as it was, so every later check returns the same chart.
import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { ChartService } from '../services/chartService';
import { ChartShapeError } from '../../shared/chart-model';
import type { ChartDocument } from '../sync/ChartDocument';
import { reportSyncFailure } from './useChartSave';

export const POLL_MS = 2500;
const FAILURE_WAIT_MS = 30_000;
const IDLE_MS = 5 * 60_000;

export interface UseChartSyncArgs {
  doc: ChartDocument;
  /** Auth bootstrap finished (token provider registered). */
  authTokenReady: boolean;
  /** True while a canvas pointer-drag is in flight. */
  isDragInFlightRef: MutableRefObject<boolean>;
  /** Called, once per unusable chart, with why others' changes cannot be shown. */
  onSyncFailed?: (message: string) => void;
}

export function useChartSync({
  doc,
  authTokenReady,
  isDragInFlightRef,
  onSyncFailed,
}: UseChartSyncArgs): void {
  const onSyncFailedRef = useRef(onSyncFailed);
  useEffect(() => {
    onSyncFailedRef.current = onSyncFailed;
  }, [onSyncFailed]);

  useEffect(() => {
    if (!authTokenReady) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    let stopped = false;
    let lastActivity = Date.now();
    const reported = new Set<string>();
    const reportOnce = (key: string, err: unknown, baseVersion: number, serverVersion?: number) => {
      if (reported.has(key)) return;
      reported.add(key);
      reportSyncFailure('ChartMergeFailed', err, baseVersion, serverVersion);
      onSyncFailedRef.current?.(err instanceof Error ? err.message : String(err));
    };

    /** One check; resolves to how long to wait before the next. */
    async function check(): Promise<number> {
      const { editToken, serverVersion, saving, terminalError } = doc.getStatus();
      if (
        document.hidden ||
        Date.now() - lastActivity > IDLE_MS ||
        isDragInFlightRef.current ||
        saving ||
        editToken === null ||
        serverVersion === null ||
        terminalError !== null
      ) {
        return POLL_MS;
      }

      let polled;
      try {
        polled = await ChartService.pollChart(editToken, serverVersion);
      } catch (err) {
        // The service has logged the raw body of a refused answer; this adds the status.
        console.error('[useChartSync] poll failed:', err);
        if (err instanceof ChartShapeError) reportOnce('not a chart', err, serverVersion);
        return FAILURE_WAIT_MS;
      }
      if (stopped || polled.chartData === undefined || isDragInFlightRef.current) return POLL_MS;

      try {
        doc.receiveRemote({ version: polled.version, chart: polled.chartData });
      } catch (err) {
        console.error('[useChartSync] merging the polled chart failed:', err);
        reportOnce(`merge ${polled.version}`, err, serverVersion, polled.version);
        return FAILURE_WAIT_MS;
      }
      return POLL_MS;
    }

    // Runs a check now (or when the timer fires) and arms the next one.
    async function run() {
      if (polling) return;
      clearTimeout(timer);
      polling = true;
      let wait = POLL_MS;
      try {
        wait = await check();
      } finally {
        polling = false;
        if (!stopped) timer = setTimeout(run, wait);
      }
    }

    const onVisibilityChange = () => {
      if (document.hidden) return;
      lastActivity = Date.now();
      void run();
    };
    const onActivity = () => {
      const now = Date.now();
      const wasIdle = now - lastActivity > IDLE_MS;
      lastActivity = now;
      if (wasIdle) void run();
    };

    const activityEvents = ['mousemove', 'keydown', 'click', 'scroll'] as const;
    document.addEventListener('visibilitychange', onVisibilityChange);
    for (const name of activityEvents) document.addEventListener(name, onActivity);
    timer = setTimeout(run, POLL_MS);

    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      for (const name of activityEvents) document.removeEventListener(name, onActivity);
    };
  }, [doc, authTokenReady, isDragInFlightRef]);
}
