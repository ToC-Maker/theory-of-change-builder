import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken } from '../_shared/auth';

interface ReportErrorRequest {
  error_id: string;
  error_name: string;
  error_message: string;
  http_status?: number;
  stack_trace?: string;
  user_agent: string;
  chart_id?: string;
  session_id?: string;
  request_metadata?: Record<string, unknown>;
}

export async function handler(request: Request, env: Env): Promise<Response> {
  // Reject oversized payloads
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 50_000) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  let data: ReportErrorRequest;
  try {
    data = JSON.parse(text) as ReportErrorRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    if (!data.error_id || !data.error_name || !data.error_message) {
      return Response.json(
        { error: 'Missing required fields: error_id, error_name, error_message' },
        { status: 400 }
      );
    }

    // Server-side field truncation (defense-in-depth)
    data.error_name = data.error_name.slice(0, 200);
    data.error_message = data.error_message.slice(0, 8192);
    if (data.stack_trace) data.stack_trace = data.stack_trace.slice(0, 4096);

    // Extract user_id from auth token (optional, don't reject anonymous)
    const token = extractToken(request.headers.get('authorization'));
    let user_id = null;

    if (token) {
      try {
        const decoded = await verifyToken(token, env);
        user_id = decoded.sub;
      } catch (err) {
        // Unlike logging-saveMessage, don't reject on bad token — error reports
        // are too valuable to lose, and auth failure may itself be the error.
        console.error('[logging-reportError] Token verification failed:', err);
      }
    }

    const sql = getDb(env);

    // No opt-out check: error reports are operational diagnostics, not AI
    // improvement data. They don't contain message content.

    const result = await sql`
      INSERT INTO logging_errors (
        error_id, error_name, error_message, http_status, stack_trace,
        user_agent, user_id, chart_id, session_id, request_metadata
      )
      VALUES (
        ${data.error_id}, ${data.error_name}, ${data.error_message},
        ${data.http_status ?? null}, ${data.stack_trace ?? null},
        ${data.user_agent ?? null}, ${user_id},
        ${data.chart_id ?? null}, ${data.session_id ?? null},
        ${data.request_metadata ? JSON.stringify(data.request_metadata) : null}
      )
      ON CONFLICT (error_id) DO NOTHING
      RETURNING error_id
    `;

    return Response.json(result[0] || { message: 'Error already reported' });
  } catch (error) {
    console.error('Error saving error report:', error);
    return Response.json({ error: 'Failed to save error report' }, { status: 500 });
  }
};
