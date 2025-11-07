import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from './utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Verify authentication
    const token = extractToken(event.headers.authorization);
    if (!token) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Authentication required' })
      };
    }

    let decodedToken;
    try {
      decodedToken = await verifyToken(token);
    } catch (err) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid or expired token' })
      };
    }

    const userId = decodedToken.sub;

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }

    const sql = neon(DATABASE_URL);

    // Get user token usage
    const result = await sql`
      SELECT
        total_tokens_used,
        last_updated_at,
        created_at
      FROM user_token_usage
      WHERE user_id = ${userId}
    `;

    if (result.length === 0) {
      // No usage yet, return zeros
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          totalTokensUsed: 0,
          lastUpdatedAt: null,
          createdAt: null
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        totalTokensUsed: result[0].total_tokens_used,
        lastUpdatedAt: result[0].last_updated_at,
        createdAt: result[0].created_at
      })
    };
  } catch (error) {
    console.error('Error fetching user token usage:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch token usage' })
    };
  }
};
