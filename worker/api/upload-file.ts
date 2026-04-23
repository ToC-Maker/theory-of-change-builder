import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken } from '../_shared/auth';
import { FILE_UPLOAD_LIMIT_BYTES } from '../_shared/tiers';
import { resolveAnonActor } from '../_shared/anon-id';
import { ANTHROPIC_PDF_PAGE_LIMIT } from '../../shared/anthropic-limits';

// TC39 typed-array base64 methods (stage 4 / in V8 12.8+, Workerd runs V8
// 14+). TypeScript's lib definitions don't include them yet, so augment
// `Uint8Array` here rather than casting at each call site. Narrow to only
// the methods we actually use.
declare global {
  interface Uint8Array {
    toBase64(): string;
  }
}

// Auth0 sub if the token verifies, otherwise the cookie-pinned anon id
// (hmac-of-IP, migrated on IP change). setCookie is the Set-Cookie header
// value to echo on the response when the resolver minted or rewrote the
// cookie.
async function resolveActorId(
  request: Request,
  env: Env,
  sql: ReturnType<typeof getDb>,
): Promise<{ userId: string; setCookie?: string }> {
  const token = extractToken(request.headers.get('authorization'));
  if (token) {
    try {
      const decoded = await verifyToken(token, env);
      return { userId: decoded.sub };
    } catch (err) {
      // Invalid token — fall through to anon. anthropic-stream.ts takes the
      // same posture: a bad token silently drops us into anon tracking, rather
      // than hard-failing the upload.
      console.warn('[upload-file] Token verification failed, falling back to anon:', err);
    }
  }

  try {
    const resolved = await resolveAnonActor(request, env, sql);
    return { userId: resolved.userId, setCookie: resolved.setCookieHeader };
  } catch (err) {
    console.error('[upload-file] Failed to resolve anon actor:', err);
    return { userId: 'anon-unknown' };
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

  const sql = getDb(env);
  const { userId, setCookie: anonSetCookie } = await resolveActorId(request, env, sql);

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

  // Count tokens precisely while we still have the bytes in memory. Anthropic's
  // count_tokens accepts DocumentBlockParam with Base64PDFSource but NOT the
  // file_id source variant, so once we finish this request we can't re-derive
  // the token count — Anthropic also won't let us download files we uploaded.
  // Stored on chart_files.input_tokens; downstream estimators (composer,
  // preflight, polling) sum this column instead of a pageCount heuristic.
  //
  // Only attempted for PDFs; for other mime types the document block isn't
  // applicable. NULL in the DB means "not counted" and the downstream UI
  // treats as 0. Failure path logs a DiagnosticCountTokensAtUploadFailed
  // row to logging_errors so we can see why — preview deploys have no log
  // stream.
  let inputTokens: number | null = null;
  let countTokensFailure: { reason: string; detail?: string; http_status?: number } | null = null;
  if (mimeType === 'application/pdf') {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const b64 = bytes.toBase64();
      const countResp = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'files-api-2025-04-14',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-7',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: { type: 'base64', media_type: 'application/pdf', data: b64 },
                },
              ],
            },
          ],
        }),
      });
      if (countResp.ok) {
        const data = await countResp.json() as { input_tokens?: number };
        if (typeof data.input_tokens === 'number' && data.input_tokens >= 0) {
          inputTokens = data.input_tokens;
        } else {
          countTokensFailure = { reason: 'unexpected_response_shape', detail: JSON.stringify(data).slice(0, 300) };
        }
      } else {
        const body = await countResp.text().catch(() => '');
        countTokensFailure = {
          reason: 'upstream_error',
          http_status: countResp.status,
          detail: body.slice(0, 500),
        };
        console.warn(
          `[upload-file] count_tokens failed at upload (status=${countResp.status}): ${body.slice(0, 300)}`,
        );
        // Anthropic rejects PDFs over ANTHROPIC_PDF_PAGE_LIMIT here AND
        // in /v1/messages, so a file that fails count_tokens for this
        // reason is permanently unusable. Delete the orphan from the
        // Files API and fail the upload with a user-facing error, rather
        // than leaving a dead file_id on the account. The error message
        // shape comes from Anthropic directly ("A maximum of NNN PDF
        // pages may be provided.") so we match on the stable phrase.
        if (countResp.status === 400 && /PDF pages may be provided/i.test(body)) {
          try {
            await fetch(`https://api.anthropic.com/v1/files/${fileId}`, {
              method: 'DELETE',
              headers: {
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'files-api-2025-04-14',
              },
            });
          } catch (delErr) {
            console.warn('[upload-file] Failed to delete orphaned file_id after page-limit rejection:', delErr);
          }
          const headersOut = new Headers({ 'content-type': 'application/json' });
          if (anonSetCookie) headersOut.append('Set-Cookie', anonSetCookie);
          return new Response(
            JSON.stringify({
              error: 'pdf_too_many_pages',
              upstream_message: `Anthropic limits PDFs to ${ANTHROPIC_PDF_PAGE_LIMIT} pages per document. Please split this file into smaller sections.`,
            }),
            { status: 400, headers: headersOut },
          );
        }
      }
    } catch (err) {
      countTokensFailure = {
        reason: 'exception',
        detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      };
      console.warn('[upload-file] count_tokens attempt failed (non-fatal, continuing):', err);
    }
  }

  try {
    await sql`
      INSERT INTO chart_files (file_id, chart_id, user_id, filename, size_bytes, mime_type, input_tokens)
      VALUES (${fileId}, ${chartId}, ${userId}, ${filename}, ${sizeBytes}, ${mimeType}, ${inputTokens})
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

  // Persist count_tokens failure (if any) to logging_errors so we can see
  // from DB why a file is landing with NULL input_tokens. Preview deploys
  // have no log stream; this is our only signal. Runs after the chart_files
  // insert so the row exists for the FK.
  if (countTokensFailure) {
    try {
      await sql`
        INSERT INTO logging_errors (
          error_id, error_name, error_message, http_status, user_id, chart_id,
          request_metadata
        )
        VALUES (
          ${crypto.randomUUID()},
          'DiagnosticCountTokensAtUploadFailed',
          ${`count_tokens failed at upload: ${countTokensFailure.reason}${countTokensFailure.detail ? ` — ${countTokensFailure.detail}` : ''}`},
          ${countTokensFailure.http_status ?? null},
          ${userId},
          ${chartId},
          ${JSON.stringify({
            reason: countTokensFailure.reason,
            http_status: countTokensFailure.http_status,
            detail: countTokensFailure.detail,
            file_id: fileId,
            size_bytes: sizeBytes,
            filename,
            deployment_host: new URL(request.url).hostname,
          })}
        )
        ON CONFLICT (error_id) DO NOTHING
      `;
    } catch (logErr) {
      console.error('[upload-file] failed to log count_tokens diagnostic:', logErr);
    }
  }

  const headers = new Headers({ 'content-type': 'application/json' });
  if (anonSetCookie) headers.append('Set-Cookie', anonSetCookie);
  return new Response(
    JSON.stringify({
      file_id: fileId,
      filename,
      size_bytes: sizeBytes,
      mime_type: mimeType,
      input_tokens: inputTokens,
    }),
    { status: 200, headers },
  );
}
