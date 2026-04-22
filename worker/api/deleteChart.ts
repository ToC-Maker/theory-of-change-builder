import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';

export async function handler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: { chartId?: string };
  try {
    body = await request.json() as { chartId?: string };
  } catch {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  try {
    const { chartId } = body;

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

    // Authorization: owned charts require JWT + owner permission; anonymous
    // charts (user_id NULL) are deletable by anyone reaching this endpoint
    // (mirrors the original contract — the edit token is the gate on those).
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
    }

    // Cascade: collect file_ids and fire Anthropic DELETEs via ctx.waitUntil.
    // FK ON DELETE CASCADE handles chart_files row cleanup.
    const fileRows = await sql`SELECT file_id FROM chart_files WHERE chart_id = ${chartId}`;
    for (const row of fileRows) {
      ctx.waitUntil(
        fetch(`https://api.anthropic.com/v1/files/${row.file_id}`, {
          method: 'DELETE',
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'files-api-2025-04-14',
          },
        }).then(async (r) => {
          if (!r.ok && r.status !== 404) {
            console.error(`[deleteChart] Anthropic file DELETE failed ${r.status}:`, await r.text().catch(() => ''));
          }
        }).catch((e) => console.error('[deleteChart] file DELETE fetch error', e)),
      );
    }

    const result = await sql`
      DELETE FROM charts WHERE id = ${chartId} RETURNING id
    `;

    if (!result.length) {
      return Response.json({ error: 'Chart not found' }, { status: 404 });
    }

    return Response.json({ success: true, message: 'Chart deleted successfully' });
  } catch (error) {
    console.error('Error deleting chart:', error);
    return Response.json({ error: 'Failed to delete chart' }, { status: 500 });
  }
};
