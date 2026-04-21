import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken } from '../_shared/auth';
import { FILE_UPLOAD_LIMIT_BYTES } from '../_shared/tiers';
import { anonIdFor } from '../_shared/anon-id';

// Auth0 sub if the token verifies, otherwise the shared anon-id shape.
async function resolveActorId(request: Request, env: Env): Promise<string> {
  const token = extractToken(request.headers.get('authorization'));
  if (token) {
    try {
      const decoded = await verifyToken(token, env);
      return decoded.sub;
    } catch (err) {
      // Invalid token — fall through to anon. anthropic-stream.ts takes the
      // same posture: a bad token silently drops us into anon tracking, rather
      // than hard-failing the upload.
      console.warn('[upload-file] Token verification failed, falling back to anon:', err);
    }
  }

  try {
    return await anonIdFor(request, env.IP_HASH_SALT);
  } catch (err) {
    console.error('[upload-file] Failed to hash IP:', err);
    return 'anon-unknown';
  }
}

export async function handler(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch (err) {
    console.error('[upload-file] Failed to parse multipart body:', err);
    return Response.json({ error: 'Invalid multipart form data' }, { status: 400 });
  }

  const chartId = form.get('chart_id');
  if (typeof chartId !== 'string' || !chartId) {
    return Response.json({ error: 'missing_chart_id' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return Response.json({ error: 'missing_file' }, { status: 400 });
  }

  // Hard size clamp before we hand bytes to Anthropic. Workers enforces its
  // own request-body ceiling (100 MB on standard plans), but checking here
  // returns a structured error payload instead of a transport-layer failure.
  //
  // NOTE: per-PDF page count is NOT enforced here. Server-side pdfjs parsing
  // in a Worker is memory-bounded and fragile on corrupted inputs; Anthropic
  // itself caps pages upstream, which is sufficient.
  if (file.size > FILE_UPLOAD_LIMIT_BYTES) {
    return Response.json(
      { error: 'file_too_large', limit_bytes: FILE_UPLOAD_LIMIT_BYTES },
      { status: 400 }
    );
  }

  // BYOK pass-through: a user-supplied key takes precedence over the server key.
  // Sent via X-User-Anthropic-Key header (separate from the Authorization
  // header, which carries the Auth0 JWT).
  const userKey = request.headers.get('x-user-anthropic-key');
  const apiKey = userKey || env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'API key not configured' }, { status: 500 });
  }

  const userId = await resolveActorId(request, env);

  // Forward the file to Anthropic. We rebuild the FormData rather than piping
  // the original — Workers' FormData instance is single-use (consumed above)
  // and we want control over the outbound field name.
  //
  // Crucial: do NOT set Content-Type manually. fetch() computes the multipart
  // boundary from the FormData and emits the correct header; overriding it
  // would break the upstream parser.
  const outbound = new FormData();
  outbound.append('file', file, file.name);

  let upstream: Response;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/files', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
      },
      body: outbound,
    });
  } catch (err) {
    console.error('[upload-file] Upstream fetch failed:', err);
    return Response.json(
      { error: 'anthropic_upload_failed', status: 502 },
      { status: 502 }
    );
  }

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    console.error(
      `[upload-file] Anthropic rejected upload (status=${upstream.status}): ${errText}`
    );
    return Response.json(
      { error: 'anthropic_upload_failed', status: upstream.status },
      { status: 502 }
    );
  }

  let upstreamJson: {
    id?: string;
    filename?: string;
    mime_type?: string;
    size_bytes?: number;
  };
  try {
    upstreamJson = await upstream.json() as typeof upstreamJson;
  } catch (err) {
    console.error('[upload-file] Failed to parse Anthropic response:', err);
    return Response.json(
      { error: 'anthropic_upload_failed', status: 502 },
      { status: 502 }
    );
  }

  const fileId = upstreamJson.id;
  if (!fileId) {
    console.error('[upload-file] Anthropic response missing file id:', upstreamJson);
    return Response.json(
      { error: 'anthropic_upload_failed', status: 502 },
      { status: 502 }
    );
  }

  const filename = upstreamJson.filename ?? file.name;
  const mimeType = upstreamJson.mime_type ?? file.type ?? 'application/octet-stream';
  const sizeBytes = upstreamJson.size_bytes ?? file.size;

  try {
    const sql = getDb(env);
    await sql`
      INSERT INTO chart_files (file_id, chart_id, user_id, filename, size_bytes, mime_type)
      VALUES (${fileId}, ${chartId}, ${userId}, ${filename}, ${sizeBytes}, ${mimeType})
    `;
  } catch (err) {
    // File already uploaded at Anthropic but DB insert failed. We can't roll
    // back the Anthropic side cleanly from here (it would double the latency
    // and another ctx.waitUntil on a FK-bound row isn't safe). Log loudly so
    // orphan-cleanup sweeps can catch it; the user-facing upload still failed.
    console.error(`[upload-file] DB insert failed for file_id=${fileId}, chart_id=${chartId}:`, err);
    return Response.json(
      { error: 'db_insert_failed' },
      { status: 500 }
    );
  }

  return Response.json({
    file_id: fileId,
    filename,
    size_bytes: sizeBytes,
    mime_type: mimeType,
  });
}
