import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
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
    const chartId = event.queryStringParameters?.chartId;
    const editToken = event.queryStringParameters?.editToken;

    if (!chartId && !editToken) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Chart ID or edit token is required' })
      };
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }

    // Connect to database
    const sql = neon(DATABASE_URL);

    let result;
    if (editToken) {
      // Fetch by edit token (for editing)
      result = await sql`
        SELECT id, chart_data FROM charts
        WHERE edit_token = ${editToken}
      `;
    } else if (chartId) {
      // Fetch by chart ID (for viewing)
      result = await sql`
        SELECT id, chart_data FROM charts
        WHERE id = ${chartId}
      `;
      // Increment view count
      await sql`
        UPDATE charts SET view_count = view_count + 1
        WHERE id = ${chartId}
      `;
    }

    if (!result || result.length === 0) {
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
        chartData: result[0].chart_data,
        chartId: result[0].id,
        canEdit: !!editToken
      })
    };
  } catch (error) {
    console.error('Error fetching chart:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch chart' })
    };
  }
};