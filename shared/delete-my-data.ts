// Response shape for `DELETE /api/my-data` (the GDPR Art. 17 erasure
// endpoint). Lives in `shared/` because both the worker (`worker/api/
// delete-my-data.ts`) and the client (`src/components/DeleteMyDataPanel.tsx`)
// need to agree on the wire format. Hand-rolling on each side previously
// drifted: the server emitted a flat `remote_delete_disabled` boolean
// alongside `files_pending_remote_delete`, which the client had to
// double-check at every render site.
//
// The `remote_files` field is a tagged union so impossible states
// (`disabled === true && count > 0`) are unrepresentable.

/** Per-resource counts. Keys match the ones the panel renders. */
export interface DeleteSummary {
  charts_hard_deleted: number;
  charts_orphaned: number;
  files: number;
  byok: boolean;
}

/**
 * Outcome of the Anthropic Files API DELETE fan-out.
 *
 * - `queued` — fan-out scheduled via `ctx.waitUntil`. `count` is the number
 *   of file_ids submitted; the audit row at `error_id = incident_id` is the
 *   durable record. `count === 0` is valid (no files needed remote action,
 *   service is available).
 * - `disabled` — `ANTHROPIC_API_KEY` is unset on the worker (test/local-dev).
 *   Local rows are gone; Anthropic-side files persist until manual cleanup.
 *   The UI surfaces this honestly rather than promising a queue that won't
 *   drain.
 */
export type RemoteFilesStatus = { mode: 'queued'; count: number } | { mode: 'disabled' };

/** No-data path: caller had no actor cookie + no JWT. Nothing to delete. */
export interface DeleteMyDataNoData {
  ok: true;
  no_data: true;
}

/** Successful erasure (auth or anon). `remote_files` is always populated. */
export interface DeleteMyDataSuccess {
  ok: true;
  no_data?: false;
  deleted: DeleteSummary;
  remote_files: RemoteFilesStatus;
}

/** Error response from any 4xx/5xx path. `incident_id` is set on cascade-fail 500s. */
export interface DeleteMyDataError {
  error: string;
  incident_id?: string | null;
}

export type DeleteMyDataResponse = DeleteMyDataNoData | DeleteMyDataSuccess | DeleteMyDataError;

/** Narrowing helper for callers that want a single `if (isSuccess(...))`. */
export function isDeleteMyDataSuccess(res: DeleteMyDataResponse): res is DeleteMyDataSuccess {
  return 'ok' in res && res.ok === true && res.no_data !== true;
}

export function isDeleteMyDataNoData(res: DeleteMyDataResponse): res is DeleteMyDataNoData {
  return 'ok' in res && res.ok === true && res.no_data === true;
}

export function isDeleteMyDataError(res: DeleteMyDataResponse): res is DeleteMyDataError {
  return 'error' in res;
}
