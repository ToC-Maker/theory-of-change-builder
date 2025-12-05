import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from './utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

interface SaveMessageRequest {
  session_id: string;
  message_id: string;
  chart_id?: string | null;
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

  try {
    const data = JSON.parse(event.body || '{}') as SaveMessageRequest;

    // Validate required fields (chart_id can be null for new unsaved charts)
    if (!data.session_id || !data.message_id || !data.role || !data.content) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    // Extract user info from auth token
    const token = extractToken(event.headers.authorization);
    let user_id = null;
    let user_email = null;

    if (token) {
      try {
        const decoded = await verifyToken(token);
        user_id = decoded.sub;
        user_email = decoded.email || decoded.name;
      } catch (err) {
        console.error('[logging-saveMessage] Token verification failed:', err);
        // Continue as anonymous
      }
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }
    const sql = neon(DATABASE_URL);

    const result = await sql`
      INSERT INTO logging_messages (
        session_id, message_id, chart_id, role, content,
        usage_input_tokens, usage_output_tokens, usage_total_tokens,
        user_id, user_email
      )
      VALUES (
        ${data.session_id}, ${data.message_id}, ${data.chart_id || null},
        ${data.role}, ${data.content},
        ${data.usage_input_tokens || null}, ${data.usage_output_tokens || null},
        ${data.usage_total_tokens || null},
        ${user_id}, ${user_email}
      )
      ON CONFLICT (message_id) DO NOTHING
      RETURNING *
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
