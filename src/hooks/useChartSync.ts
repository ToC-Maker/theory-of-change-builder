// useChartSync — the edit-mode periodic chart sync, extracted verbatim
// from the inline effect in `App.tsx` (ToCViewer) so the stale-echo
// apply decision is unit-testable (PR #34 round-7 feedback, issue 80).
//
// What it does: while an edit-token chart is open, poll
// `getChartByEditToken` (10s cadence, exponential backoff to 60s when
// idle, immediate on tab-refocus, paused while hidden/idle/dragging/
// saving) and feed remote snapshots back into App state so cross-tab
// edits converge.
//
// ---------------------------------------------------------------------------
// Issue 80 — the stale-echo revert (measured timeline, 2026-06-12)
// ---------------------------------------------------------------------------
//
// Reproduced with timestamped instrumentation + 1.2s artificial GET
// response latency (models production CF→Neon RTT; local was ~10ms):
//
//   254711  slider input 0.6→0.8 (live render correct)
//   255213  debounced save POST (0.8) … done 255709
//   255716  isSaving flips → effect re-runs → epoch 3
//   256717  epoch-3 sync GET issued (the 1s post-save timer)
//   256810  user drags again → 0.2; epoch 3 TORN DOWN at 256816,
//           but its GET is already in flight — fetch is not cancelled
//   257312  save POST (0.2) … done 257562, pendingChanges cleared
//   258055  epoch-3 GET resolves with 0.8 (read pre-save-2) and
//           setData APPLIES it → visible REVERT 0.2→0.8
//   258567  epoch-5 GET issued (1s post-save-2 timer)
//   259905  resolves 0.2 → setData → settles correct (~1.9s later;
//           "a few seconds" at production latencies)
//
// Root cause: `syncData`'s guards (isSaving / drag / visibility) all run
// BEFORE the `await fetch`; nothing re-validates when the response
// lands. Effect teardown doesn't invalidate in-flight requests, and the
// apply condition compared the response only against `lastSyncedData`
// (reset to null on every effect re-run — and the effect re-runs on
// every `isSaving` toggle, i.e. every save), never against current
// local state. A snapshot read before the user's latest edit therefore
// stomped newer local state. This hit every `chartData` field (the
// curvature slider, textSize, paddings, node edits) — curvature was
// just the most visible because sliders produce rapid save cycles that
// keep sync GETs in flight.
//
// Guards (apply-time, in order):
//   (A) dead-epoch drop — `cancelled` flips in the effect cleanup; a
//       response that lands after teardown is discarded. Closes the
//       measured repro above.
//   (B) local-pending drop — `pendingChangesRef.current !== null` means
//       local edits exist that the server snapshot cannot reflect yet
//       (the ref is set synchronously in handleDataChange and cleared
//       only after a successful save). Closes the same-epoch TOCTOU
//       window where the response lands after the user's input event
//       but before React runs the effect cleanup (passive effects run
//       post-paint, so that window is real).
//   (C) own-echo skip — a snapshot deep-equal to current local data is
//       bookkept (lastSyncedData, interval reset) but not re-applied,
//       so the post-save echo doesn't churn identity through the ToC
//       initialData effect (height recalcs, settings re-sync).
//
// Why fix HERE and not in TheoryOfChangeGraph's settings-sync effect:
// App-level `data` is the single owner (the PR-0 mutation-seam design);
// ToC's local curvature/textSize/padding states are faithful followers
// of `initialData`. The revert was the OWNER being corrupted by a stale
// write — making followers resist their owner would create divergence
// and break the AI-edit/external-replace path. Guarding the owner fixes
// curvature and every sibling setting at once.
import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { ChartService } from '../services/chartService';
import type { ToCData } from '../types';

export interface UseChartSyncArgs {
  /** Edit token for the open chart; sync is disabled when null. */
  editToken: string | null | undefined;
  /** Auth bootstrap finished (token provider registered). */
  authTokenReady: boolean;
  /**
   * Save-in-flight state. Kept as a dependency on purpose: each save
   * lifecycle re-arms the 1s "initial sync" timer, which is what gives
   * the quick post-save echo-back today.
   */
  isSaving: boolean;
  /** True while a canvas pointer-drag is in flight (PR 4 pause). */
  isDragInFlightRef: MutableRefObject<boolean>;
  /**
   * Local edits not yet persisted (set synchronously on every local
   * change, cleared after a successful save). Apply-guard (B) reads it
   * at response time.
   */
  pendingChangesRef: MutableRefObject<ToCData | null>;
  /** Latest local chart state; apply-guard (C) compares against it. */
  dataRef: MutableRefObject<ToCData | null>;
  /** Apply a remote snapshot (App: setData + setLastSyncTime). */
  onRemoteData: (chartData: ToCData) => void;
}

export function useChartSync({
  editToken,
  authTokenReady,
  isSaving,
  isDragInFlightRef,
  pendingChangesRef,
  dataRef,
  onRemoteData,
}: UseChartSyncArgs): void {
  // Smart periodic sync with idle detection for edit mode
  useEffect(() => {
    if (!editToken || !authTokenReady) return;

    let interval: ReturnType<typeof setInterval>;
    let lastSyncedData: string | null = null;
    let isTabVisible = true;
    let lastActivity = Date.now();
    let syncInterval = 10000; // Start with 10 seconds
    let consecutiveUnchanged = 0;
    // Guard (A): flipped in cleanup; responses landing after teardown
    // belong to a dead epoch and must not touch state.
    let cancelled = false;

    const syncData = async () => {
      // Don't sync if tab is hidden or user is idle
      if (!isTabVisible || Date.now() - lastActivity > 300000) {
        // 5 min idle timeout
        console.log('Skipping sync - tab hidden or user idle');
        return;
      }
      // PR 4: don't sync mid-drag. A server snapshot landing while
      // a pointer-drag is in flight could yank the dragged node out
      // from under the user (cross-tab delete race). The drop handler
      // is itself stale-node-guarded; this prevents the race upstream.
      if (isDragInFlightRef.current) {
        console.log('Skipping sync - drag in flight');
        return;
      }

      // Don't sync if currently saving to prevent conflicts
      if (isSaving) {
        console.log('Skipping sync - save in progress');
        return;
      }

      try {
        console.log(`Syncing chart in edit mode (interval: ${syncInterval}ms)`);
        const result = await ChartService.getChartByEditToken(editToken);

        // ------------------------------------------------------------
        // Apply-time guards (issue 80). Everything above this line ran
        // BEFORE the fetch; the world may have moved while the response
        // was in flight.
        // ------------------------------------------------------------
        // (A) The effect re-ran (save lifecycle, token change) or
        // unmounted while this request was in flight: the snapshot
        // predates whatever caused the teardown. Drop it.
        if (cancelled) {
          console.log('Sync response discarded - effect epoch torn down while in flight');
          return;
        }
        // (B) Local edits are awaiting persistence; this snapshot
        // cannot include them. Applying it would revert the user's
        // latest change until the next poll echoes it back.
        if (pendingChangesRef.current !== null) {
          console.log('Sync response discarded - local changes pending save');
          return;
        }

        const newDataStr = JSON.stringify(result.chartData);

        // Only update if the data has changed (to preserve undo/redo history)
        if (lastSyncedData !== newDataStr) {
          lastSyncedData = newDataStr;
          // (C) Own-echo: the server already matches local state (the
          // common case right after our own save). Record the sync but
          // skip the redundant setData so we don't churn object
          // identity through the ToC initialData effect.
          if (newDataStr === JSON.stringify(dataRef.current)) {
            console.log('Sync response matches local state - no update needed');
          } else {
            onRemoteData(result.chartData);
            console.log('Chart data updated from sync');
          }
          consecutiveUnchanged = 0;
          syncInterval = 10000; // Reset to 10 seconds
        } else {
          consecutiveUnchanged++;
          // Exponential backoff: 10s -> 15s -> 22s -> 33s -> 50s -> 60s max
          if (consecutiveUnchanged > 2) {
            const newInterval = Math.min(Math.floor(syncInterval * 1.5), 60000);
            if (newInterval !== syncInterval) {
              syncInterval = newInterval;
              console.log(
                `No changes for ${consecutiveUnchanged} syncs, interval now ${syncInterval}ms`,
              );
            }
          }
        }
      } catch (err) {
        console.error('Error syncing chart data:', err);
      }
    };

    // Handle visibility change
    const handleVisibilityChange = () => {
      isTabVisible = !document.hidden;
      if (isTabVisible) {
        console.log('Tab became visible, syncing immediately');
        syncData(); // Sync immediately when tab becomes visible
        lastActivity = Date.now();
      }
    };

    // Handle user activity
    const handleActivity = () => {
      const timeSinceLastActivity = Date.now() - lastActivity;
      lastActivity = Date.now();

      // If user was idle and becomes active, sync immediately
      if (timeSinceLastActivity > 300000) {
        console.log('User became active after being idle, syncing');
        syncData();
      }
    };

    // Listen for events
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('mousemove', handleActivity);
    document.addEventListener('keydown', handleActivity);
    document.addEventListener('click', handleActivity);
    document.addEventListener('scroll', handleActivity);

    // Initial sync after a short delay
    const initialTimer = setTimeout(syncData, 1000);

    // Dynamic interval
    const runSync = () => {
      syncData();
      clearInterval(interval);
      if (syncInterval < 60000 || consecutiveUnchanged < 10) {
        interval = setInterval(runSync, syncInterval);
      }
    };
    interval = setInterval(runSync, syncInterval);

    return () => {
      cancelled = true; // Guard (A)
      clearTimeout(initialTimer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('mousemove', handleActivity);
      document.removeEventListener('keydown', handleActivity);
      document.removeEventListener('click', handleActivity);
      document.removeEventListener('scroll', handleActivity);
    };
    // `isSaving` is a real dependency (see UseChartSyncArgs.isSaving);
    // the refs are stable by construction.
  }, [
    editToken,
    isSaving,
    authTokenReady,
    isDragInFlightRef,
    pendingChangesRef,
    dataRef,
    onRemoteData,
  ]);
}
