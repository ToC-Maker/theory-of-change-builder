import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { isUserOptedOut } from '../_shared/logging-optout';
import { ANTHROPIC_MESSAGES_REQUEST_BODY_BYTES } from '../../shared/anthropic-limits';

interface SaveSnapshotRequest {
  session_id: string;
  chart_id: string;
  // graph_data is JSONB — shape-checked at runtime below.
  graph_data: unknown;
  edit_type: 'ai_edit' | 'manual_edit' | 'undo' | 'redo' | 'initial';
  triggered_by_message_id?: string | null;
  // edit_instructions is model-generated and validated by applyEdits in the
  // client; the worker just stores the JSON verbatim.
  edit_instructions?: unknown[] | null;
  edit_success?: boolean;
  error_message?: string | null;
}

export async function handler(request: Request, env: Env): Promise<Response> {
  // Single payload ceiling matches Anthropic's Messages API request cap.
  const text = await request.text();
  if (new TextEncoder().encode(text).length > ANTHROPIC_MESSAGES_REQUEST_BODY_BYTES) {
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

    // Minimal graph_data shape check: must be an object with a `sections`
    // array. We deliberately don't validate the full ToC schema — this
    // table stores JSONB and the shape evolves independently — but at
    // least reject nonsense early so a typo in the client doesn't fill the
    // snapshot log with garbage that'd break later diffs.
    const gd = data.graph_data as unknown;
    if (
      !gd ||
      typeof gd !== 'object' ||
      Array.isArray(gd) ||
      !Array.isArray((gd as { sections?: unknown }).sections)
    ) {
      return Response.json({ error: 'Invalid graph_data shape' }, { status: 400 });
    }

    const token = extractToken(request.headers.get('authorization'));
    let user_id = null;

    if (token) {
      try {
        const decoded = await verifyToken(token, env);
        user_id = decoded.sub;
      } catch (err) {
        if (err instanceof JWKSFetchError) {
          return Response.json({ error: 'Authentication service unavailable' }, { status: 502 });
        }
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
        ${user_id}, ${user_id !== null}
      FROM next_seq
      RETURNING id, sequence_number
    `;

    return Response.json(result[0]);
  } catch (error) {
    // Surface the specific Postgres error code to help diagnose without
    // needing Worker logs (preview deploys have none). 23503 = foreign
    // key violation; typical here when session_id points at a
    // logging_sessions row that doesn't exist (stale client state or
    // a prior createSession that failed silently). Return 409 so the
    // client can distinguish "you sent a bad session" from a real 500.
    const pgCode = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    console.error('[logging-saveSnapshot] insert failed:', pgCode, message);
    if (pgCode === '23503') {
      return Response.json(
        { error: 'Foreign key violation', detail: message, code: pgCode },
        { status: 409 },
      );
    }
    return Response.json({ error: 'Failed to save snapshot', detail: message }, { status: 500 });
  }
}
