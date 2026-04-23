import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { extractToken, verifyToken } from '../_shared/auth';

export async function handler(request: Request, env: Env): Promise<Response> {
  let body: { editToken?: string; chartData?: any };
  try {
    body = await request.json() as { editToken?: string; chartData?: any };
  } catch {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  try {
    const { editToken, chartData } = body;

    if (!editToken || !chartData) {
      return Response.json({ error: 'Edit token and chart data are required' }, { status: 400 });
    }

    const sql = getDb(env);
    const chartTitle = chartData.title || 'Theory of Change';

    const result = await sql`
      UPDATE charts
      SET chart_data = ${JSON.stringify(chartData)},
          chart_title = ${chartTitle},
          updated_at = NOW()
      WHERE edit_token = ${editToken}
      RETURNING id
    ` as { id: string }[];

    if (!result || result.length === 0) {
      return Response.json({ error: 'Chart not found or invalid edit token' }, { status: 404 });
    }

    // Track an authenticated editor in chart_permissions so the chart shows
    // up in their "My Charts" list on next load. Scope is intentionally
    // narrow: only on successful edit (not view), and only when the caller
    // presents a valid JWT — so opening the edit URL while signed out is
    // NOT enough to leave a record. Anon editors leave no trace. Owner
    // rows exist from createChart, and 'pending' rows from the approval
    // workflow are preserved (ON CONFLICT DO NOTHING) so this doesn't
    // short-circuit the access-request flow.
    const token = extractToken(request.headers.get('authorization'));
    if (token) {
      try {
        const decoded = await verifyToken(token, env);
        const chartId = result[0].id;
        const email = decoded.email || decoded.name || null;
        await sql`
          INSERT INTO chart_permissions
            (chart_id, user_id, user_email, permission_level, status, granted_by)
          VALUES
            (${chartId}, ${decoded.sub}, ${email}, 'edit', 'approved', ${null})
          ON CONFLICT (chart_id, user_id) DO NOTHING
        `;
      } catch (err) {
        // Invalid/expired JWT: skip tracking but still honour the edit.
        // Matches createChart.ts's posture — edit_token is the gate, auth
        // is additive for attribution.
        console.warn('[updateChart] JWT verify failed; skipping permission upsert:', err);
      }
    }

    return Response.json({ success: true, message: 'Chart updated successfully' });
  } catch (error) {
    console.error('Error updating chart:', error);
    return Response.json({ error: 'Failed to update chart' }, { status: 500 });
  }
};
