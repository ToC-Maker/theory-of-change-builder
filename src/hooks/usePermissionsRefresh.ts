// usePermissionsRefresh — L1 mitigation per the Figma redesign plan,
// PR 2 Task 2.3.
//
// Two-tab race scenario:
//   Tab A and Tab B both have the ShareDialog open. Tab A flips
//   `linkSharingLevel` from 'restricted' to 'viewer' and writes via the
//   `managePermissions` PUT. Tab B's local state is now stale; the next
//   read it submits will overwrite Tab A's change (last-write-wins).
//
// Storage event is best-effort optimization. 30s polling is the actual
// correctness guarantee. Full optimistic lock deferred (user-direction
// sticky). The cross-tab `storage` event is a cheap synchronization
// signal for the *same browser*: whenever Tab A writes a sentinel key
// to localStorage, every other tab (still attached to the same origin)
// receives a `storage` event and re-fetches.
//
// What this hook owns:
//   - First fetch when the dialog opens.
//   - Re-fetch on every `storage` event (regardless of key — the cost
//     of an extra refetch is much smaller than the foot-gun of missing
//     one because the key changed).
//   - A `divergedFromLocal` boolean the caller can surface as a banner
//     ("Permissions were changed by another tab — reloaded latest.").
//   - A `fetchError` field the caller can surface so a silent fetch
//     failure (transient 401 during Auth0 silent refresh, 5xx blip)
//     doesn't disable the divergence banner without a user-visible cue.
//
// What this hook explicitly does NOT do:
//   - 30s polling. The replacement for the deleted legacy ShareDialogShim's
//     polling now lives in `ShareDialog.tsx` (30s while open) and in
//     `App.tsx` (owner-gated 30s badge poll). This hook stays out of the
//     polling business so its single responsibility — open-fetch +
//     storage-event refetch — is obvious.
//   - Optimistic locking. The plan defers full optimistic-lock to
//     post-redesign; this hook is the lightweight mitigation. Revisit
//     when (a) the divergence banner is observed in production telemetry
//     more than ~once/week, or (b) a multi-tab data-loss bug is reported.
//
// References:
//   - React storage-event docs: developer.mozilla.org/en-US/docs/Web/API/Window/storage_event
//   - Plan: `plans/figma-redesign.md` (parent repo, not committed to feature
//     branches). Look for the §198 Important hook-acceptance bullet.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LinkSharingLevel } from '../../shared/permissions';
import { loggingService } from '../services/loggingService';

export type { LinkSharingLevel } from '../../shared/permissions';

export interface PermissionsFetchResult {
  linkSharingLevel?: LinkSharingLevel;
}

export interface UsePermissionsRefreshOptions {
  /** Whether the dialog is currently open. Hook is a no-op when false. */
  open: boolean;
  /** Chart whose permissions to load. null = nothing to fetch yet. */
  chartId: string | null;
  /** Caller's local copy of the level — used to compute divergence. */
  localLevel: LinkSharingLevel;
  /** Fetcher — usually `(chartId) => ChartService.getChartPermissions(chartId)`. */
  fetcher: (chartId: string) => Promise<PermissionsFetchResult>;
}

export interface UsePermissionsRefreshResult {
  /** Latest `linkSharingLevel` observed from the server, or null pre-fetch. */
  serverLevel: LinkSharingLevel | null;
  /** True iff serverLevel is set and differs from the caller's localLevel. */
  divergedFromLocal: boolean;
  /**
   * Message from the last fetch failure, or `null` when the most recent
   * fetch succeeded (or none has run). Callers should surface this in
   * the UI so a silent fetch failure doesn't disable the divergence
   * mitigation without a user-visible cue.
   */
  fetchError: string | null;
  /** Force a re-fetch (e.g. after a local write). */
  refresh: () => Promise<void>;
}

export function usePermissionsRefresh({
  open,
  chartId,
  localLevel,
  fetcher,
}: UsePermissionsRefreshOptions): UsePermissionsRefreshResult {
  const [serverLevel, setServerLevel] = useState<LinkSharingLevel | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  // Stable ref for the fetcher so the `storage` listener registered
  // once survives identity churn of the callsite's arrow function.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  const chartIdRef = useRef(chartId);
  useEffect(() => {
    chartIdRef.current = chartId;
  }, [chartId]);

  const refresh = useCallback(async () => {
    const id = chartIdRef.current;
    if (!id) return;
    try {
      const result = await fetcherRef.current(id);
      if (result.linkSharingLevel) {
        setServerLevel(result.linkSharingLevel);
      }
      setFetchError(null);
    } catch (err) {
      // Refresh failures are non-fatal at the data-flow level, but the
      // mitigation they're guarding (`divergedFromLocal`) silently no-ops
      // when `serverLevel` stays null — so a silent fetch failure
      // re-opens the exact L1 race the hook exists to mitigate. Surface
      // the error to the caller (via `fetchError`) and to operational
      // logging.
      const message = err instanceof Error ? err.message : String(err);
      console.error('[usePermissionsRefresh] fetch failed:', err);
      setFetchError(message);
      loggingService.reportError({
        error_name: 'PermissionsRefreshFailed',
        error_message: message,
        chart_id: id,
      });
    }
  }, []);

  // Initial fetch when the dialog opens (or when chartId becomes available).
  useEffect(() => {
    if (!open || !chartId) return;
    void refresh();
  }, [open, chartId, refresh]);

  // Cross-tab refresh. The listener is intentionally key-agnostic: any
  // storage event triggers a re-fetch. The cost is one extra round-trip;
  // the gain is robustness against future code paths writing the key
  // under a different name.
  useEffect(() => {
    if (!open || !chartId) return;
    const onStorage = () => {
      void refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [open, chartId, refresh]);

  const divergedFromLocal = serverLevel !== null && serverLevel !== localLevel;

  return { serverLevel, divergedFromLocal, fetchError, refresh };
}
