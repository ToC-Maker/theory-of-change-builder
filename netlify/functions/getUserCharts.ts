import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken, migrateUserIfNeeded } from './utils/auth';

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
    const userId = event.queryStringParameters?.userId;

    if (!userId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'User ID is required' })
      };
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }

    // Connect to database
    const sql = neon(DATABASE_URL);

    // Migrate user data if they logged in with a new Auth0 tenant (different sub, same email)
    const token = extractToken(event.headers.authorization);
    if (token) {
      try {
        const decodedToken = await verifyToken(token);
        const email = decodedToken.email || decodedToken.name;
        if (email) {
          await migrateUserIfNeeded(sql, userId, email);
        }
      } catch (err) {
        // Token verification failure is non-fatal here — continue with the query
        console.log('[getUserCharts] Token verification failed, skipping migration check');
      }
    }

    // Fetch charts where user has permission (owner or editor) OR where user is the creator
    // This ensures charts appear even if permission entry wasn't created yet
    const result = await sql`
      SELECT DISTINCT
        c.id as chart_id,
        c.chart_title,
        c.edit_token,
        c.updated_at,
        c.created_at,
        COALESCE(cp.permission_level, 'owner') as permission_level
      FROM charts c
      LEFT JOIN chart_permissions cp ON c.id = cp.chart_id AND cp.user_id = ${userId}
      WHERE cp.user_id = ${userId} OR c.user_id = ${userId}
      ORDER BY c.updated_at DESC
    `;

    // Format the results
    const charts = result.map((row: any) => ({
      chartId: row.chart_id,
      title: row.chart_title || 'Theory of Change',
      editUrl: `${process.env.URL || ''}/edit/${row.edit_token}`,
      viewUrl: `${process.env.URL || ''}/chart/${row.chart_id}`,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      permissionLevel: row.permission_level
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ charts })
    };
  } catch (error) {
    console.error('Error fetching user charts:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch user charts' })
    };
  }
};
