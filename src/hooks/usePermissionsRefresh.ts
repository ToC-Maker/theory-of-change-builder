// usePermissionsRefresh — L1 mitigation per the Figma redesign plan,
// PR 2 Task 2.3.
//
// Two-tab race scenario:
//   Tab A and Tab B both have the ShareDialog open. Tab A flips
//   `linkSharingLevel` from 'restricted' to 'viewer' and writes via the
//   `managePermissions` PUT. Tab B's local state is now stale; the next
//   read it submits will overwrite Tab A's change (last-write-wins).
//
// As of the App-owns-permissions refactor (PR 2 fix-pass), the
// permissions array + linkSharingLevel are owned by App.tsx, which polls
// every 30s (the actual correctness guarantee). This hook is now a thin
// storage-event adapter: when any other tab in the same browser writes
// to localStorage, fire an `onInvalidate` callback so App's poller
// refetches immediately rather than waiting up to 30s.
//
// What this hook owns:
//   - A `storage` event listener (key-agnostic; any storage event
//     triggers an invalidate, since the cost of an extra refetch is
//     much smaller than the foot-gun of missing one because the sentinel
//     key changed).
//
// What this hook explicitly does NOT do:
//   - Fetch anything. App.tsx owns the fetcher and state. The hook
//     no longer participates in the divergence/error surface.
//   - 30s polling. App.tsx owns that too.
//   - Optimistic locking. Deferred to post-redesign; this hook is the
//     lightweight cross-tab nudge that keeps the App-level state warm.
//
// References:
//   - React storage-event docs: developer.mozilla.org/en-US/docs/Web/API/Window/storage_event
//   - Plan: `plans/figma-redesign.md` (parent repo, not committed to feature
//     branches). Look for the §198 Important hook-acceptance bullet.

import { useEffect, useRef } from 'react';

export interface UsePermissionsRefreshOptions {
  /** Whether the listener should be active. Hook is a no-op when false. */
  enabled: boolean;
  /** Called whenever a cross-tab storage event fires. */
  onInvalidate: () => void;
}

export function usePermissionsRefresh({
  enabled,
  onInvalidate,
}: UsePermissionsRefreshOptions): void {
  // Stable ref so the listener registered once survives identity churn
  // of the callsite's arrow function.
  const onInvalidateRef = useRef(onInvalidate);
  useEffect(() => {
    onInvalidateRef.current = onInvalidate;
  }, [onInvalidate]);

  useEffect(() => {
    if (!enabled) return;
    const onStorage = () => {
      onInvalidateRef.current();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [enabled]);
}
