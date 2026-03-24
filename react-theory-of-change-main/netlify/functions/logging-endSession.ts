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

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Reject oversized payloads
  const bodyLength = Buffer.byteLength(event.body || '', 'utf8');
  if (bodyLength > 10_000) {
    return {
      statusCode: 413,
      headers,
      body: JSON.stringify({ error: 'Payload too large' })
    };
  }

  let parsed: { session_id?: string };
  try {
    parsed = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  try {
    const { session_id } = parsed;

    if (!session_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'session_id required' })
      };
    }

    // Extract user_id from auth token (if present)
    const token = extractToken(event.headers.authorization);
    let user_id = null;

    if (token) {
      try {
        const decoded = await verifyToken(token);
        user_id = decoded.sub;
      } catch (err) {
        console.error('[logging-endSession] Token verification failed:', err);
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

    await sql`
      UPDATE logging_sessions
      SET ended_at = NOW()
      WHERE session_id = ${session_id} AND ended_at IS NULL
    `;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true })
    };
  } catch (error) {
    console.error('Error ending session:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to end session' })
    };
  }
};
