import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';

export async function handler(request: Request, env: Env): Promise<Response> {
  try {
    const token = extractToken(request.headers.get('authorization'));
    if (!token) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let decodedToken;
    try {
      decodedToken = await verifyToken(token, env);
    } catch (err) {
      if (err instanceof JWKSFetchError) {
        return Response.json({ error: 'Authentication service unavailable' }, { status: 502 });
      }
      return Response.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    const userId = decodedToken.sub;
    const sql = getDb(env);

    const result = await sql`
      SELECT total_tokens_used, last_updated_at, created_at
      FROM user_token_usage
      WHERE user_id = ${userId}
    `;

    if (result.length === 0) {
      return Response.json({
        totalTokensUsed: 0,
        lastUpdatedAt: null,
        createdAt: null
      });
    }

    return Response.json({
      totalTokensUsed: result[0].total_tokens_used,
      lastUpdatedAt: result[0].last_updated_at,
      createdAt: result[0].created_at
    });
  } catch (error) {
    console.error('Error fetching user token usage:', error);
    return Response.json({ error: 'Failed to fetch token usage' }, { status: 500 });
  }
};
