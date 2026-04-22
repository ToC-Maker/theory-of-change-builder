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
  // Client signal for legitimate empty-after-cleaning assistant content.
  // Values:
  //   'edit_instructions' — model emitted a valid [EDIT_INSTRUCTIONS] block
  //     that parsed to non-empty edits; the block was stripped for display
  //     but the edits live in logging_snapshots.edit_instructions.
  //   'stripped_other' — raw reply was non-empty but cleanResponseContent
  //     stripped everything (e.g. model hallucinated [CURRENT_GRAPH_DATA]
  //     or [SELECTED_NODES], or emitted a malformed EDIT_INSTRUCTIONS
  //     block that failed to parse). Row kept so we can audit bad outputs.
  content_strip_reason?: 'edit_instructions' | 'stripped_other';
}

export async function handler(request: Request, env: Env): Promise<Response> {
  // Reject oversized payloads (content max 100KB + overhead)
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 200_000) {
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

    // Content must be a string. Empty strings are rejected UNLESS it's an
    // assistant message whose raw reply was stripped to "" for a declared
    // reason (currently only 'edit_instructions' — model replied with only
    // an [EDIT_INSTRUCTIONS] block). The row is kept so
    // logging_snapshots.triggered_by_message_id FKs resolve; the edit
    // payload lives in logging_snapshots.edit_instructions, not here.
    if (typeof data.content !== 'string') {
      return Response.json({ error: 'content must be a string' }, { status: 400 });
    }
    if (data.content.length === 0) {
      if (data.role === 'user') {
        return Response.json({ error: 'user messages require non-empty content' }, { status: 400 });
      }
      if (
        data.content_strip_reason !== 'edit_instructions' &&
        data.content_strip_reason !== 'stripped_other'
      ) {
        return Response.json(
          { error: 'empty assistant content requires content_strip_reason' },
          { status: 400 },
        );
      }
    }

    if (new TextEncoder().encode(data.content).length > 100_000) {
      return Response.json({ error: 'content exceeds 100KB limit' }, { status: 413 });
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
