import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

interface UpdateSessionRequest {
  session_id: string;
  chart_id: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  try {
    const { session_id, chart_id } = JSON.parse(event.body || '{}') as UpdateSessionRequest;

    if (!session_id || !chart_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'session_id and chart_id required' })
      };
    }

    // Database connection
    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    const sql = neon(DATABASE_URL);

    // Update session's chart_id
    const result = await sql`
      UPDATE logging_sessions
      SET chart_id = ${chart_id}
      WHERE session_id = ${session_id}
      RETURNING *
    `;

    if (result.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Session not found' })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result[0])
    };
  } catch (error) {
    console.error('Error updating session:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to update session' })
    };
  }
};
