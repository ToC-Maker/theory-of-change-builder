import type { Env } from '../_shared/types';
import type { PollChartRequest, PollChartResponse } from '../../shared/chart-wire';
import { isChartVersion } from '../../shared/chart-wire';
import { getDb } from '../_shared/db';
import { authorizeChartEdit } from '../_shared/chart-edit-access';

// The check an open editor makes every few seconds: the chart's current
// version, plus the chart itself only when that differs from the version the
// caller already has. Read-only, which is why it does not reuse getChart: that
// path inserts permission rows and migrates users as side effects. The edit
// token travels in the body, not the URL, so it stays out of the request logs.
export async function handler(request: Request, env: Env): Promise<Response> {
  let body: Partial<PollChartRequest>;
  try {
    body = (await request.json()) as Partial<PollChartRequest>;
  } catch {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  try {
    const { editToken, knownVersion } = body;

    if (!editToken || !isChartVersion(knownVersion)) {
      return Response.json(
        { error: 'Edit token and a positive integer knownVersion are required' },
        { status: 400 },
      );
    }

    const sql = getDb(env);
    const access = await authorizeChartEdit(request, env, sql, editToken);
    if (!access.ok) return access.response;

    // chart_data is only read out of the row when the version differs, so a
    // quiet poll moves a few bytes instead of the whole chart.
    const rows = (await sql`
      SELECT version, CASE WHEN version <> ${knownVersion} THEN chart_data END AS chart_data
      FROM charts WHERE edit_token = ${editToken}
    `) as { version: number; chart_data: unknown }[];

    if (rows.length === 0) {
      return Response.json({ error: 'Chart not found or invalid edit token' }, { status: 404 });
    }

    const { version, chart_data } = rows[0];
    const response: PollChartResponse =
      version === knownVersion ? { version } : { version, chartData: chart_data };
    return Response.json(response);
  } catch (error) {
    console.error('Error polling chart:', error);
    return Response.json({ error: 'Failed to poll chart' }, { status: 500 });
  }
}
