import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, tryMigrateUser } from '../_shared/auth';

function randomBase64Url(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function handler(request: Request, env: Env): Promise<Response> {
  // chartData is stored as JSONB and forwarded to the client verbatim —
  // no field-level checks here, so unknown keeps the shape honest.
  let body: { chartData?: unknown };
  try {
    body = await request.json() as { chartData?: unknown };
  } catch {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  try {
    const { chartData } = body;

    if (!chartData) {
      return Response.json({ error: 'Chart data is required' }, { status: 400 });
    }

    const chartId = randomBase64Url(6);
    const editToken = randomBase64Url(24);
    const sql = getDb(env);

    // Migrate user data if they logged in with a new Auth0 tenant
    const authHeader = request.headers.get('authorization');
    await tryMigrateUser(sql, authHeader, 'createChart', env);

    const chartTitle =
      (chartData && typeof chartData === 'object' && typeof (chartData as { title?: unknown }).title === 'string')
        ? (chartData as { title: string }).title
        : 'Theory of Change';
    let userId = null;
    let userEmail = null;
    const token = extractToken(authHeader);

    if (token) {
      try {
        const decodedToken = await verifyToken(token, env);
        userId = decodedToken.sub;
        userEmail = decodedToken.email || decodedToken.name;
      } catch (err) {
        console.error('[createChart] Token verification failed:', err);
      }
    }

    await sql`
      INSERT INTO charts (id, edit_token, chart_data, user_id, chart_title)
      VALUES (${chartId}, ${editToken}, ${JSON.stringify(chartData)}, ${userId}, ${chartTitle})
    `;

    if (userId && userEmail) {
      await sql`
        INSERT INTO chart_permissions (chart_id, user_id, user_email, permission_level, granted_by)
        VALUES (${chartId}, ${userId}, ${userEmail}, 'owner', ${userId})
      `;
    }

    const siteUrl = env.SITE_URL || new URL(request.url).origin;
    return Response.json({
      chartId,
      editToken,
      viewUrl: `${siteUrl}/chart/${chartId}`,
      editUrl: `${siteUrl}/edit/${editToken}`,
      message: 'Chart created successfully'
    });
  } catch (error) {
    console.error('Error creating chart:', error);
    return Response.json({ error: 'Failed to create chart' }, { status: 500 });
  }
};
