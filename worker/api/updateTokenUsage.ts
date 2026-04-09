import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';

export async function handler(request: Request, env: Env): Promise<Response> {
  let body: { editToken?: string; tokensUsed?: number };
  try {
    body = await request.json() as { editToken?: string; tokensUsed?: number };
  } catch {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  try {
    const { editToken, tokensUsed } = body;

    if (!editToken || typeof tokensUsed !== 'number') {
      return Response.json({ error: 'Edit token and tokensUsed are required' }, { status: 400 });
    }

    const sql = getDb(env);

    await sql`
      UPDATE charts
      SET total_tokens_used = total_tokens_used + ${tokensUsed}
      WHERE edit_token = ${editToken}
    `;

    const chartResult = await sql`
      SELECT user_id FROM charts WHERE edit_token = ${editToken}
    `;

    if (chartResult.length > 0 && chartResult[0].user_id) {
      const userId = chartResult[0].user_id;
      await sql`
        INSERT INTO user_token_usage (user_id, total_tokens_used, last_updated_at)
        VALUES (${userId}, ${tokensUsed}, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id)
        DO UPDATE SET
          total_tokens_used = user_token_usage.total_tokens_used + ${tokensUsed},
          last_updated_at = CURRENT_TIMESTAMP
      `;
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error('Error updating token usage:', error);
    return Response.json({ error: 'Failed to update token usage' }, { status: 500 });
  }
};
