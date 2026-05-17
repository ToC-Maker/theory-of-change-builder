// Single source of truth for permission-related types shared between the
// frontend and the Worker.
//
// Before this module existed the `LinkSharingLevel` union was duplicated in
// ~6 places (the share components, the hook, and inlined three times in
// `chartService.ts`). Adding a fourth mode required hunting through every
// declaration; one missed site silently widened the type to `string` at the
// consumer because the unions are structurally compatible. Consolidating
// here makes a future `'commenter'` mode a one-file change with TypeScript
// catching every still-narrow caller.
//
// The `Permission` shape is the canonical API response row for
// `/api/managePermissions?chartId=...`. The Worker already returns `status`
// in the row (see `worker/api/managePermissions.ts`); we declare it here
// so the typed client matches reality. UI-side components used to redeclare
// a `PermissionRow` with `status?` because the canonical interface was
// missing it; with this consolidation `PermissionRow` is a thin alias.

/** Link-sharing posture for a chart. Mirrored by the server validator. */
export type LinkSharingLevel = 'restricted' | 'viewer' | 'editor';

/** Approval status of a chart_permissions row. */
export type PermissionStatus = 'pending' | 'approved' | 'rejected';

/** Single chart_permissions row as returned by the API. */
export interface Permission {
  user_id: string;
  user_email: string;
  permission_level: 'owner' | 'edit';
  granted_at: string;
  granted_by: string;
  /**
   * Approval status. Optional for backwards compatibility with older API
   * responses; the current Worker always returns it. Treat `undefined` as
   * `'approved'` for rendering.
   */
  status?: PermissionStatus;
}
