import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { tryMigrateUser } from '../_shared/auth';

export async function handler(request: Request, env: Env): Promise<Response> {

  try {
    const url = new URL(request.url);
    const userId = url.searchParams.get('userId');

    if (!userId) {
      return Response.json({ error: 'User ID is required' }, { status: 400 });
    }

    const sql = getDb(env);

    // Migrate user data if they logged in with a new Auth0 tenant
    await tryMigrateUser(sql, request.headers.get('authorization'), 'getUserCharts', env);

    const result = await sql`
      SELECT DISTINCT
        c.id as chart_id,
        c.chart_title,
        c.edit_token,
        c.updated_at,
        c.created_at,
        COALESCE(cp.permission_level, 'owner') as permission_level
      FROM charts c
      LEFT JOIN chart_permissions cp ON c.id = cp.chart_id AND cp.user_id = ${userId}
      WHERE cp.user_id = ${userId} OR c.user_id = ${userId}
      ORDER BY c.updated_at DESC
    `;

    const siteUrl = env.SITE_URL || new URL(request.url).origin;
    const charts = result.map((row: any) => ({
      chartId: row.chart_id,
      title: row.chart_title || 'Theory of Change',
      editUrl: `${siteUrl}/edit/${row.edit_token}`,
      viewUrl: `${siteUrl}/chart/${row.chart_id}`,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      permissionLevel: row.permission_level
    }));

    return Response.json({ charts });
  } catch (error) {
    console.error('Error fetching user charts:', error);
    return Response.json({ error: 'Failed to fetch user charts' }, { status: 500 });
  }
};
