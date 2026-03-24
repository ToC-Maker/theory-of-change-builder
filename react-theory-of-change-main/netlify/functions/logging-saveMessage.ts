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

interface SaveMessageRequest {
  session_id: string;
  message_id: string;
  chart_id: string;
  role: 'user' | 'assistant';
  content: string;
  usage_input_tokens?: number;
  usage_output_tokens?: number;
  usage_total_tokens?: number;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  // Reject oversized payloads (content max 100KB + overhead)
  const bodyLength = Buffer.byteLength(event.body || '', 'utf8');
  if (bodyLength > 200_000) {
    return {
      statusCode: 413,
      headers,
      body: JSON.stringify({ error: 'Payload too large' })
    };
  }

  let data: SaveMessageRequest;
  try {
    data = JSON.parse(event.body || '{}') as SaveMessageRequest;
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Invalid JSON' })
    };
  }

  try {
    // Validate required fields
    if (!data.session_id || !data.message_id || !data.chart_id || !data.role || !data.content) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    const validRoles = ['user', 'assistant'];
    if (!validRoles.includes(data.role)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid role. Must be "user" or "assistant"' })
      };
    }

    // Validate field sizes
    if (Buffer.byteLength(data.content, 'utf8') > 100_000) {
      return {
        statusCode: 413,
        headers,
        body: JSON.stringify({ error: 'content exceeds 100KB limit' })
      };
    }

    // Extract user_id from auth token
    const token = extractToken(event.headers.authorization);
    let user_id = null;

    if (token) {
      try {
        const decoded = await verifyToken(token);
        user_id = decoded.sub;
      } catch (err) {
        console.error('[logging-saveMessage] Token verification failed:', err);
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

    const result = await sql`
      INSERT INTO logging_messages (
        session_id, message_id, chart_id, role, content,
        usage_input_tokens, usage_output_tokens, usage_total_tokens,
        user_id
      )
      VALUES (
        ${data.session_id}, ${data.message_id}, ${data.chart_id},
        ${data.role}, ${data.content},
        ${data.usage_input_tokens ?? null}, ${data.usage_output_tokens ?? null},
        ${data.usage_total_tokens ?? null},
        ${user_id}
      )
      ON CONFLICT (message_id) DO NOTHING
      RETURNING message_id
    `;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result[0] || { message: 'Message already exists' })
    };
  } catch (error) {
    console.error('Error saving message:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to save message' })
    };
  }
};
