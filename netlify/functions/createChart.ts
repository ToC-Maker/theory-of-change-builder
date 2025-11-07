import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';
import { verifyToken, extractToken } from './utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// Generate a short, URL-friendly ID
function generateChartId(): string {
  return crypto.randomBytes(6).toString('base64url');
}

// Generate a secure edit token
function generateEditToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export const handler: Handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { chartData } = JSON.parse(event.body || '{}');

    if (!chartData) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Chart data is required' })
      };
    }

    const chartId = generateChartId();
    const editToken = generateEditToken();

    // Get database connection from environment
    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }

    // Connect to database
    const sql = neon(DATABASE_URL);

    // Extract chart title from chart data
    const chartTitle = chartData.title || 'Theory of Change';

    // Check if user is authenticated
    let userId = null;
    let userEmail = null;
    const token = extractToken(event.headers.authorization);

    console.log('[createChart] Authorization header present:', !!event.headers.authorization);
    console.log('[createChart] Token extracted:', !!token);

    if (token) {
      try {
        const decodedToken = await verifyToken(token);
        userId = decodedToken.sub;
        userEmail = decodedToken.email || decodedToken.name;
        console.log('[createChart] Token verified successfully. User ID:', userId);
      } catch (err) {
        // If token is invalid, treat as anonymous user
        console.error('[createChart] Token verification failed:', err);
        console.log('[createChart] Creating anonymous chart due to invalid token');
      }
    } else {
      console.log('[createChart] No token provided, creating anonymous chart');
    }

    // Insert the chart into database with user_id and chart_title
    await sql`
      INSERT INTO charts (id, edit_token, chart_data, user_id, chart_title)
      VALUES (${chartId}, ${editToken}, ${JSON.stringify(chartData)}, ${userId || null}, ${chartTitle})
    `;

    // If user is authenticated, create owner permission with email
    if (userId && userEmail) {
      await sql`
        INSERT INTO chart_permissions (chart_id, user_id, user_email, permission_level, granted_by)
        VALUES (${chartId}, ${userId}, ${userEmail}, 'owner', ${userId})
      `;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        chartId,
        editToken,
        viewUrl: `${process.env.URL || ''}/chart/${chartId}`,
        editUrl: `${process.env.URL || ''}/edit/${editToken}`,
        message: 'Chart created successfully'
      })
    };
  } catch (error) {
    console.error('Error creating chart:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to create chart' })
    };
  }
};