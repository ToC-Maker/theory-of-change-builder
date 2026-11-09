import type { Env } from '../_shared/types';
import type {
  UpdateChartConflict,
  UpdateChartOk,
  UpdateChartRequest,
} from '../../shared/chart-wire';
import { isChartVersion } from '../../shared/chart-wire';
import { getDb } from '../_shared/db';
import { extractToken, verifyToken } from '../_shared/auth';
import { authorizeChartEdit } from '../_shared/chart-edit-access';

export async function handler(request: Request, env: Env): Promise<Response> {
  // chartData is round-tripped to JSONB — we don't field-validate it here.
  let body: Partial<UpdateChartRequest>;
  try {
    body = (await request.json()) as Partial<UpdateChartRequest>;
  } catch {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  try {
    const { editToken, chartData, baseVersion } = body;

    if (!editToken || !chartData) {
      return Response.json({ error: 'Edit token and chart data are required' }, { status: 400 });
    }
    if (baseVersion !== undefined && !isChartVersion(baseVersion)) {
      return Response.json({ error: 'baseVersion must be a positive integer' }, { status: 400 });
    }

    const sql = getDb(env);
    const chartTitle =
      chartData &&
      typeof chartData === 'object' &&
      typeof (chartData as { title?: unknown }).title === 'string'
        ? (chartData as { title: string }).title
        : 'Theory of Change';

    const access = await authorizeChartEdit(request, env, sql, editToken);
    if (!access.ok) return access.response;
    const chartId = access.chart.id;

    // The version trigger advances `version` when chart_data changes (an
    // identical resave leaves it as is), so both branches return the version
    // the row has after their write.
    let saved: { version: number }[];
    if (baseVersion === undefined) {
      // A tab still running the previous client: it never sends a version, so
      // its save is applied as before (last save wins). A write that changes
      // the chart still advances the version, so up-to-date tabs merge around it.
      saved = (await sql`
        UPDATE charts
        SET chart_data = ${JSON.stringify(chartData)},
            chart_title = ${chartTitle},
            updated_at = NOW()
        WHERE edit_token = ${editToken}
        RETURNING version
      `) as { version: number }[];
      if (saved.length > 0) {
        console.log(JSON.stringify({ event: 'updateChart.legacy', chartId }));
      }
    } else {
      // Compare-and-swap: a single UPDATE is atomic, so of two different saves
      // on the same base only the first matches the version; the second, now
      // behind, gets no row.
      saved = (await sql`
        UPDATE charts
        SET chart_data = ${JSON.stringify(chartData)},
            chart_title = ${chartTitle},
            updated_at = NOW()
        WHERE edit_token = ${editToken} AND version = ${baseVersion}
        RETURNING version
      `) as { version: number }[];
    }

    if (saved.length === 0) {
      const current = (await sql`
        SELECT version, chart_data FROM charts WHERE edit_token = ${editToken}
      `) as { version: number; chart_data: unknown }[];
      if (current.length === 0) {
        return Response.json({ error: 'Chart not found or invalid edit token' }, { status: 404 });
      }
      console.log(
        JSON.stringify({
          event: 'updateChart.conflict',
          chartId,
          baseVersion,
          currentVersion: current[0].version,
        }),
      );
      const conflict: UpdateChartConflict = {
        error: 'conflict',
        version: current[0].version,
        chartData: current[0].chart_data,
      };
      return Response.json(conflict, { status: 409 });
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

    const ok: UpdateChartOk = { success: true, version: saved[0].version };
    return Response.json(ok);
  } catch (error) {
    console.error('Error updating chart:', error);
    return Response.json({ error: 'Failed to update chart' }, { status: 500 });
  }
}
