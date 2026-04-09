import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken } from '../_shared/auth';
import { isUserOptedOut } from '../_shared/logging-optout';

interface SaveSnapshotRequest {
  session_id: string;
  chart_id: string;
  graph_data: any;
  edit_type: 'ai_edit' | 'manual_edit' | 'undo' | 'redo' | 'initial';
  triggered_by_message_id?: string | null;
  edit_instructions?: any[] | null;
  edit_success?: boolean;
  error_message?: string | null;
}

export async function handler(request: Request, env: Env): Promise<Response> {

  // Reject oversized payloads (graph_data max 1MB + overhead)
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 1_500_000) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  let data: SaveSnapshotRequest;
  try {
    data = JSON.parse(text) as SaveSnapshotRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    if (!data.session_id || !data.chart_id || !data.graph_data || !data.edit_type) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const validEditTypes = ['ai_edit', 'manual_edit', 'undo', 'redo', 'initial'];
    if (!validEditTypes.includes(data.edit_type)) {
      return Response.json({ error: 'Invalid edit_type' }, { status: 400 });
    }

    const encoder = new TextEncoder();
    if (encoder.encode(JSON.stringify(data.graph_data)).length > 1_000_000) {
      return Response.json({ error: 'graph_data exceeds 1MB limit' }, { status: 413 });
    }

    if (data.edit_instructions) {
      if (encoder.encode(JSON.stringify(data.edit_instructions)).length > 100_000) {
        return Response.json({ error: 'edit_instructions exceeds 100KB limit' }, { status: 413 });
      }
    }

    if (data.error_message && encoder.encode(data.error_message).length > 10_000) {
      return Response.json({ error: 'error_message exceeds 10KB limit' }, { status: 413 });
    }

    const token = extractToken(request.headers.get('authorization'));
    let user_id = null;
    let is_authenticated = false;

    if (token) {
      try {
        const decoded = await verifyToken(token, env);
        user_id = decoded.sub;
        is_authenticated = true;
      } catch (err) {
        console.error('[logging-saveSnapshot] Token verification failed:', err);
        return Response.json({ error: 'Token verification failed' }, { status: 401 });
      }
    }

    const sql = getDb(env);

    if (await isUserOptedOut(sql, user_id)) {
      return Response.json({ opted_out: true });
    }

    const result = await sql`
      WITH lock AS (
        SELECT pg_advisory_xact_lock(hashtext(${data.session_id}))
      ),
      next_seq AS (
        SELECT COALESCE(MAX(sequence_number), 0) + 1 as seq
        FROM logging_snapshots, lock
        WHERE session_id = ${data.session_id}
      )
      INSERT INTO logging_snapshots (
        session_id, sequence_number, chart_id, graph_data,
        edit_type, triggered_by_message_id, edit_instructions,
        edit_success, error_message, user_id,
        is_authenticated
      )
      SELECT
        ${data.session_id}, seq, ${data.chart_id}, ${JSON.stringify(data.graph_data)}::jsonb,
        ${data.edit_type}, ${data.triggered_by_message_id || null},
        ${data.edit_instructions ? JSON.stringify(data.edit_instructions) : null}::jsonb,
        ${data.edit_success !== false}, ${data.error_message || null},
        ${user_id}, ${is_authenticated}
      FROM next_seq
      RETURNING id, sequence_number
    `;

    return Response.json(result[0]);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error saving snapshot:', errorMessage);
    if (error instanceof Error && error.stack) {
      console.error('Stack:', error.stack);
    }
    return Response.json({ error: 'Failed to save snapshot' }, { status: 500 });
  }
};
