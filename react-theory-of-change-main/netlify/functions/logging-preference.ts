import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from './utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Auth required for preference management
  const token = extractToken(event.headers.authorization);
  if (!token) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Authentication required' })
    };
  }

  let user_id: string;
  try {
    const decoded = await verifyToken(token);
    user_id = decoded.sub;
  } catch {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Invalid token' })
    };
  }

  const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'DATABASE_URL not configured' })
    };
  }
  const sql = neon(DATABASE_URL);

  try {
    if (event.httpMethod === 'GET') {
      // Get current preference
      const result = await sql`
        SELECT opted_out FROM logging_preferences WHERE user_id = ${user_id}
      `;
      const hasRecord = result.length > 0;
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          opted_out: hasRecord ? result[0].opted_out : false,
          has_record: hasRecord
        })
      };
    }

    if (event.httpMethod === 'POST') {
      let parsed: { opted_out: boolean };
      try {
        parsed = JSON.parse(event.body || '{}');
      } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
      }

      if (typeof parsed.opted_out !== 'boolean') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'opted_out must be a boolean' })
        };
      }

      await sql`
        INSERT INTO logging_preferences (user_id, opted_out, updated_at)
        VALUES (${user_id}, ${parsed.opted_out}, NOW())
        ON CONFLICT (user_id) DO UPDATE
        SET opted_out = ${parsed.opted_out}, updated_at = NOW()
      `;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ opted_out: parsed.opted_out })
      };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  } catch (error) {
    console.error('[logging-preference] Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to process preference' })
    };
  }
};
