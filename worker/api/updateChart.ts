import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';

export async function handler(request: Request, env: Env): Promise<Response> {

  try {
    const { editToken, chartData } = await request.json() as { editToken?: string; chartData?: any };

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
    `;

    if (!result || result.length === 0) {
      return Response.json({ error: 'Chart not found or invalid edit token' }, { status: 404 });
    }

    return Response.json({ success: true, message: 'Chart updated successfully' });
  } catch (error) {
    console.error('Error updating chart:', error);
    return Response.json({ error: 'Failed to update chart' }, { status: 500 });
  }
};
