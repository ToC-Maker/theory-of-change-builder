import { useEffect, useCallback, useRef } from 'react';
import { loggingService } from '../services/loggingService';
import type { SaveSnapshotParams } from '../services/loggingService';
import type { ToCData } from '../types';

interface UseLoggingSessionParams {
  chartId: string | null;
  graphData: ToCData | null;
}

interface UseLoggingSessionReturn {
  /** Initialize logging for a chart (call after chart data is loaded) */
  initializeLogging: (chartId: string, graphData: ToCData) => void;
  /** Handle privacy policy acceptance (starts session if logging enabled) */
  handlePrivacyAccept: (loggingEnabled: boolean) => void;
  /** Handle when user re-enables logging from settings */
  handleLoggingEnabled: () => void;
  /** Log a graph change with debouncing (for manual edits, undo, redo) */
  logGraphChange: (graphData: ToCData, editType: SaveSnapshotParams['edit_type']) => void;
}

/**
 * Encapsulates all logging session lifecycle management:
 * - Session initialization and initial snapshot
 * - Activity tracking (throttled mousemove/keydown for session timeout)
 * - Graph change logging (debounced snapshots)
 * - Page unload cleanup (beacon flush)
 * - Unmount cleanup (end session, flush)
 */
export function useLoggingSession({
  chartId,
  graphData,
}: UseLoggingSessionParams): UseLoggingSessionReturn {
  // Keep refs so cleanup callbacks always see the latest values
  const graphDataRef = useRef(graphData);
  useEffect(() => {
    graphDataRef.current = graphData;
  }, [graphData]);

  const chartIdRef = useRef(chartId);
  useEffect(() => {
    chartIdRef.current = chartId;
  }, [chartId]);

  // --- Session initialization ---

  const initializeLogging = useCallback(async (cId: string, gData: ToCData) => {
    if (loggingService.isOptedOut()) return;
    const sessionId = await loggingService.initializeSession(cId);
    if (sessionId) {
      loggingService.saveSnapshot({
        session_id: sessionId,
        chart_id: cId,
        graph_data: gData,
        edit_type: 'initial',
      });
    }
  }, []);

  const handlePrivacyAccept = useCallback(
    (loggingEnabled: boolean) => {
      if (loggingEnabled && chartIdRef.current && graphDataRef.current) {
        initializeLogging(chartIdRef.current, graphDataRef.current);
      }
    },
    [initializeLogging],
  );

  const handleLoggingEnabled = useCallback(() => {
    if (chartIdRef.current && graphDataRef.current) {
      initializeLogging(chartIdRef.current, graphDataRef.current);
    }
  }, [initializeLogging]);

  // --- Graph change logging ---

  const logGraphChange = useCallback(
    (gData: ToCData, editType: SaveSnapshotParams['edit_type']) => {
      const sessionId = loggingService.getCurrentSessionId();
      if (sessionId && chartIdRef.current && loggingService.isLoggingEnabled()) {
        loggingService.saveSnapshotDebounced({
          session_id: sessionId,
          chart_id: chartIdRef.current,
          graph_data: gData,
          edit_type: editType,
        });
      }
    },
    [],
  );

  // --- Page unload cleanup (sendBeacon) ---

  useEffect(() => {
    const handlePageHide = () => {
      loggingService.flushPendingSnapshot();
      loggingService.endSessionBeacon();
    };
    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, []);

  // --- Unmount cleanup ---

  useEffect(() => {
    return () => {
      loggingService.flushPendingSnapshot();
      loggingService.endSession();
    };
  }, []);

  // --- Throttled activity listener for session timeout ---

  useEffect(() => {
    if (!chartId) return;

    const lastActivityRef = { current: 0 };
    const ACTIVITY_THROTTLE_MS = 30000; // 30 seconds

    const handleActivity = () => {
      const now = Date.now();
      if (now - lastActivityRef.current > ACTIVITY_THROTTLE_MS) {
        lastActivityRef.current = now;
        loggingService.resetSessionTimeout();
      }
    };

    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('keydown', handleActivity);

    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keydown', handleActivity);
    };
  }, [chartId]);

  return {
    initializeLogging,
    handlePrivacyAccept,
    handleLoggingEnabled,
    logGraphChange,
  };
}
