import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { isUserOptedOut } from '../_shared/logging-optout';
import { ANTHROPIC_MESSAGES_REQUEST_BODY_BYTES } from '../../shared/anthropic-limits';

interface CreateSessionRequest {
  session_id: string;
  chart_id: string;
  user_agent?: string;
}

export async function handler(request: Request, env: Env): Promise<Response> {
  // Single payload ceiling matches Anthropic's Messages API request cap.
  const text = await request.text();
  if (new TextEncoder().encode(text).length > ANTHROPIC_MESSAGES_REQUEST_BODY_BYTES) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  let parsed: CreateSessionRequest;
  try {
    parsed = JSON.parse(text) as CreateSessionRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    const { session_id, chart_id, user_agent } = parsed;

    if (!session_id || !chart_id) {
      return Response.json({ error: 'session_id and chart_id required' }, { status: 400 });
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
        console.error('[logging-createSession] Token verification failed:', err);
        return Response.json({ error: 'Token verification failed' }, { status: 401 });
      }
    }

    const sql = getDb(env);

    if (await isUserOptedOut(sql, user_id)) {
      return Response.json({ opted_out: true });
    }

    const result = await sql`
      INSERT INTO logging_sessions (session_id, chart_id, user_id, user_agent)
      VALUES (${session_id}, ${chart_id}, ${user_id}, ${user_agent || null})
      ON CONFLICT (session_id) DO UPDATE
      SET started_at = NOW()
      RETURNING session_id, started_at
    `;

    return Response.json(result[0]);
  } catch (error) {
    console.error('Error creating session:', error);
    return Response.json({ error: 'Failed to create session' }, { status: 500 });
  }
};
