import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken } from '../_shared/auth';

export async function handler(request: Request, env: Env): Promise<Response> {
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

    // Anonymous chart — allow deletion without auth
    if (!chartOwnerId) {
      await sql`DELETE FROM charts WHERE id = ${chartId}`;
      return Response.json({ success: true, message: 'Chart deleted successfully' });
    }

    // Owned chart — verify authentication
    const token = extractToken(request.headers.get('authorization'));
    if (!token) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let decodedToken;
    try {
      decodedToken = await verifyToken(token, env);
    } catch (err) {
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
