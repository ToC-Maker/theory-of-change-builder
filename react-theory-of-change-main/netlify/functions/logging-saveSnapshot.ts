import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from './utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

interface SaveSnapshotRequest {
  session_id: string;
  chart_id?: string | null;
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

  try {
    const data = JSON.parse(event.body || '{}') as SaveSnapshotRequest;

    // Validate required fields (chart_id can be null for new unsaved charts)
    if (!data.session_id || !data.graph_data || !data.edit_type) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    // Extract user info and auth status
    const token = extractToken(event.headers.authorization);
    let user_id = null;
    let user_email = null;
    let is_authenticated = false;

    if (token) {
      try {
        const decoded = await verifyToken(token);
        user_id = decoded.sub;
        user_email = decoded.email || decoded.name;
        is_authenticated = true;
      } catch (err) {
        console.error('[logging-saveSnapshot] Token verification failed:', err);
        // Continue as anonymous
      }
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    const sql = neon(DATABASE_URL);

    // Atomically get next sequence number and insert snapshot
    const result = await sql`
      WITH next_seq AS (
        SELECT COALESCE(MAX(sequence_number), 0) + 1 as seq
        FROM logging_snapshots
        WHERE session_id = ${data.session_id}
      )
      INSERT INTO logging_snapshots (
        session_id, sequence_number, chart_id, graph_data,
        edit_type, triggered_by_message_id, edit_instructions,
        edit_success, error_message, user_id, user_email,
        is_authenticated
      )
      SELECT
        ${data.session_id}, seq, ${data.chart_id || null}, ${JSON.stringify(data.graph_data)}::jsonb,
        ${data.edit_type}, ${data.triggered_by_message_id || null},
        ${data.edit_instructions ? JSON.stringify(data.edit_instructions) : null}::jsonb,
        ${data.edit_success !== false}, ${data.error_message || null},
        ${user_id}, ${user_email}, ${is_authenticated}
      FROM next_seq
      RETURNING *
    `;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result[0])
    };
  } catch (error) {
    console.error('Error saving snapshot:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to save snapshot' })
    };
  }
};
