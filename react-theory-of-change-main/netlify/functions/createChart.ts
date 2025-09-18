import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
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
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }

    // Connect to database
    const sql = neon(DATABASE_URL);

    // Insert the chart into database
    await sql`
      INSERT INTO charts (id, edit_token, chart_data)
      VALUES (${chartId}, ${editToken}, ${JSON.stringify(chartData)})
    `;

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