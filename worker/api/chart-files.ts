import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';

// Dual handler wired from worker/index.ts:
//   GET /api/files/:file_id       -> HEAD check for client rehydration
//   DELETE /api/chart-files?chart_id=X  -> bulk delete for Clear Chat
//
// The router dispatches by url.pathname + method; we split on the same axis
// here. Single-file deletion is handled inline (see deleteChart cascade).

function extractFileIdFromFilesPath(pathname: string): string | null {
  const prefix = '/api/files/';
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest || rest.includes('/')) return null;
  return decodeURIComponent(rest);
}

async function requireAuthorizedUser(
  request: Request,
  env: Env
): Promise<{ userId: string } | Response> {
  const token = extractToken(request.headers.get('authorization'));
  if (!token) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  try {
    const decoded = await verifyToken(token, env);
    return { userId: decoded.sub };
  } catch (err) {
    if (err instanceof JWKSFetchError) {
      return Response.json({ error: 'auth_unavailable' }, { status: 502 });
    }
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
}

async function hasChartAccess(
  sql: ReturnType<typeof getDb>,
  chartId: string,
  userId: string
): Promise<boolean> {
  // Owners always pass; edit-permission users with status=approved also pass.
  const rows = await sql`
    SELECT permission_level, status FROM chart_permissions
    WHERE chart_id = ${chartId} AND user_id = ${userId}
  `;
  if (!rows.length) return false;
  const { permission_level, status } = rows[0];
  return permission_level === 'owner'
    || (permission_level === 'edit' && status === 'approved');
}

// GET /api/files/:file_id — exists-check for client rehydration.
// Returns {exists: true} / 200 if the file is in our registry AND the caller
// has access to its chart. Returns {exists: false} / 404 otherwise.
//
// We deliberately do NOT call Anthropic here — a HEAD on every chat reload
// would be chatty and latency-sensitive. Our chart_files row is authoritative
// enough: if it exists, Anthropic still has the file (barring admin cleanup
// that also dropped the row). If Anthropic later reports not_found mid-stream,
// the anthropic-stream handler synthesizes a file_unavailable error.
async function handleGetFile(
  request: Request,
  env: Env,
  fileId: string
): Promise<Response> {
  const authResult = await requireAuthorizedUser(request, env);
  if (authResult instanceof Response) return authResult;
  const { userId } = authResult;

  const sql = getDb(env);
  const rows = await sql`
    SELECT chart_id FROM chart_files WHERE file_id = ${fileId}
  `;
  if (!rows.length) {
    return Response.json({ exists: false }, { status: 404 });
  }

  const chartId = rows[0].chart_id;

  // If the chart has no owner, anon-edit is allowed and we gate on the row
  // being present. Otherwise enforce chart_permissions.
  const chartRow = await sql`
    SELECT user_id FROM charts WHERE id = ${chartId}
  `;
  if (!chartRow.length) {
    return Response.json({ exists: false }, { status: 404 });
  }
  if (chartRow[0].user_id !== null) {
    const hasAccess = await hasChartAccess(sql, chartId, userId);
    if (!hasAccess) {
      return Response.json({ exists: false }, { status: 404 });
    }
  }

  return Response.json({ exists: true });
}

// DELETE /api/chart-files?chart_id=X — bulk delete all files for a chart.
// Triggered by the Clear Chat button. Deletes at Anthropic via waitUntil
// (best-effort, non-blocking on the response), then drops the DB rows.
async function handleBulkDelete(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const chartId = url.searchParams.get('chart_id');
  if (!chartId) {
    return Response.json({ error: 'missing_chart_id' }, { status: 400 });
  }

  const sql = getDb(env);

  // Ownership: anon charts can be cleared without auth (same posture as
  // deleteChart anon branch). Owned charts require a permission row.
  const chartRow = await sql`
    SELECT user_id FROM charts WHERE id = ${chartId}
  `;
  if (!chartRow.length) {
    return Response.json({ error: 'not_found' }, { status: 404 });
  }
  const chartOwnerId = chartRow[0].user_id;

  if (chartOwnerId) {
    const authResult = await requireAuthorizedUser(request, env);
    if (authResult instanceof Response) return authResult;
    const { userId } = authResult;
    const hasAccess = await hasChartAccess(sql, chartId, userId);
    if (!hasAccess) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
  }

  // Snapshot the file_ids before delete so we can dispatch the Anthropic
  // cleanup in parallel via waitUntil.
  const fileRows = await sql`
    SELECT file_id FROM chart_files WHERE chart_id = ${chartId}
  `;
  const fileIds: string[] = fileRows.map((r) => r.file_id as string);

  const apiKey = env.ANTHROPIC_API_KEY;
  if (apiKey && fileIds.length > 0) {
    // Fire-and-forget Anthropic DELETEs. A 404 at Anthropic is fine (file
    // already gone); non-2xx/non-404 just gets logged. We don't rollback the
    // DB delete on upstream failures — orphan-cleanup sweeps catch stragglers.
    ctx.waitUntil(Promise.all(fileIds.map(async (fid) => {
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
          }
        );
        if (!upstream.ok && upstream.status !== 404) {
          const errText = await upstream.text().catch(() => '');
          console.error(
            `[chart-files] Anthropic DELETE ${upstream.status} for file_id=${fid}: ${errText}`
          );
        }
      } catch (err) {
        console.error(`[chart-files] Anthropic DELETE fetch failed for file_id=${fid}:`, err);
      }
    })));
  }

  // Delete DB rows and return a count. RETURNING-based count avoids a racy
  // second query.
  const deleted = await sql`
    DELETE FROM chart_files WHERE chart_id = ${chartId} RETURNING file_id
  `;

  return Response.json({ deleted_count: deleted.length });
}

export async function handler(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // GET /api/files/:file_id
  if (request.method === 'GET' && url.pathname.startsWith('/api/files/')) {
    const fileId = extractFileIdFromFilesPath(url.pathname);
    if (!fileId) {
      return Response.json({ error: 'invalid_file_id' }, { status: 400 });
    }
    try {
      return await handleGetFile(request, env, fileId);
    } catch (err) {
      console.error('[chart-files] Unexpected error in GET /api/files/:id:', err);
      return Response.json({ error: 'internal_error' }, { status: 500 });
    }
  }

  // DELETE /api/chart-files
  if (request.method === 'DELETE' && url.pathname === '/api/chart-files') {
    try {
      return await handleBulkDelete(request, env, ctx);
    } catch (err) {
      console.error('[chart-files] Unexpected error in DELETE /api/chart-files:', err);
      return Response.json({ error: 'internal_error' }, { status: 500 });
    }
  }

  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}
