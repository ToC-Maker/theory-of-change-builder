import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';

export async function handler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: { chartId?: string; editToken?: string };
  try {
    body = (await request.json()) as { chartId?: string; editToken?: string };
  } catch {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  try {
    const { chartId, editToken } = body;

    if (!chartId) {
      return Response.json({ error: 'Chart ID is required' }, { status: 400 });
    }

    const sql = getDb(env);

    const chartInfo = await sql`
      SELECT user_id FROM charts WHERE id = ${chartId}
    `;

    if (!chartInfo.length) {
      return Response.json({ error: 'Chart not found' }, { status: 404 });
    }

    const chartOwnerId = chartInfo[0].user_id;

    // Authorization:
    // - Owned charts: require JWT + owner permission row.
    // - Anonymous charts (user_id NULL): require the editToken in the body.
    //   Previously any caller who knew the 6-byte chartId could delete an
    //   anon chart; now the caller must also know the 36-char edit token
    //   (the same gate used for updateChart). We still include the editToken
    //   in the DELETE's WHERE clause so a stale / wrong token yields a 401
    //   instead of deleting the row.
    let deleteByEditToken: string | null = null;
    if (chartOwnerId) {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }

      let decodedToken;
      try {
        decodedToken = await verifyToken(token, env);
      } catch (err) {
        if (err instanceof JWKSFetchError) {
          return Response.json({ error: 'Authentication service unavailable' }, { status: 502 });
        }
        return Response.json({ error: 'Invalid or expired token' }, { status: 401 });
      }

      const userId = decodedToken.sub;

      const ownerCheck = await sql`
        SELECT permission_level FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${userId}
      `;

      if (!ownerCheck.length || ownerCheck[0].permission_level !== 'owner') {
        return Response.json({ error: 'Only the owner can delete this chart' }, { status: 403 });
      }
    } else {
      if (!editToken || typeof editToken !== 'string') {
        return Response.json({ error: 'Edit token required' }, { status: 401 });
      }
      deleteByEditToken = editToken;
    }

    // Cascade: collect file_ids and fire Anthropic DELETEs via ctx.waitUntil.
    // FK ON DELETE CASCADE handles chart_files row cleanup.
    const fileRows = await sql`SELECT file_id FROM chart_files WHERE chart_id = ${chartId}`;

    // For anon charts the DELETE must match both id and edit_token so a wrong
    // token yields a 401 (no-op) rather than wiping the row.
    const result =
      deleteByEditToken !== null
        ? await sql`
          DELETE FROM charts
          WHERE id = ${chartId} AND edit_token = ${deleteByEditToken}
          RETURNING id
        `
        : await sql`
          DELETE FROM charts WHERE id = ${chartId} RETURNING id
        `;

    if (!result.length) {
      // If deletion failed on the anon branch, it's because the edit token
      // didn't match — treat as auth failure, not 404, to avoid leaking the
      // existence of the chart to random callers.
      if (deleteByEditToken !== null) {
        return Response.json({ error: 'Invalid edit token' }, { status: 401 });
      }
      return Response.json({ error: 'Chart not found' }, { status: 404 });
    }

    // Only schedule Anthropic cleanup after the row delete succeeded, so a
    // failed-auth call doesn't also hit Anthropic for a chart we didn't own.
    for (const row of fileRows) {
      ctx.waitUntil(
        fetch(`https://api.anthropic.com/v1/files/${row.file_id}`, {
          method: 'DELETE',
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'files-api-2025-04-14',
          },
        })
          .then(async (r) => {
            if (!r.ok && r.status !== 404) {
              console.error(
                `[deleteChart] Anthropic file DELETE failed ${r.status}:`,
                await r.text().catch(() => ''),
              );
            }
          })
          .catch((e) => console.error('[deleteChart] file DELETE fetch error', e)),
      );
    }

    return Response.json({ success: true, message: 'Chart deleted successfully' });
  } catch (error) {
    console.error('Error deleting chart:', error);
    return Response.json({ error: 'Failed to delete chart' }, { status: 500 });
  }
}
