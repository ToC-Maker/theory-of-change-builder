import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from './utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

interface CreateSessionRequest {
  session_id: string;
  chart_id?: string | null;
  user_agent?: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { session_id, chart_id, user_agent } = JSON.parse(event.body || '{}') as CreateSessionRequest;

    if (!session_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'session_id required' })
      };
    }

    // Extract user_id and email from auth token (if present)
    const token = extractToken(event.headers.authorization);
    let user_id = null;
    let user_email = null;

    if (token) {
      try {
        const decoded = await verifyToken(token);
        user_id = decoded.sub;
        user_email = decoded.email || decoded.name;
      } catch (err) {
        console.error('[logging-createSession] Token verification failed:', err);
        // Continue as anonymous
      }
    }

    // Database connection
    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    const sql = neon(DATABASE_URL);

    // Insert session - ON CONFLICT updates started_at for session resume
    // chart_id can be null for new unsaved charts
    const result = await sql`
      INSERT INTO logging_sessions (session_id, chart_id, user_id, user_email, user_agent)
      VALUES (${session_id}, ${chart_id || null}, ${user_id}, ${user_email}, ${user_agent || null})
      ON CONFLICT (session_id) DO UPDATE
      SET started_at = NOW()
      RETURNING *
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
