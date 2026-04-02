import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from './utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

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

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Reject oversized payloads (errors should be small)
  const bodyLength = Buffer.byteLength(event.body || '', 'utf8');
  if (bodyLength > 50_000) {
    return {
      statusCode: 413,
      headers,
      body: JSON.stringify({ error: 'Payload too large' })
    };
  }

  let data: ReportErrorRequest;
  try {
    data = JSON.parse(event.body || '{}') as ReportErrorRequest;
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  try {
    // Validate required fields
    if (!data.error_id || !data.error_name || !data.error_message) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields: error_id, error_name, error_message' })
      };
    }

    // Server-side field truncation (defense-in-depth, don't trust client)
    data.error_message = data.error_message.slice(0, 8192);
    if (data.stack_trace) data.stack_trace = data.stack_trace.slice(0, 4096);
    if (data.error_name) data.error_name = data.error_name.slice(0, 200);

    // Extract user_id from auth token (optional, don't reject anonymous)
    const token = extractToken(event.headers.authorization);
    let user_id = null;

    if (token) {
      try {
        const decoded = await verifyToken(token);
        user_id = decoded.sub;
      } catch (err) {
        // Unlike logging-saveMessage, don't reject on bad token — error reports
        // are too valuable to lose, and auth failure may itself be the error.
        console.error('[logging-reportError] Token verification failed:', err);
      }
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    const sql = neon(DATABASE_URL);

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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result[0] || { message: 'Error already reported' })
    };
  } catch (error) {
    console.error('Error saving error report:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to save error report' })
    };
  }
};
