import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';

// Multi-method handler: GET + POST
export async function handler(request: Request, env: Env): Promise<Response> {
  const method = request.method;

  if (!['GET', 'POST'].includes(method)) {
    return Response.json({ error: 'Method Not Allowed' }, { status: 405 });
  }

  // Auth required for preference management
  const token = extractToken(request.headers.get('authorization'));
  if (!token) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  let user_id: string;
  try {
    const decoded = await verifyToken(token, env);
    user_id = decoded.sub;
  } catch (err) {
    if (err instanceof JWKSFetchError) {
      return Response.json({ error: 'Authentication service unavailable' }, { status: 502 });
    }
    console.error('[logging-preference] Token verification failed:', err);
    return Response.json({ error: 'Invalid token' }, { status: 401 });
  }

  try {
    const sql = getDb(env);

    if (method === 'GET') {
      const result = await sql`
        SELECT opted_out FROM logging_preferences WHERE user_id = ${user_id}
      `;
      const hasRecord = result.length > 0;
      return Response.json({
        opted_out: hasRecord ? result[0].opted_out : false,
        has_record: hasRecord
      });
    }

    // POST
    let parsed: { opted_out: boolean };
    try {
      parsed = await request.json() as { opted_out: boolean };
    } catch {
      return Response.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    if (typeof parsed.opted_out !== 'boolean') {
      return Response.json({ error: 'opted_out must be a boolean' }, { status: 400 });
    }

    await sql`
      INSERT INTO logging_preferences (user_id, opted_out, updated_at)
      VALUES (${user_id}, ${parsed.opted_out}, NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET opted_out = ${parsed.opted_out}, updated_at = NOW()
    `;

    return Response.json({ opted_out: parsed.opted_out });
  } catch (error) {
    console.error('[logging-preference] Error:', error);
    return Response.json({ error: 'Failed to process preference' }, { status: 500 });
  }
};
