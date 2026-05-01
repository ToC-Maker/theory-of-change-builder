import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { isUserOptedOut } from '../_shared/logging-optout';
import { resolveAnonActor } from '../_shared/anon-id';
import { ANTHROPIC_MESSAGES_REQUEST_BODY_BYTES } from '../../shared/anthropic-limits';

interface SaveMessageRequest {
  session_id: string;
  message_id: string;
  chart_id: string;
  role: 'user' | 'assistant';
  content: string;
  usage_input_tokens?: number;
  usage_output_tokens?: number;
  usage_total_tokens?: number;
}

export async function handler(request: Request, env: Env): Promise<Response> {
  // Single payload ceiling matches Anthropic's Messages API request cap
  // (32 MB). If anthropic-stream accepted it, we log it.
  const text = await request.text();
  if (new TextEncoder().encode(text).length > ANTHROPIC_MESSAGES_REQUEST_BODY_BYTES) {
    return Response.json({ error: 'Payload too large' }, { status: 413 });
  }

  let data: SaveMessageRequest;
  try {
    data = JSON.parse(text) as SaveMessageRequest;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  try {
    if (!data.session_id || !data.message_id || !data.chart_id || !data.role) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (data.role !== 'user' && data.role !== 'assistant') {
      return Response.json(
        { error: 'Invalid role. Must be "user" or "assistant"' },
        { status: 400 },
      );
    }

    // Content must be a non-empty string. The client sends the raw
    // pre-cleaned model output (including any [EDIT_INSTRUCTIONS] or
    // other markers), so a zero-length body here means the stream
    // aborted before any content arrived — a failure mode worth
    // rejecting loudly rather than recording as an empty row.
    if (typeof data.content !== 'string' || data.content.length === 0) {
      return Response.json({ error: 'content must be a non-empty string' }, { status: 400 });
    }

    const token = extractToken(request.headers.get('authorization'));
    let user_id: string | null = null;

    if (token) {
      try {
        const decoded = await verifyToken(token, env);
        user_id = decoded.sub;
      } catch (err) {
        if (err instanceof JWKSFetchError) {
          return Response.json({ error: 'Authentication service unavailable' }, { status: 502 });
        }
        console.error('[logging-saveMessage] Token verification failed:', err);
        return Response.json({ error: 'Token verification failed' }, { status: 401 });
      }
    } else {
      // Anonymous path: pin user_id to the cookie-based actor id ("anon-<uuid>")
      // so downstream endpoints that own-check by user_id (POST /api/reconcile-cost,
      // future per-user analytics) can recognize anon callers as the same identity
      // that wrote the row. Without this, the row's user_id stays NULL and any
      // ownership query fails for anon, silently dropping the entire anon path
      // through reconcile-cost.
      try {
        const resolved = await resolveAnonActor(request, env);
        user_id = resolved.userId;
      } catch (e) {
        console.error('[logging-saveMessage] anon actor resolve failed:', e);
        // Fall through with user_id=null — the INSERT still succeeds, we just
        // lose ownership-based reconcile for this row. Better than rejecting.
      }
    }

    const sql = getDb(env);

    if (await isUserOptedOut(sql, user_id)) {
      return Response.json({ opted_out: true });
    }

    const result = await sql`
      INSERT INTO logging_messages (
        session_id, message_id, chart_id, role, content,
        usage_input_tokens, usage_output_tokens, usage_total_tokens,
        user_id
      )
      VALUES (
        ${data.session_id}, ${data.message_id}, ${data.chart_id},
        ${data.role}, ${data.content},
        ${data.usage_input_tokens ?? null}, ${data.usage_output_tokens ?? null},
        ${data.usage_total_tokens ?? null},
        ${user_id}
      )
      ON CONFLICT (message_id) DO NOTHING
      RETURNING message_id
    `;

    return Response.json(result[0] || { message: 'Message already exists' });
  } catch (error) {
    console.error('Error saving message:', error);
    return Response.json({ error: 'Failed to save message' }, { status: 500 });
  }
}
