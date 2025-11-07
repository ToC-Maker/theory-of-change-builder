import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

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
    const { editToken, chartData } = JSON.parse(event.body || '{}');

    if (!editToken || !chartData) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Edit token and chart data are required' })
      };
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }

    // Connect to database
    const sql = neon(DATABASE_URL);

    // Extract chart title from chart data
    const chartTitle = chartData.title || 'Theory of Change';

    // Update the chart
    const result = await sql`
      UPDATE charts
      SET chart_data = ${JSON.stringify(chartData)},
          chart_title = ${chartTitle},
          updated_at = NOW()
      WHERE edit_token = ${editToken}
      RETURNING id
    `;

    if (!result || result.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Chart not found or invalid edit token' })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Chart updated successfully'
      })
    };
  } catch (error) {
    console.error('Error updating chart:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to update chart' })
    };
  }
};