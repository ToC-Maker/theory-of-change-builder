import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
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
    const { editToken, tokensUsed } = JSON.parse(event.body || '{}');

    if (!editToken || typeof tokensUsed !== 'number') {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Edit token and tokensUsed are required' })
      };
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }

    const sql = neon(DATABASE_URL);

    // Update chart token usage
    await sql`
      UPDATE charts
      SET total_tokens_used = total_tokens_used + ${tokensUsed}
      WHERE edit_token = ${editToken}
    `;

    // Get the user_id for this chart
    const chartResult = await sql`
      SELECT user_id FROM charts
      WHERE edit_token = ${editToken}
    `;

    // If chart has an owner (user_id), update user token usage
    if (chartResult.length > 0 && chartResult[0].user_id) {
      const userId = chartResult[0].user_id;

      // Insert or update user token usage using ON CONFLICT
      await sql`
        INSERT INTO user_token_usage (user_id, total_tokens_used, last_updated_at)
        VALUES (${userId}, ${tokensUsed}, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id)
        DO UPDATE SET
          total_tokens_used = user_token_usage.total_tokens_used + ${tokensUsed},
          last_updated_at = CURRENT_TIMESTAMP
      `;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true })
    };
  } catch (error) {
    console.error('Error updating token usage:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to update token usage' })
    };
  }
};
