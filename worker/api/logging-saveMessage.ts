import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { isUserOptedOut } from '../_shared/logging-optout';

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
  // Reject oversized payloads (content max 1MB + overhead — matches the
  // snapshot payload ceiling). If Claude accepted a user paste via
  // anthropic-stream, we should be able to log it too.
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 1_100_000) {
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
      return Response.json({ error: 'Invalid role. Must be "user" or "assistant"' }, { status: 400 });
    }

    // Content must be a non-empty string. The client sends the raw
    // pre-cleaned model output (including any [EDIT_INSTRUCTIONS] or
    // other markers), so a zero-length body here means the stream
    // aborted before any content arrived — a failure mode worth
    // rejecting loudly rather than recording as an empty row.
    if (typeof data.content !== 'string' || data.content.length === 0) {
      return Response.json({ error: 'content must be a non-empty string' }, { status: 400 });
    }

    if (new TextEncoder().encode(data.content).length > 1_000_000) {
      return Response.json({ error: 'content exceeds 1MB limit' }, { status: 413 });
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
        console.error('[logging-saveMessage] Token verification failed:', err);
        return Response.json({ error: 'Token verification failed' }, { status: 401 });
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
};
