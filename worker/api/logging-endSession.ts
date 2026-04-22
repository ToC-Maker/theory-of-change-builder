import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { isUserOptedOut } from '../_shared/logging-optout';
import { ANTHROPIC_MESSAGES_REQUEST_BODY_BYTES } from '../../shared/anthropic-limits';

export async function handler(request: Request, env: Env): Promise<Response> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > ANTHROPIC_MESSAGES_REQUEST_BODY_BYTES) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  let parsed: { session_id?: string };
  try {
    parsed = JSON.parse(text);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const { session_id } = parsed;

    if (!session_id) {
      return Response.json({ error: 'session_id required' }, { status: 400 });
    }

    const token = extractToken(request.headers.get('authorization'));
    let user_id = null;

    if (token) {
      try {
        const decoded = await verifyToken(token, env);
        user_id = decoded.sub;
      } catch (err) {
        if (err instanceof JWKSFetchError) {
          return Response.json({ error: 'Authentication service unavailable' }, { status: 502 });
        }
        console.error('[logging-endSession] Token verification failed:', err);
        return Response.json({ error: 'Token verification failed' }, { status: 401 });
      }
    }

    const sql = getDb(env);

    if (await isUserOptedOut(sql, user_id)) {
      return Response.json({ opted_out: true });
    }

    await sql`
      UPDATE logging_sessions
      SET ended_at = NOW()
      WHERE session_id = ${session_id} AND ended_at IS NULL
    `;

    return Response.json({ success: true });
  } catch (error) {
    console.error('Error ending session:', error);
    return Response.json({ error: 'Failed to end session' }, { status: 500 });
  }
};
