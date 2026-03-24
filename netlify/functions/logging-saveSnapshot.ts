import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from './utils/auth';
import { isUserOptedOut } from './utils/logging-optout';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

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

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Reject oversized payloads (graph_data max 1MB + overhead)
  const bodyLength = Buffer.byteLength(event.body || '', 'utf8');
  if (bodyLength > 1_500_000) {
    return {
      statusCode: 413,
      headers,
      body: JSON.stringify({ error: 'Payload too large' })
    };
  }

  let data: SaveSnapshotRequest;
  try {
    data = JSON.parse(event.body || '{}') as SaveSnapshotRequest;
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  try {
    // Validate required fields
    if (!data.session_id || !data.chart_id || !data.graph_data || !data.edit_type) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    const validEditTypes = ['ai_edit', 'manual_edit', 'undo', 'redo', 'initial'];
    if (!validEditTypes.includes(data.edit_type)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid edit_type' })
      };
    }

    // Validate field sizes
    const graphDataSize = Buffer.byteLength(JSON.stringify(data.graph_data), 'utf8');
    if (graphDataSize > 1_000_000) {
      return {
        statusCode: 413,
        headers,
        body: JSON.stringify({ error: 'graph_data exceeds 1MB limit' })
      };
    }

    if (data.edit_instructions) {
      const editInstructionsSize = Buffer.byteLength(JSON.stringify(data.edit_instructions), 'utf8');
      if (editInstructionsSize > 100_000) {
        return {
          statusCode: 413,
          headers,
          body: JSON.stringify({ error: 'edit_instructions exceeds 100KB limit' })
        };
      }
    }

    if (data.error_message && Buffer.byteLength(data.error_message, 'utf8') > 10_000) {
      return {
        statusCode: 413,
        headers,
        body: JSON.stringify({ error: 'error_message exceeds 10KB limit' })
      };
    }

    // Extract user_id and auth status
    const token = extractToken(event.headers.authorization);
    let user_id = null;
    let is_authenticated = false;

    if (token) {
      try {
        const decoded = await verifyToken(token);
        user_id = decoded.sub;
        is_authenticated = true;
      } catch (err) {
        console.error('[logging-saveSnapshot] Token verification failed:', err);
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: 'Token verification failed' })
        };
      }
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    const sql = neon(DATABASE_URL);

    // Server-side opt-out check
    if (await isUserOptedOut(sql, user_id)) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ opted_out: true })
      };
    }

    // Atomically get next sequence number and insert snapshot.
    // Use pg_advisory_xact_lock to serialize inserts per session_id,
    // preventing duplicate sequence numbers from concurrent requests.
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result[0])
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('Error saving snapshot:', errorMessage);
    if (error instanceof Error && error.stack) {
      console.error('Stack:', error.stack);
    }
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to save snapshot' })
    };
  }
};
