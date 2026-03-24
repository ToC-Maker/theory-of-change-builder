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

interface CreateSessionRequest {
  session_id: string;
  chart_id: string;
  user_agent?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Reject oversized payloads (body should be small for session creation)
  const bodyLength = Buffer.byteLength(event.body || '', 'utf8');
  if (bodyLength > 10_000) {
    return {
      statusCode: 413,
      headers,
      body: JSON.stringify({ error: 'Payload too large' })
    };
  }

  let parsed: CreateSessionRequest;
  try {
    parsed = JSON.parse(event.body || '{}') as CreateSessionRequest;
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  try {
    const { session_id, chart_id, user_agent } = parsed;

    if (!session_id || !chart_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'session_id and chart_id required' })
      };
    }

    // Validate field sizes
    if (user_agent && Buffer.byteLength(user_agent, 'utf8') > 1_024) {
      return {
        statusCode: 413,
        headers,
        body: JSON.stringify({ error: 'user_agent exceeds 1KB limit' })
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
        console.error('[logging-createSession] Token verification failed:', err);
        // Auth header was present but invalid — don't fall back to anonymous
        // (would bypass server-side opt-out check)
        return {
          statusCode: 401,
          headers,
          body: JSON.stringify({ error: 'Token verification failed' })
        };
      }
    }

    // Database connection
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

    // Insert session - ON CONFLICT updates started_at for session resume
    const result = await sql`
      INSERT INTO logging_sessions (session_id, chart_id, user_id, user_agent)
      VALUES (${session_id}, ${chart_id}, ${user_id}, ${user_agent || null})
      ON CONFLICT (session_id) DO UPDATE
      SET started_at = NOW()
      RETURNING session_id, started_at
    `;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result[0])
    };
  } catch (error) {
    console.error('Error creating session:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to create session' })
    };
  }

};
