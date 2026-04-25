// DELETE /api/my-data — GDPR Art. 17 erasure for both authenticated and
// anonymous users. Triggered by the "Delete all my data" button in the
// settings panel.
//
// What this endpoint does (see CLAUDE.md C6 task brief for the full spec):
//
//   1. Resolve identity:
//        - JWT present  → authenticated user (sub from verifyToken)
//        - else         → anon actor from `tocb_actor_id` cookie
//          (resolveAnonActor)
//   2. Find sole-owned charts (no other-user activity in chart_permissions /
//      chart_files / logging_sessions) and delete them. Cascade rules:
//        - chart_files: ON DELETE CASCADE
//        - chart_permissions: ON DELETE CASCADE
//        - logging_sessions/messages/snapshots: chart_id ON DELETE SET NULL
//   3. Find collab-edited charts (anything that was NOT sole-owned) and
//      orphan them: UPDATE charts SET user_id = NULL.
//   4. Snapshot the user's chart_files file_ids before SQL DELETE so we can
//      fan out Anthropic Files API DELETEs via ctx.waitUntil (concurrency-6
//      pattern from chart-files.ts).
//   5. DELETE the user's logging rows directly (logging_messages,
//      logging_snapshots, logging_sessions, logging_errors,
//      logging_preferences). The session DELETE itself cascades to leftover
//      messages/snapshots; the explicit user-id DELETEs catch rows whose
//      session is owned by someone else (rare but possible).
//   6. DELETE chart_files / chart_permissions WHERE user_id = ? — the
//      previous steps' CASCADE only ran on sole-owned charts; user-uploaded
//      files and permissions on collab-edited charts also have to go.
//   7. (auth only) DELETE user_byok_keys row. Zero-then-delete inside a
//      transaction mirrors byok-key.ts so encrypted blob doesn't linger.
//   8. KEEP user_api_usage. Anti-abuse cap is processed under a separate
//      Art 6(1)(f) basis (LIA §1B) — explicitly carved out as no-opt-out.
//   9. Cookie hygiene:
//        - clear  tocb_anon       (Turnstile session)
//        - clear  tocb_auth_link  (auth-sub binding)
//        - KEEP   tocb_actor_id   (so the anon cap stays attached to the
//                                  same browser even after deletion)
//
// Cascade-order rationale: charts → user_byok_keys → cookie clears. The
// chart deletes happen first so the FK CASCADEs do most of the cleanup
// "for free"; the manual DELETEs after just sweep up rows attached to
// charts we orphaned (collab-edited path).

import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { resolveAnonActor } from '../_shared/anon-id';

// ---------------------------------------------------------------------------
// Cookie-clearing helpers (exported for unit tests).
// ---------------------------------------------------------------------------

/**
 * Cookies we erase as part of the data-delete flow. Matches the ones the
 * Worker mints itself (tocb_anon via verify-turnstile, tocb_auth_link via
 * anthropic-stream / resolveActor). NOT include: `tocb_actor_id` — see
 * COOKIES_TO_PRESERVE_ON_DATA_DELETE.
 */
export const COOKIES_TO_CLEAR_ON_DATA_DELETE = ['tocb_anon', 'tocb_auth_link'] as const;

/**
 * Cookies we deliberately leave alone. The anon-cap row in user_api_usage is
 * preserved under a separate Art 6(1)(f) basis (anti-abuse, no-opt-out per
 * LIA §1B) — clearing the cookie that keys into it would silently mint a
 * fresh cap for the same browser, defeating the carve-out.
 */
export const COOKIES_TO_PRESERVE_ON_DATA_DELETE = ['tocb_actor_id'] as const;

// Allow the safe character class only — names go straight into a
// Set-Cookie header, so a CR/LF or whitespace would let a caller forge
// extra headers. Match the validation used elsewhere for cookie values.
const SAFE_COOKIE_NAME_RE = /^[A-Za-z0-9_\-.]+$/;

// 1970-01-01 — well in the past for every clock skew the browser might
// have. UTC literal so we don't depend on the runtime's tz.
const EPOCH_GMT = 'Thu, 01 Jan 1970 00:00:00 GMT';

/**
 * Build a Set-Cookie header value that erases `name` from the browser.
 *
 * RFC 6265 §3.1: Setting a cookie with `Max-Age=0` (or an `Expires` in the
 * past) causes the user agent to delete the cookie. We send both because
 * some old browsers honour only one. Path/Secure/HttpOnly/SameSite mirror
 * the attributes of the live cookies so the browser's "matching cookie"
 * lookup actually finds and overwrites the right entry.
 */
export function buildExpiredCookieHeader(name: string): string {
  if (!SAFE_COOKIE_NAME_RE.test(name)) {
    throw new Error(`invalid cookie name: ${JSON.stringify(name)}`);
  }
  return `${name}=; Path=/; Max-Age=0; Expires=${EPOCH_GMT}; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * Set-Cookie header values for every cookie listed in
 * `COOKIES_TO_CLEAR_ON_DATA_DELETE`. Caller appends each one to the outbound
 * response.
 */
export function buildClearedCookieHeaders(): string[] {
  return COOKIES_TO_CLEAR_ON_DATA_DELETE.map(buildExpiredCookieHeader);
}

// ---------------------------------------------------------------------------
// Anthropic Files API DELETE fan-out.
// ---------------------------------------------------------------------------

const ANTHROPIC_DELETE_CONCURRENCY = 6;

async function fanOutAnthropicDeletes(apiKey: string, fileIds: readonly string[]): Promise<void> {
  const deleteOne = async (fid: string) => {
    try {
      const upstream = await fetch(
        `https://api.anthropic.com/v1/files/${encodeURIComponent(fid)}`,
        {
          method: 'DELETE',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'files-api-2025-04-14',
          },
        },
      );
      if (!upstream.ok && upstream.status !== 404) {
        const errText = await upstream.text().catch(() => '');
        console.error(
          `[delete-my-data] Anthropic DELETE ${upstream.status} for file_id=${fid}: ${errText}`,
        );
      }
    } catch (err) {
      console.error(`[delete-my-data] Anthropic DELETE fetch failed for file_id=${fid}:`, err);
    }
  };

  for (let i = 0; i < fileIds.length; i += ANTHROPIC_DELETE_CONCURRENCY) {
    const chunk = fileIds.slice(i, i + ANTHROPIC_DELETE_CONCURRENCY);
    await Promise.all(chunk.map(deleteOne));
  }
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
          { ok: true, deleted: { charts: 0, files: 0, byok: false }, no_data: true },
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
  // Find sole-owned charts (no other-user activity anywhere). We do this
  // outside the write transaction so we don't hold locks while reading.
  // Two charts → two queries is fine (the row counts are O(user's charts),
  // not O(global)).
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
      // user_id. We compute the set of "has-other-activity" ids in a single
      // round-trip via UNION, then split allOwnedIds into the two groups.
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
    return Response.json({ error: 'database_unavailable' }, { status: 503 });
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
    return Response.json({ error: 'database_unavailable' }, { status: 503 });
  }

  // --- Phase 2: write transaction ------------------------------------------
  // Order:
  //   1. DELETE sole-owned charts (cascades chart_files / chart_permissions;
  //      sets logging_*.chart_id NULL).
  //   2. UPDATE collab-edited charts to user_id = NULL.
  //   3. DELETE logging_messages WHERE user_id = ?
  //      (their `chart_id` is now NULL post-step-1; we DELETE by user_id so
  //      the row is gone, not just unlinked.)
  //   4. DELETE logging_snapshots tied to user's sessions.
  //   5. DELETE logging_sessions WHERE user_id = ? (cascades any leftover
  //      messages/snapshots).
  //   6. DELETE logging_errors WHERE user_id = ?
  //   7. DELETE logging_preferences WHERE user_id = ? (auth opt-out
  //      preference; for anon it's a no-op since the table is keyed by sub).
  //   8. DELETE chart_files WHERE user_id = ? (catches user-uploaded files
  //      on charts we ORPHANED, where step-1's CASCADE didn't fire).
  //   9. DELETE chart_permissions WHERE user_id = ? (same reason — the user
  //      may still have a permission row on a collab-edited chart we just
  //      orphaned).
  //  10. DELETE user_byok_keys (auth only); zero-then-delete to drop the
  //      encrypted blob.
  try {
    if (authenticated) {
      // The auth path includes user_byok_keys with a zero-then-delete pair
      // mirroring byok-key.ts. Postgres bytea zeroization isn't a security
      // primitive (the WAL/replicas may still hold the old ciphertext) but
      // it shrinks the surface during the same transaction.
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
        sql`UPDATE user_byok_keys SET encrypted_key = '\\x'::bytea WHERE user_id = ${userId}`,
        sql`DELETE FROM user_byok_keys WHERE user_id = ${userId}`,
      ]);
    } else {
      // Anon path: same as auth minus user_byok_keys (anon users can't store
      // BYOK; the table is keyed on auth0 sub) and minus logging_preferences
      // (also keyed on auth sub). Charts created by anon users have user_id
      // NULL by default, so soleOwnedIds is typically empty for anon. The
      // only way an anon user_id ends up on a chart is via a prior auth
      // session that's since logged out (tocb_auth_link → still resolves to
      // the auth sub). In that fall-through case the anon path here would
      // resolve to the auth sub via tocb_auth_link, and we'd take the auth
      // branch. So this branch usually only deletes logging rows + nothing
      // chart-side.
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
    return Response.json({ error: 'database_unavailable' }, { status: 503 });
  }

  // --- Phase 3: Anthropic Files API fan-out --------------------------------
  // Best-effort, non-blocking — orphan-cleanup sweeps catch stragglers if
  // any DELETE fails. Skip silently when ANTHROPIC_API_KEY is unset (test /
  // local-dev pre-config); the local DB rows are already gone so it's not a
  // privacy regression.
  if (env.ANTHROPIC_API_KEY && userFileIds.length > 0) {
    ctx.waitUntil(fanOutAnthropicDeletes(env.ANTHROPIC_API_KEY, userFileIds));
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
        byok: authenticated,
      },
    }),
    { status: 200, headers },
  );
}
