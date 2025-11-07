import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from './utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'DELETE, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'DELETE') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { chartId } = JSON.parse(event.body || '{}');

    if (!chartId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Chart ID is required' })
      };
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }

    // Connect to database
    const sql = neon(DATABASE_URL);

    // Check if this is an anonymous chart (no owner)
    const chartInfo = await sql`
      SELECT user_id FROM charts
      WHERE id = ${chartId}
    `;

    if (!chartInfo.length) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Chart not found' })
      };
    }

    const chartOwnerId = chartInfo[0].user_id;

    // If chart has no owner (anonymous), allow deletion without authentication
    if (!chartOwnerId) {
      const result = await sql`
        DELETE FROM charts
        WHERE id = ${chartId}
        RETURNING id
      `;

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'Chart deleted successfully'
        })
      };
    }

    // For charts with owners, verify authentication
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

    // Check if user is the owner
    const ownerCheck = await sql`
      SELECT permission_level FROM chart_permissions
      WHERE chart_id = ${chartId} AND user_id = ${userId}
    `;

    if (!ownerCheck.length || ownerCheck[0].permission_level !== 'owner') {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Only the owner can delete this chart' })
      };
    }

    // Delete the chart (cascade will delete permissions too)
    const result = await sql`
      DELETE FROM charts
      WHERE id = ${chartId}
      RETURNING id
    `;

    if (!result.length) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Chart not found' })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Chart deleted successfully'
      })
    };
  } catch (error) {
    console.error('Error deleting chart:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to delete chart' })
    };
  }
};
