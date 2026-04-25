// DELETE /api/my-data — GDPR Art. 17 erasure. Identity dispatch (JWT → auth
// sub, else `tocb_actor_id` cookie → anon actor); cascade-first cleanup
// (sole-owned charts hard-deleted, collab-edited charts orphaned to
// user_id=NULL); user_api_usage carved out under a separate Art 6(1)(f)
// basis (LIA §1B) as anti-abuse, no-opt-out.

import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { resolveAnonActor } from '../_shared/anon-id';

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
// ---------------------------------------------------------------------------

const ANTHROPIC_DELETE_CONCURRENCY = 6;

// Per-id DELETE outcome. 200/204/404 (already gone) all count as success.
// Exported for unit tests (so we don't have to mock the per-batch loop).
export async function deleteOneAnthropicFile(apiKey: string, fid: string): Promise<boolean> {
  try {
    const upstream = await fetch(`https://api.anthropic.com/v1/files/${encodeURIComponent(fid)}`, {
      method: 'DELETE',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
      },
    });
    if (upstream.ok || upstream.status === 404) return true;
    const errText = await upstream.text().catch(() => '');
    console.error(
      `[delete-my-data] Anthropic DELETE ${upstream.status} for file_id=${fid}: ${errText}`,
    );
    return false;
  } catch (err) {
    console.error(`[delete-my-data] Anthropic DELETE fetch failed for file_id=${fid}:`, err);
    return false;
  }
}

// Returns the file_ids that did NOT delete successfully so the caller can
// keep them in the dead-letter row for a later retry. Exported for tests.
export async function fanOutAnthropicDeletes(
  apiKey: string,
  fileIds: readonly string[],
): Promise<string[]> {
  const failed: string[] = [];
  for (let i = 0; i < fileIds.length; i += ANTHROPIC_DELETE_CONCURRENCY) {
    const chunk = fileIds.slice(i, i + ANTHROPIC_DELETE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(
        async (fid): Promise<[string, boolean]> => [fid, await deleteOneAnthropicFile(apiKey, fid)],
      ),
    );
    for (const [fid, ok] of results) if (!ok) failed.push(fid);
  }
  return failed;
}

// ---------------------------------------------------------------------------
// Audit row in logging_errors. Source of truth for "files we promised to
// delete at Anthropic but haven't confirmed yet" and for cascade-failure
// incidents. The row's user_id stays NULL so the cascade DELETE-by-user_id
// inside the same request doesn't wipe its own audit trail; the real user_id
// lives in request_metadata.
// ---------------------------------------------------------------------------

type Sql = ReturnType<typeof getDb>;

const ERROR_NAME_FILES_PENDING = 'delete_my_data_files_pending';
const ERROR_NAME_CASCADE_FAILED = 'delete_my_data_failed';

async function insertPendingAuditRow(
  sql: Sql,
  errorId: string,
  userId: string,
  fileIds: readonly string[],
): Promise<void> {
  // TODO: scheduled retry job — read rows WHERE error_name = 'delete_my_data_files_pending'
  // and replay the Anthropic DELETE for each file_id in request_metadata.file_ids.
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
  failedFileIds: string[],
): Promise<void> {
  if (failedFileIds.length === 0) {
    await sql`DELETE FROM logging_errors WHERE error_id = ${errorId}`;
    return;
  }
  await sql`
    UPDATE logging_errors
       SET request_metadata = ${JSON.stringify({
         user_id: userId,
         file_ids: failedFileIds,
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

// ---------------------------------------------------------------------------
// Identity resolution: dual-mode (auth via JWT, anon via tocb_actor_id).
// ---------------------------------------------------------------------------

type IdentityResult =
  | { ok: true; userId: string; authenticated: boolean }
  | { ok: false; response: Response };

async function resolveIdentity(request: Request, env: Env): Promise<IdentityResult> {
  const token = extractToken(request.headers.get('authorization'));
  if (token) {
    try {
      const decoded = await verifyToken(token, env);
      return { ok: true, userId: decoded.sub, authenticated: true };
    } catch (err) {
      if (err instanceof JWKSFetchError) {
        return {
          ok: false,
          response: Response.json({ error: 'authentication_service_unavailable' }, { status: 503 }),
        };
      }
      return {
        ok: false,
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
      return {
        ok: false,
        response: Response.json(
          {
            ok: true,
            deleted: { charts_hard_deleted: 0, charts_orphaned: 0, files: 0, byok: false },
            files_pending_remote_delete: 0,
            no_data: true,
          },
          { status: 200 },
        ),
      };
    }
    return { ok: true, userId: resolved.userId, authenticated: false };
  } catch (e) {
    console.error('[delete-my-data] resolveAnonActor failed:', e);
    return {
      ok: false,
      response: Response.json({ error: 'actor_unavailable' }, { status: 503 }),
    };
  }
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
    console.error('[delete-my-data] discovery query failed:', e);
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
    console.error('[delete-my-data] file_id snapshot failed:', e);
    return classifyDbError(e);
  }

  // --- Phase 2a: pre-cascade audit row -------------------------------------
  // Insert one durable audit row capturing the file_ids we're about to
  // promise to delete at Anthropic. The cascade DELETE-by-user_id can't
  // wipe it (we set user_id = NULL on this row; real user_id lives in
  // request_metadata), so even if the cascade itself fails we still have
  // an incident record we can return as `error_id`.
  const incidentId = crypto.randomUUID();
  if (userFileIds.length > 0) {
    try {
      await insertPendingAuditRow(sql, incidentId, userId, userFileIds);
    } catch (e) {
      console.error('[delete-my-data] audit-row insert failed; refusing to cascade:', e);
      return classifyDbError(e);
    }
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
  //      (audit row above has user_id = NULL, so it survives.)
  //   7. DELETE logging_preferences (auth only; anon table is keyed on sub).
  //   8. DELETE chart_files WHERE user_id = ? (orphan-chart sweep).
  //   9. DELETE chart_permissions WHERE user_id = ? (orphan-chart sweep).
  //
  // BYOK delete is a separate transaction (Phase 2c) so we can use RETURNING
  // to know whether a row actually existed.
  try {
    if (authenticated) {
      await sql.transaction([
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
        sql`DELETE FROM logging_preferences WHERE user_id = ${userId}`,
        sql`DELETE FROM chart_files WHERE user_id = ${userId}`,
        sql`DELETE FROM chart_permissions WHERE user_id = ${userId}`,
      ]);
    } else {
      // Anon path: userId here can be `anon-<uuid>` (no auth-link cookie) OR
      // an auth sub (resolveAnonActor returns the linked sub when
      // tocb_auth_link verifies). Post-logout calls still route here, not
      // to the auth branch, because resolveIdentity hard-codes
      // authenticated=false. That gates BYOK delete behind a fresh JWT,
      // mirroring byok-key.ts, so a stale auth-link cookie can never
      // trigger a BYOK wipe.
      await sql.transaction([
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
        sql`DELETE FROM chart_files WHERE user_id = ${userId}`,
        sql`DELETE FROM chart_permissions WHERE user_id = ${userId}`,
      ]);
    }
  } catch (e) {
    console.error('[delete-my-data] write transaction failed:', e);
    // Best-effort: transition the audit row to a failure incident so a
    // human can see what went wrong. If this also fails we still return
    // the same incident_id, so the user has something to quote.
    try {
      if (userFileIds.length > 0) {
        await recordCascadeFailure(sql, incidentId, userId, e);
      }
    } catch (auditErr) {
      console.error('[delete-my-data] audit-row failure transition also failed:', auditErr);
    }
    return classifyDbError(e, incidentId);
  }

  // --- Phase 2c: BYOK delete (auth only) -----------------------------------
  // Separate from the cascade transaction so we can RETURNING the row count
  // and know whether the user actually had a key. Zero-then-delete mirrors
  // byok-key.ts; bytea zeroization isn't a security primitive (WAL/replicas
  // may hold the old ciphertext) but it shrinks the in-flight surface.
  let byokDeleted = false;
  if (authenticated) {
    try {
      const result = (await sql.transaction([
        sql`UPDATE user_byok_keys SET encrypted_key = '\\x'::bytea WHERE user_id = ${userId}`,
        sql`DELETE FROM user_byok_keys WHERE user_id = ${userId} RETURNING user_id`,
      ])) as Array<Array<{ user_id: string }>>;
      // sql.transaction returns an array of statement results; the second
      // statement's RETURNING is what we want.
      const deletedRows = result[1] ?? [];
      byokDeleted = deletedRows.length > 0;
    } catch (e) {
      // Charts are already deleted at this point; failing to drop the BYOK
      // row would leave an orphan blob keyed under a user that no longer
      // owns anything, which is a privacy regression. Surface as an
      // incident so the operator can chase it manually.
      console.error('[delete-my-data] BYOK delete failed (post-cascade):', e);
      // Mirror the main cascade catch: transition the audit row to a failure
      // incident so the operator sees what went wrong instead of finding a
      // pending-files row dangling. Gated on userFileIds.length > 0 because
      // that's the only path that inserted the audit row in the first place
      // (recordCascadeFailure is UPDATE-only and would silently no-op
      // otherwise).
      try {
        if (userFileIds.length > 0) {
          await recordCascadeFailure(sql, incidentId, userId, e);
        }
      } catch (auditErr) {
        console.error('[delete-my-data] BYOK audit-row failure transition also failed:', auditErr);
      }
      return classifyDbError(e, incidentId);
    }
  }

  // --- Phase 3: Anthropic Files API fan-out --------------------------------
  // Audit row at incidentId is the durable record of what we promised to
  // delete. Fan-out runs after the response (ctx.waitUntil); on completion
  // it either DELETEs the audit row (all succeeded) or UPDATEs it with the
  // surviving failed file_ids (so a future scheduled-task replay picks them
  // up).
  //
  // Skip when ANTHROPIC_API_KEY is unset (test/local-dev) — local rows are
  // already gone so it's not a privacy regression for the CI/dev path. The
  // response shape distinguishes "fan-out scheduled" from "fan-out skipped"
  // via the `remote_delete_disabled` flag, so the UI can avoid claiming
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
          console.error('[delete-my-data] audit-row finalize failed:', auditErr);
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
        (e: unknown) =>
          console.error('[delete-my-data] audit-row cleanup (no-key path) failed:', e),
      ),
    );
  }

  // --- Phase 4: response with cookie clears --------------------------------
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const cookie of buildClearedCookieHeaders()) {
    headers.append('Set-Cookie', cookie);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      deleted: {
        charts_hard_deleted: soleOwnedIds.length,
        charts_orphaned: collabEditedIds.length,
        files: userFileIds.length,
        byok: byokDeleted,
      },
      // Number of file_ids whose Anthropic-side DELETE has not been
      // confirmed at the time of response. Zero when remote_delete_disabled
      // is true (no fan-out to wait on); otherwise a retry job will replay
      // failed entries off the audit row at error_id = incident_id.
      files_pending_remote_delete: remoteDeleteEnabled ? userFileIds.length : 0,
      // True when ANTHROPIC_API_KEY is unset (dev/test). The UI should NOT
      // claim "queued for remote deletion" in that case since no fan-out
      // happened.
      remote_delete_disabled: !remoteDeleteEnabled && userFileIds.length > 0,
    }),
    { status: 200, headers },
  );
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
