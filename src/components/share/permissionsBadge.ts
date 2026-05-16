// Tiny helpers shared by ShareDialog and the TopBar Share button.
// Kept in its own module so the React-Refresh `only-export-components`
// rule remains happy for ShareDialog.tsx.

import type { PermissionRow } from './PermissionsList';

/** Count of pending access requests, used for the Share button badge. */
export function countPendingRequests(permissions: PermissionRow[]): number {
  return permissions.filter((p) => p.status === 'pending').length;
}
