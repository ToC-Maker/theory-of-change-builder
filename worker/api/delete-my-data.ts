// DELETE /api/my-data — GDPR Art. 17 erasure. Identity dispatch (JWT → auth
// sub, else `tocb_actor_id` cookie → anon actor); cascade-first cleanup
// (sole-owned charts hard-deleted, collab-edited charts orphaned to
// user_id=NULL); user_api_usage carved out under a separate Art 6(1)(f)
// basis (LIA §1B) as anti-abuse, no-opt-out.

import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { resolveAnonActor } from '../_shared/anon-id';
import {
  deleteOneAnthropicFile as sharedDeleteOneAnthropicFile,
  fanOutAnthropicFileDeletes,
  type AnthropicFileDeleteFailure,
  type DeleteOutcome,
} from '../_shared/anthropic-files';
import type {
  DeleteMyDataNoData,
  DeleteMyDataResponse,
  DeleteMyDataSuccess,
} from '../../shared/delete-my-data';

// ---------------------------------------------------------------------------
// Cookie-clearing helpers (exported for unit tests).
// ---------------------------------------------------------------------------

export const COOKIES_TO_CLEAR_ON_DATA_DELETE = ['tocb_anon', 'tocb_auth_link'] as const;

// Preserved deliberately: clearing tocb_actor_id would silently mint a fresh
// anon cap for the same browser, defeating the user_api_usage carve-out.
export const COOKIES_TO_PRESERVE_ON_DATA_DELETE = ['tocb_actor_id'] as const;

// Allow the safe character class only — names go straight into a
// Set-Cookie header, so a CR/LF or whitespace would let a caller forge
// extra headers. Match the validation used elsewhere for cookie values.
const SAFE_COOKIE_NAME_RE = /^[A-Za-z0-9_\-.]+$/;

// 1970-01-01 — well in the past for every clock skew the browser might
// have. UTC literal so we don't depend on the runtime's tz.
const EPOCH_GMT = 'Thu, 01 Jan 1970 00:00:00 GMT';

// RFC 6265 §3.1: Max-Age=0 OR Expires-in-past deletes a cookie. Send both so
// old browsers that only honour one still drop it. Path/Secure/HttpOnly/
// SameSite must mirror the live cookies' attributes so the browser matches
// and overwrites the right entry.
export function buildExpiredCookieHeader(name: string): string {
  if (!SAFE_COOKIE_NAME_RE.test(name)) {
    throw new Error(`invalid cookie name: ${JSON.stringify(name)}`);
  }
  return `${name}=; Path=/; Max-Age=0; Expires=${EPOCH_GMT}; Secure; HttpOnly; SameSite=Lax`;
}

export function buildClearedCookieHeaders(): string[] {
  return COOKIES_TO_CLEAR_ON_DATA_DELETE.map(buildExpiredCookieHeader);
}

// ---------------------------------------------------------------------------
// Anthropic Files API DELETE fan-out.
//
// Delegates to the shared helper in worker/_shared/anthropic-files.ts so the
// same logic backs the Clear-Chat path in chart-files.ts. We re-export under
// the historical names so existing unit tests keep working without churn; the
// `[delete-my-data]` log prefix is preserved.
// ---------------------------------------------------------------------------

const LOG_PREFIX = '[delete-my-data]';

export function deleteOneAnthropicFile(apiKey: string, fid: string): Promise<DeleteOutcome> {
  return sharedDeleteOneAnthropicFile(apiKey, fid, LOG_PREFIX);
}

export function fanOutAnthropicDeletes(
  apiKey: string,
  fileIds: readonly string[],
): Promise<AnthropicFileDeleteFailure[]> {
  return fanOutAnthropicFileDeletes(apiKey, fileIds, LOG_PREFIX);
}

// ---------------------------------------------------------------------------
// Audit row in logging_errors. The audit row's `user_id` column is set to
// NULL so the cascade DELETE-by-user_id below cannot wipe its own audit
// trail; the real user_id lives in `request_metadata.user_id` for operator
// queries. This invariant is referenced by both the Phase-2a insert and the
// Phase-2b cascade — single source of truth here.
// ---------------------------------------------------------------------------

type Sql = ReturnType<typeof getDb>;

const ERROR_NAME_FILES_PENDING = 'delete_my_data_files_pending';
const ERROR_NAME_CASCADE_FAILED = 'delete_my_data_failed';
const ERROR_NAME_AUDIT_TRANSITION_FAILED = 'delete_my_data_audit_transition_failed';

// Exported for unit tests: callers (or test stubs) can pass a recording `sql`
// stub and assert what gets bound. The real `sql` parameter binding above
// (user_id = ${null}) is the load-bearing privacy guarantee — the audit row
// must NOT carry a user_id, otherwise the `DELETE FROM logging_errors WHERE
// user_id = ${userId}` step inside the cascade would wipe the row that
// records the cascade itself.
export async function insertPendingAuditRow(
  sql: Sql,
  errorId: string,
  userId: string,
  fileIds: readonly string[],
): Promise<void> {
  // Future retry job filters on error_name='delete_my_data_files_pending'
  // AND request_metadata->'file_ids' is non-empty AND no sibling
  // 'delete_my_data_audit_transition_failed' row exists for this incident_id
  // (sibling presence means the cascade itself rolled back; replaying the
  // file DELETEs would attempt to re-delete files whose local rows are still
  // present, which is a privacy regression rather than a recovery).
  await sql`
    INSERT INTO logging_errors (
      error_id, error_name, error_message, user_id, request_metadata
    )
    VALUES (
      ${errorId},
      ${ERROR_NAME_FILES_PENDING},
      ${`Pending Anthropic file DELETEs for ${fileIds.length} file(s)`},
      ${null},
      ${JSON.stringify({ user_id: userId, file_ids: fileIds, status: 'pending' })}
    )
  `;
}

async function finalizeAuditRow(
  sql: Sql,
  errorId: string,
  userId: string,
  failures: AnthropicFileDeleteFailure[],
): Promise<void> {
  if (failures.length === 0) {
    await sql`DELETE FROM logging_errors WHERE error_id = ${errorId}`;
    return;
  }
  // Split by transient/permanent so a future retry job can pick up only the
  // transient ones. `file_ids` (legacy aggregate) is preserved so existing
  // queries on request_metadata->'file_ids' keep working.
  const transientFids = failures.filter((f) => f.transient).map((f) => f.fid);
  const permanentFids = failures.filter((f) => !f.transient).map((f) => f.fid);
  await sql`
    UPDATE logging_errors
       SET request_metadata = ${JSON.stringify({
         user_id: userId,
         file_ids: failures.map((f) => f.fid),
         transient_file_ids: transientFids,
         permanent_file_ids: permanentFids,
         status: 'partial',
       })}
     WHERE error_id = ${errorId}
  `;
}

async function recordCascadeFailure(
  sql: Sql,
  errorId: string,
  userId: string,
  err: unknown,
): Promise<void> {
  const code = (err as { code?: string })?.code ?? null;
  const message = err instanceof Error ? err.message : String(err);
  await sql`
    UPDATE logging_errors
       SET error_name = ${ERROR_NAME_CASCADE_FAILED},
           error_message = ${`Cascade transaction failed: ${message}`},
           request_metadata = ${JSON.stringify({
             user_id: userId,
             pg_code: code,
             error_message: message,
           })}
     WHERE error_id = ${errorId}
  `;
}

// Best-effort transition of the pending audit row to a failure incident.
// Used by both the cascade catch and the BYOK catch — the pattern is
// identical except for the `stage` discriminator that tags the sibling
// diagnostic when even the transition itself fails. Caller still returns
// the same incident_id so the user has something concrete to quote.
async function tryRecordFailure(
  sql: Sql,
  incidentId: string,
  userId: string,
  fileIdsPromised: readonly string[],
  err: unknown,
  stage: 'cascade' | 'byok_delete',
): Promise<void> {
  try {
    await recordCascadeFailure(sql, incidentId, userId, err);
  } catch (auditErr) {
    console.error(`${LOG_PREFIX} ${stage} audit-row failure transition also failed:`, auditErr);
    // The original audit row is now stuck in 'pending' state but the work
    // it referred to (cascade / BYOK delete) actually rolled back. A future
    // retry job seeing 'pending' would mistakenly replay file deletes that
    // never happened — insert a sibling diagnostic so an operator can find
    // these stuck rows, and so the retry job's filter (no sibling
    // ERROR_NAME_AUDIT_TRANSITION_FAILED for the same incident_id) excludes
    // them.
    try {
      const stageLabel = stage === 'cascade' ? 'cascade rolled back' : 'BYOK delete failed';
      await sql`
        INSERT INTO logging_errors (
          error_id, error_name, error_message, user_id, request_metadata
        )
        VALUES (
          ${crypto.randomUUID()},
          ${ERROR_NAME_AUDIT_TRANSITION_FAILED},
          ${`Could not transition incident ${incidentId} to failed status; ${stageLabel} but original row remains 'pending'`},
          ${null},
          ${JSON.stringify({
            user_id: userId,
            original_incident_id: incidentId,
            file_ids_promised: fileIdsPromised,
            stage,
            cascade_error: err instanceof Error ? err.message : String(err),
            transition_error: auditErr instanceof Error ? auditErr.message : String(auditErr),
          })}
        )
      `;
    } catch (siblingErr) {
      console.error(`${LOG_PREFIX} ${stage} sibling diagnostic insert also failed:`, siblingErr);
    }
  }
}

// ---------------------------------------------------------------------------
// Identity resolution: dual-mode (auth via JWT, anon via tocb_actor_id).
// ---------------------------------------------------------------------------

// Tagged union: the `false` arm splits into three semantically distinct
// kinds so the handler can't accidentally treat a 200-no-data path the same
// as a 401-invalid-token (e.g. attempting an anon BYOK delete on a no-data
// path that has no actor cookie). `kind` is exhaustive over the false arms.
export type IdentityResult =
  | { ok: true; userId: string; authenticated: boolean }
  | { ok: false; kind: 'unauthorized'; response: Response }
  | { ok: false; kind: 'service_unavailable'; response: Response }
  | { ok: false; kind: 'no_data'; response: Response };

async function resolveIdentity(request: Request, env: Env): Promise<IdentityResult> {
  const token = extractToken(request.headers.get('authorization'));
  if (token) {
    try {
      const decoded = await verifyToken(token, env);
      return { ok: true, userId: decoded.sub, authenticated: true };
    } catch (err) {
      if (err instanceof JWKSFetchError) {
        console.error(`${LOG_PREFIX} JWKS fetch failed during token verify:`, err);
        return {
          ok: false,
          kind: 'service_unavailable',
          response: Response.json({ error: 'authentication_service_unavailable' }, { status: 503 }),
        };
      }
      // Visibility for unauthorized hits — without this, an attacker spraying
      // invalid tokens at /api/my-data leaves no breadcrumb. Use `warn` so
      // it's distinct from the JWKS-availability `error` above.
      console.warn(`${LOG_PREFIX} Token verification failed (invalid_token):`, err);
      return {
        ok: false,
        kind: 'unauthorized',
        response: Response.json({ error: 'invalid_token' }, { status: 401 }),
      };
    }
  }

  // Anonymous: identity is the cookie-pinned actor UUID. We deliberately do
  // NOT mint a fresh tocb_actor_id here — a "delete my data" call from an
  // anon visitor with no cookie has no data to delete, but we should treat
  // it as a no-op success rather than mint a cookie just to wipe nothing.
  // resolveAnonActor mints on first visit, so a no-cookie caller would get
  // a brand-new identity returned. Filter that case out by checking
  // setCookieHeader.
  try {
    const resolved = await resolveAnonActor(request, env);
    if (resolved.setCookieHeader) {
      // Caller had no actor cookie — no anon data could possibly exist for
      // this browser. Return a 200 with a no-op summary; do NOT echo the
      // freshly minted cookie (we don't want to assign an identity just to
      // delete from it).
      const body: DeleteMyDataNoData = { ok: true, no_data: true };
      return {
        ok: false,
        kind: 'no_data',
        response: Response.json(body, { status: 200 }),
      };
    }
    return { ok: true, userId: resolved.userId, authenticated: false };
  } catch (e) {
    console.error(`${LOG_PREFIX} resolveAnonActor failed:`, e);
    return {
      ok: false,
      kind: 'service_unavailable',
      response: Response.json({ error: 'actor_unavailable' }, { status: 503 }),
    };
  }
}

// ---------------------------------------------------------------------------
// Cascade-statement builders. Extracted so a recording `sql` stub in unit
// tests can assert the exact set of tables touched by the auth vs anon
// transactions. The structural difference IS the privacy guarantee:
//   - Anon path must NOT touch user_byok_keys (no fresh JWT == no BYOK delete
//     authority). buildByokDeleteStatements returns [] for !authenticated.
//   - Neither path touches user_api_usage (Art 6(1)(f) carve-out, LIA §1B).
// ---------------------------------------------------------------------------

/**
 * Returns the array of pending statements for the Phase 2b cascade
 * transaction (charts + logging_*  + chart_files + chart_permissions).
 * Caller hands the array to `sql.transaction(...)`.
 *
 * Auth gets one extra statement: `DELETE FROM logging_preferences` (anon has
 * no server-side preferences row to wipe — it's keyed on Auth0 sub). The BYOK
 * row is handled separately in `buildByokDeleteStatements` — keeping the BYOK
 * delete out of this cascade lets us use RETURNING to discover whether a row
 * actually existed.
 */
export function buildCascadeStatements(
  sql: Sql,
  authenticated: boolean,
  userId: string,
  soleOwnedIds: readonly string[],
  collabEditedIds: readonly string[],
): unknown[] {
  const stmts: unknown[] = [
    soleOwnedIds.length > 0
      ? sql`DELETE FROM charts WHERE id = ANY(${soleOwnedIds}::text[]) AND user_id = ${userId}`
      : sql`SELECT 1 WHERE FALSE`,
    collabEditedIds.length > 0
      ? sql`UPDATE charts SET user_id = NULL WHERE id = ANY(${collabEditedIds}::text[]) AND user_id = ${userId}`
      : sql`SELECT 1 WHERE FALSE`,
    sql`DELETE FROM logging_messages WHERE user_id = ${userId}`,
    sql`DELETE FROM logging_snapshots WHERE session_id IN (
          SELECT session_id FROM logging_sessions WHERE user_id = ${userId}
        )`,
    sql`DELETE FROM logging_sessions WHERE user_id = ${userId}`,
    sql`DELETE FROM logging_errors WHERE user_id = ${userId}`,
  ];
  if (authenticated) {
    stmts.push(sql`DELETE FROM logging_preferences WHERE user_id = ${userId}`);
  }
  stmts.push(
    sql`DELETE FROM chart_files WHERE user_id = ${userId}`,
    sql`DELETE FROM chart_permissions WHERE user_id = ${userId}`,
  );
  return stmts;
}

/**
 * Returns the BYOK delete transaction's statements: empty for anon, two
 * statements (zeroize then DELETE … RETURNING) for auth. Anon explicitly
 * does NOT delete the BYOK blob — the JWT is the BYOK authority, and an
 * anon caller (even one whose `tocb_auth_link` resolves to an auth sub) must
 * obtain a fresh token to wipe it. Mirrors byok-key.ts.
 *
 * The empty-array shape for anon is the load-bearing guarantee: handing []
 * to `sql.transaction([])` is a no-op.
 */
export function buildByokDeleteStatements(
  sql: Sql,
  authenticated: boolean,
  userId: string,
): unknown[] {
  if (!authenticated) return [];
  return [
    sql`UPDATE user_byok_keys SET encrypted_key = '\\x'::bytea WHERE user_id = ${userId}`,
    sql`DELETE FROM user_byok_keys WHERE user_id = ${userId} RETURNING user_id`,
  ];
}

/**
 * The dispatch decision for "should this caller's request run the BYOK delete
 * branch?". The rule is "auth only" — full stop. A separate helper (rather
 * than inlining `if (authenticated)`) captures the rule in one named place,
 * making it harder to accidentally widen the predicate (e.g. by trusting
 * `tocb_auth_link` for anon callers, which would let a stale auth-link
 * cookie wipe the linked user's BYOK key without a fresh JWT).
 */
export function shouldRunByokDelete(authenticated: boolean): boolean {
  return authenticated;
}

// ---------------------------------------------------------------------------
// Main handler.
// ---------------------------------------------------------------------------

export async function handler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== 'DELETE') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const ident = await resolveIdentity(request, env);
  if (!ident.ok) return ident.response;
  const { userId, authenticated } = ident;

  const sql = getDb(env);

  // --- Phase 1: read-only discovery -----------------------------------------
  // Find sole-owned charts (no other-user activity anywhere). Read-only and
  // outside the write transaction so we don't hold locks while reading.
  //
  // TOCTOU note: a concurrent share that lands between this discovery and
  // the Phase-2 write would still hard-delete a chart that has just gained
  // a collaborator. Window is the Phase-1→Phase-2 round-trip (sub-second);
  // a real fix would be to repeat the collab-detection inside the write
  // transaction with FOR UPDATE on chart_permissions / chart_files /
  // logging_sessions rows for the candidate chart_ids. Acceptable for v1
  // given the small window and the destructive intent of the caller.
  let soleOwnedIds: string[];
  let collabEditedIds: string[];
  try {
    const ownedRows = await sql`
      SELECT id FROM charts WHERE user_id = ${userId}
    `;
    const allOwnedIds: string[] = ownedRows.map((r) => r.id as string);

    if (allOwnedIds.length === 0) {
      soleOwnedIds = [];
      collabEditedIds = [];
    } else {
      // A chart is sole-owned iff there is NO row in chart_permissions /
      // chart_files / logging_sessions referencing it under a different
      // user_id. Single round-trip via UNION, then split allOwnedIds.
      const collabRows = await sql`
        SELECT DISTINCT chart_id FROM (
          SELECT chart_id FROM chart_permissions
            WHERE chart_id = ANY(${allOwnedIds}::text[]) AND user_id <> ${userId}
          UNION ALL
          SELECT chart_id FROM chart_files
            WHERE chart_id = ANY(${allOwnedIds}::text[])
              AND user_id IS NOT NULL AND user_id <> ${userId}
          UNION ALL
          SELECT chart_id FROM logging_sessions
            WHERE chart_id = ANY(${allOwnedIds}::text[])
              AND user_id IS NOT NULL AND user_id <> ${userId}
        ) collab
      `;
      const collabSet = new Set<string>(collabRows.map((r) => r.chart_id as string));
      soleOwnedIds = allOwnedIds.filter((id) => !collabSet.has(id));
      collabEditedIds = allOwnedIds.filter((id) => collabSet.has(id));
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} discovery query failed:`, e);
    return classifyDbError(e);
  }

  // Snapshot file_ids the user owns BEFORE any DELETE so we can still
  // fan out Anthropic-side cleanup after CASCADE removes the rows.
  let userFileIds: string[];
  try {
    const fileRows = await sql`
      SELECT file_id FROM chart_files WHERE user_id = ${userId}
    `;
    userFileIds = fileRows.map((r) => r.file_id as string);
  } catch (e) {
    console.error(`${LOG_PREFIX} file_id snapshot failed:`, e);
    return classifyDbError(e);
  }

  // --- Phase 2a: pre-cascade audit row -------------------------------------
  // Insert one durable audit row capturing the file_ids we're about to
  // promise to delete at Anthropic. The cascade DELETE-by-user_id can't wipe
  // it (audit-row invariant: user_id = NULL on the row, real user_id in
  // request_metadata) so even if the cascade itself fails we still have an
  // incident record to return as `error_id`.
  //
  // Inserted unconditionally — even when userFileIds is empty — so that
  // charts-only / BYOK-only users hitting a cascade failure get a queryable
  // incident_id back. The "0 file(s)" message is correct for those rows;
  // the retry job filters on file_ids.length > 0 before replaying anything.
  const incidentId = crypto.randomUUID();
  try {
    await insertPendingAuditRow(sql, incidentId, userId, userFileIds);
  } catch (e) {
    console.error(`${LOG_PREFIX} audit-row insert failed; refusing to cascade:`, e);
    return classifyDbError(e);
  }

  // --- Phase 2b: write transaction -----------------------------------------
  // Order:
  //   1. DELETE sole-owned charts (cascades chart_files / chart_permissions;
  //      sets logging_*.chart_id NULL).
  //   2. UPDATE collab-edited charts to user_id = NULL.
  //   3. DELETE logging_messages WHERE user_id = ?
  //   4. DELETE logging_snapshots tied to user's sessions.
  //   5. DELETE logging_sessions (cascades any leftover messages/snapshots).
  //   6. DELETE logging_errors WHERE user_id = ?
  //      (audit row above has user_id = NULL — see invariant — so it survives.)
  //   7. DELETE logging_preferences (auth only; anon table is keyed on sub).
  //   8. DELETE chart_files WHERE user_id = ? (orphan-chart sweep).
  //   9. DELETE chart_permissions WHERE user_id = ? (orphan-chart sweep).
  //
  // BYOK delete is a separate transaction (Phase 2c) so we can use RETURNING
  // to know whether a row actually existed.
  //
  // Anon path note: userId can be `anon-<uuid>` (no auth-link cookie) OR an
  // auth sub (resolveAnonActor returns the linked sub when tocb_auth_link
  // verifies). Post-logout calls still route here, not to the auth branch,
  // because resolveIdentity hard-codes authenticated=false for non-JWT
  // requests. That gates BYOK delete behind a fresh JWT, mirroring
  // byok-key.ts, so a stale auth-link cookie can never trigger a BYOK wipe.
  try {
    await sql.transaction(
      buildCascadeStatements(
        sql,
        authenticated,
        userId,
        soleOwnedIds,
        collabEditedIds,
      ) as Parameters<typeof sql.transaction>[0],
    );
  } catch (e) {
    console.error(`${LOG_PREFIX} write transaction failed:`, e);
    // Best-effort: transition the audit row to a failure incident so a
    // human can see what went wrong. If even this fails (and the sibling
    // diagnostic too) we still return the same incident_id, so the user
    // has something to quote.
    await tryRecordFailure(sql, incidentId, userId, userFileIds, e, 'cascade');
    return classifyDbError(e, incidentId);
  }

  // --- Phase 2c: BYOK delete (auth only) -----------------------------------
  // Separate from the cascade transaction so we can RETURNING the row count
  // and know whether the user actually had a key. Zero-then-delete mirrors
  // byok-key.ts; bytea zeroization isn't a security primitive (WAL/replicas
  // may hold the old ciphertext) but it shrinks the in-flight surface.
  let byokDeleted = false;
  if (shouldRunByokDelete(authenticated)) {
    try {
      const result = (await sql.transaction(
        buildByokDeleteStatements(sql, authenticated, userId) as Parameters<
          typeof sql.transaction
        >[0],
      )) as Array<Array<{ user_id: string }>>;
      // sql.transaction returns an array of statement results; the second
      // statement's RETURNING is what we want.
      const deletedRows = result[1] ?? [];
      byokDeleted = deletedRows.length > 0;
    } catch (e) {
      // Charts are already deleted at this point; failing to drop the BYOK
      // row would leave an orphan blob keyed under a user that no longer
      // owns anything, which is a privacy regression. Surface as an incident
      // so the operator can chase it manually. Same audit-row failure-path
      // contract as the cascade catch above.
      console.error(`${LOG_PREFIX} BYOK delete failed (post-cascade):`, e);
      await tryRecordFailure(sql, incidentId, userId, userFileIds, e, 'byok_delete');
      return classifyDbError(e, incidentId);
    }
  }

  // --- Phase 3: Anthropic Files API fan-out --------------------------------
  // Audit row at incidentId is the durable record of what we promised to
  // delete. Fan-out runs after the response (ctx.waitUntil); on completion
  // it either DELETEs the audit row (all succeeded) or UPDATEs it with the
  // surviving failed file_ids split by transient/permanent (so a future
  // scheduled-task replay picks up only the transient ones).
  //
  // Skip when ANTHROPIC_API_KEY is unset (test/local-dev) — local rows are
  // already gone so it's not a privacy regression for the CI/dev path. The
  // response shape distinguishes "fan-out scheduled" from "fan-out skipped"
  // via the `remote_files.mode` discriminator, so the UI can avoid claiming
  // "queued for remote deletion" when no fan-out actually happened.
  const remoteDeleteEnabled = Boolean(env.ANTHROPIC_API_KEY) && userFileIds.length > 0;
  if (remoteDeleteEnabled) {
    const apiKey = env.ANTHROPIC_API_KEY as string;
    ctx.waitUntil(
      (async () => {
        const failed = await fanOutAnthropicDeletes(apiKey, userFileIds);
        try {
          await finalizeAuditRow(sql, incidentId, userId, failed);
        } catch (auditErr) {
          console.error(`${LOG_PREFIX} audit-row finalize failed:`, auditErr);
        }
      })(),
    );
  } else if (userFileIds.length > 0) {
    // ANTHROPIC_API_KEY unset: drop the audit row we just inserted, since
    // there's no fan-out to track. Best-effort; if this fails the row will
    // be picked up by the future retry job.
    ctx.waitUntil(
      sql`DELETE FROM logging_errors WHERE error_id = ${incidentId}`.then(
        () => undefined,
        (e: unknown) => console.error(`${LOG_PREFIX} audit-row cleanup (no-key path) failed:`, e),
      ),
    );
  }

  // --- Phase 4: response with cookie clears --------------------------------
  // `Clear-Site-Data: "storage"` on the auth-path 200 wipes the Auth0 token
  // cache (we use cacheLocation="localstorage") so a deleted account can't
  // continue to use a residual JWT from the same browser tab — fixes the
  // ~24h "still logged in" gap if the user closes the tab before the
  // 1.5s-deferred logout() in the panel fires.
  //
  // Why not "cookies": that would clear `tocb_actor_id`, defeating the
  // user_api_usage carve-out (the cap stays attached to the browser, see
  // COOKIES_TO_PRESERVE_ON_DATA_DELETE). The Auth0 JWT itself doesn't live
  // in our cookies — only `tocb_anon`/`tocb_auth_link` do, and those are
  // cleared explicitly via Set-Cookie above.
  //
  // Why not "executionContexts": too aggressive — it'd close other tabs of
  // the same origin, surprising the user.
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of buildClearedCookieHeaders()) {
    headers.append('Set-Cookie', cookie);
  }
  if (authenticated) {
    headers.set('Clear-Site-Data', '"storage"');
  }

  const remoteFiles: DeleteMyDataSuccess['remote_files'] = remoteDeleteEnabled
    ? { mode: 'queued', count: userFileIds.length }
    : userFileIds.length > 0
      ? { mode: 'disabled' }
      : { mode: 'queued', count: 0 };

  const body: DeleteMyDataResponse = {
    ok: true,
    deleted: {
      charts_hard_deleted: soleOwnedIds.length,
      charts_orphaned: collabEditedIds.length,
      files: userFileIds.length,
      byok: byokDeleted,
    },
    remote_files: remoteFiles,
  };

  return new Response(JSON.stringify(body), { status: 200, headers });
}

// Postgres error classes that signal "retry might succeed". Mapped to a 503
// retry hint instead of a 500 corruption response. Anything not in this set
// (constraint, syntax, permission) is non-transient → 500.
//
// Codes covered:
//   08*    connection_exception (network drop, pool exhaustion)
//   53*    insufficient_resources (out of memory / disk / connections)
//   57P0*  operator_intervention. Neon's idle reconnect raises 57P01
//          (admin_shutdown) when its serverless control plane recycles a
//          compute instance — extremely common on cold paths. Without this
//          mapping the user sees a 500 for what is in fact a transient
//          reconnect.
//   40001  serialization_failure (SSI rollback, retry succeeds)
//   40P01  deadlock_detected (lock-graph cycle, retry succeeds)
// Exported for unit tests.
export function isTransientPgErrorCode(code: string): boolean {
  return (
    code.startsWith('08') ||
    code.startsWith('53') ||
    code.startsWith('57P0') ||
    code === '40001' ||
    code === '40P01'
  );
}

// Map a Postgres error to the right HTTP response. Transient classes →
// retry hint via 503. Everything else is non-transient → 500 with the
// incident_id so the user has something concrete to quote when reporting.
// Exported for tests.
export function classifyDbError(err: unknown, incidentId?: string): Response {
  const code = (err as { code?: string })?.code;
  if (typeof code === 'string' && isTransientPgErrorCode(code)) {
    return Response.json({ error: 'database_unavailable' }, { status: 503 });
  }
  return Response.json(
    {
      error: 'database_error',
      incident_id: incidentId ?? null,
    },
    { status: 500 },
  );
}
