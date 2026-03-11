import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';

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

  try {
    const { session_id } = JSON.parse(event.body || '{}');

    if (!session_id) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'session_id required' })
      };
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    const sql = neon(DATABASE_URL);

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
