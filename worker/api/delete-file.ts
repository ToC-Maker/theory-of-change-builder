import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';

// Extract the file_id path segment from /api/files/<file_id>.
// Returns null if the path doesn't match the expected shape.
function extractFileId(pathname: string): string | null {
  const prefix = '/api/files/';
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  // Disallow nested paths — only a single segment after the prefix.
  if (!rest || rest.includes('/')) return null;
  return decodeURIComponent(rest);
}

// DELETE /api/files/:file_id — remove a single uploaded file.
//
// Originally removed in fdaa186 as dead code (no client-side callers of a
// per-file DELETE; cleanup went through the Clear-Chat bulk path and chart
// delete cascade). Re-added because orphan uploads piled up: if a user
// uploads a PDF, then removes the chip before sending or just abandons the
// tab, the chart_files row + Anthropic file both lingered indefinitely.
// handleChatFileRemove now calls this so "remove the chip" actually frees
// the file everywhere.
//
// Authorization matches deleteChart:
// - Anonymous chart (charts.user_id IS NULL) -> require the editToken in the
//   X-Edit-Token header or `edit_token` query param (mirrors deleteChart's
//   anon branch hardening). file_id has higher entropy than chart_id and
//   isn't in public URLs, but we still gate it to match the rest of the
//   write surface.
// - Owned chart -> require a valid JWT whose sub has an approved owner/edit
//   row in chart_permissions for the associated chart_id.
export async function handler(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const fileId = extractFileId(url.pathname);
  if (!fileId) {
    return Response.json({ error: 'invalid_file_id' }, { status: 400 });
  }

  try {
    const sql = getDb(env);

    // Lookup which chart this file belongs to before checking ownership.
    const fileRow = await sql`
      SELECT chart_id FROM chart_files WHERE file_id = ${fileId}
    `;
    if (!fileRow.length) {
      // Unknown file id. Treat as success (already-gone semantics), but with
      // 404 so the client can distinguish — frontend uses this for rehydration.
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    const chartId = fileRow[0].chart_id;

    // Figure out whether the chart has an owner and gate accordingly. Anon
    // charts accept the editToken (header or query param); owned charts
    // require a JWT with an approved permission row.
    const chartRow = await sql`
      SELECT user_id FROM charts WHERE id = ${chartId}
    `;
    if (!chartRow.length) {
      // File row orphan — clean it up. FK cascade should prevent this.
      await sql`DELETE FROM chart_files WHERE file_id = ${fileId}`;
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    const chartOwnerId = chartRow[0].user_id;

    let authorized = false;
    if (!chartOwnerId) {
      // Anon chart: require the editToken matching this chart_id.
      const suppliedToken =
        request.headers.get('x-edit-token') ?? url.searchParams.get('edit_token');
      if (!suppliedToken) {
        return Response.json({ error: 'Edit token required' }, { status: 401 });
      }
      const tokRows = await sql`
        SELECT 1 FROM charts WHERE id = ${chartId} AND edit_token = ${suppliedToken}
      `;
      if (!tokRows.length) {
        return Response.json({ error: 'Edit token required' }, { status: 401 });
      }
      authorized = true;
    } else {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      let decodedToken;
      try {
        decodedToken = await verifyToken(token, env);
      } catch (err) {
        if (err instanceof JWKSFetchError) {
          return Response.json({ error: 'auth_unavailable' }, { status: 502 });
        }
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }

      const userId = decodedToken.sub;
      const permCheck = await sql`
        SELECT permission_level, status FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${userId}
      `;
      // Owner is enough; also accept edit-permission users with status=approved
      // since they can otherwise edit the chart and by extension the chat.
      if (permCheck.length) {
        const { permission_level, status } = permCheck[0];
        if (
          permission_level === 'owner' ||
          (permission_level === 'edit' && status === 'approved')
        ) {
          authorized = true;
        }
      }
    }

    if (!authorized) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }

    // Fire the Anthropic DELETE. A 404 here is fine — the file may already be
    // gone (manual admin cleanup, prior Clear Chat). We deliberately await
    // this: if it fails unexpectedly we keep the DB row so a retry can clean
    // both sides. Doing waitUntil on single-file delete would open a window
    // where the DB thinks the file is gone but Anthropic still has it.
    const apiKey = env.ANTHROPIC_API_KEY;
    if (apiKey) {
      try {
        const upstream = await fetch(
          `https://api.anthropic.com/v1/files/${encodeURIComponent(fileId)}`,
          {
            method: 'DELETE',
            headers: {
              'x-api-key': apiKey,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'files-api-2025-04-14',
            },
          },
        );
        // Accept 2xx and 404 (already gone); log anything else but don't fail
        // the client — the row delete below is still the right action.
        if (!upstream.ok && upstream.status !== 404) {
          const errText = await upstream.text().catch(() => '');
          console.error(
            `[delete-file] Anthropic DELETE returned ${upstream.status} for file_id=${fileId}: ${errText}`,
          );
        }
      } catch (err) {
        console.error(`[delete-file] Anthropic DELETE fetch failed for file_id=${fileId}:`, err);
      }
    }

    await sql`DELETE FROM chart_files WHERE file_id = ${fileId}`;

    return Response.json({ deleted: true });
  } catch (err) {
    console.error('[delete-file] Unexpected error:', err);
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
