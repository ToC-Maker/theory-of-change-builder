import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { FILE_UPLOAD_LIMIT_BYTES } from '../_shared/tiers';
import {
  resolveAnonActor,
  signAuthLinkCookie,
  buildAuthLinkCookieHeader,
} from '../_shared/anon-id';
import { ANTHROPIC_PDF_PAGE_LIMIT } from '../../shared/anthropic-limits';

// Skip count_tokens at upload for PDFs over this threshold. Anthropic's
// endpoint requires sending the full bytes base64-encoded, which would OOM
// a Workers isolate for a 100+ MB PDF (256 MB memory cap, and base64
// inflates by ~33% on top of the original). Rows with NULL input_tokens
// are handled by count-tokens-estimate.ts as "uncounted" and fall through
// to Anthropic's on-demand counting at send time.
const COUNT_TOKENS_SIZE_LIMIT_BYTES = 25 * 1024 * 1024;

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
): Promise<{ userId: string; setCookie?: string }> {
  const token = extractToken(request.headers.get('authorization'));
  if (token) {
    try {
      const decoded = await verifyToken(token, env);
      // Refresh tocb_auth_link so post-logout uploads attribute to this
      // same auth sub's cap row via resolveAnonActor's link-cookie path.
      const setCookie = buildAuthLinkCookieHeader(
        await signAuthLinkCookie(decoded.sub, env.IP_HASH_SALT),
      );
      return { userId: decoded.sub, setCookie };
    } catch (err) {
      // Invalid token — fall through to anon. anthropic-stream.ts takes the
      // same posture: a bad token silently drops us into anon tracking, rather
      // than hard-failing the upload.
      console.warn('[upload-file] Token verification failed, falling back to anon:', err);
    }
  }

  try {
    const resolved = await resolveAnonActor(request, env);
    return { userId: resolved.userId, setCookie: resolved.setCookieHeader };
  } catch (err) {
    console.error('[upload-file] Failed to resolve anon actor:', err);
    return { userId: 'anon-unknown' };
  }
}

export async function handler(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
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

  // Workers-types declares FormData.get as `string | null`, but the runtime
  // returns File instances per the Fetch spec. Cast through unknown and
  // narrow on the presence of `arrayBuffer` to be safe.
  const fileEntry = form.get('file') as unknown as File | string | null;
  if (!fileEntry || typeof fileEntry === 'string') {
    return Response.json({ error: 'missing_file' }, { status: 400 });
  }
  const file: File = fileEntry;

  // Authorization: mirror delete-file / chart-files posture.
  // - Owned chart -> require a valid JWT whose sub is the owner OR has an
  //   approved edit permission row.
  // - Anon chart (user_id IS NULL) -> require proof of the edit token
  //   (either X-Edit-Token header or edit_token form field). Previously
  //   anyone with a chart_id could upload, which could be abused to attach
  //   files to a victim's chart (cluttering their Files API usage + quota).
  {
    const authCheckSql = getDb(env);
    const chartRows = await authCheckSql`
      SELECT user_id, edit_token FROM charts WHERE id = ${chartId}
    ` as { user_id: string | null; edit_token: string }[];
    if (!chartRows.length) {
      return Response.json({ error: 'chart_not_found' }, { status: 404 });
    }
    const chartOwnerId = chartRows[0].user_id;
    const chartEditToken = chartRows[0].edit_token;

    if (chartOwnerId) {
      const token = extractToken(request.headers.get('authorization'));
      if (!token) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      let decoded;
      try {
        decoded = await verifyToken(token, env);
      } catch (err) {
        if (err instanceof JWKSFetchError) {
          return Response.json({ error: 'auth_unavailable' }, { status: 502 });
        }
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      if (decoded.sub !== chartOwnerId) {
        const perm = await authCheckSql`
          SELECT permission_level, status FROM chart_permissions
          WHERE chart_id = ${chartId} AND user_id = ${decoded.sub}
        ` as { permission_level: string; status: string }[];
        const ok = perm.length && (
          perm[0].permission_level === 'owner'
          || (perm[0].permission_level === 'edit' && perm[0].status === 'approved')
        );
        if (!ok) {
          return Response.json({ error: 'forbidden' }, { status: 403 });
        }
      }
    } else {
      const headerToken = request.headers.get('x-edit-token');
      const formTokenRaw = form.get('edit_token');
      const formToken = typeof formTokenRaw === 'string' ? formTokenRaw : null;
      const suppliedToken = headerToken || formToken;
      if (!suppliedToken || suppliedToken !== chartEditToken) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
    }
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
  const { userId, setCookie: anonSetCookie } = await resolveActorId(request, env);

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
    // Surface Anthropic's message so the client can render something
    // actionable (same shape as the pdf_too_many_pages path below).
    let upstreamMessage: string | undefined;
    try {
      const parsed = JSON.parse(errText) as { error?: { message?: string } };
      upstreamMessage = parsed?.error?.message;
    } catch {
      /* non-JSON body */
    }
    return Response.json(
      {
        error: 'anthropic_upload_failed',
        status: upstream.status,
        upstream_message: upstreamMessage,
      },
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
  // Skip count_tokens for PDFs over COUNT_TOKENS_SIZE_LIMIT_BYTES. Turning
  // a 100+ MB binary into base64 in RAM inside a Workers isolate (256 MB
  // memory cap) OOMs the request. Rows with NULL input_tokens are treated
  // as "uncounted" by count-tokens-estimate.ts; the client (Unit E) will
  // either re-probe or show a less-precise total for these files.
  if (mimeType === 'application/pdf' && file.size > COUNT_TOKENS_SIZE_LIMIT_BYTES) {
    countTokensFailure = {
      reason: 'skipped_large_pdf',
      detail: `file.size=${file.size} > ${COUNT_TOKENS_SIZE_LIMIT_BYTES}`,
    };
  } else if (mimeType === 'application/pdf') {
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
    // File is at Anthropic but not in our DB — we'd leak an orphan file_id
    // on every DB failure. Fire-and-forget a DELETE to Anthropic so the
    // orphan is cleaned up; ctx.waitUntil keeps the delete running after
    // we return the 500 to the client. We don't await it: the client
    // should see a fast error, not wait on Anthropic's DELETE latency.
    ctx.waitUntil(
      fetch(`https://api.anthropic.com/v1/files/${fileId}`, {
        method: 'DELETE',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'files-api-2025-04-14',
        },
      }).then(async (r) => {
        if (!r.ok && r.status !== 404) {
          console.error(
            `[upload-file] Anthropic rollback DELETE returned ${r.status} for file_id=${fileId}:`,
            await r.text().catch(() => ''),
          );
        }
      }).catch((delErr) => {
        console.error('[upload-file] Anthropic rollback DELETE fetch failed:', delErr);
      }),
    );
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`[upload-file] DB insert failed for file_id=${fileId}, chart_id=${chartId}:`, err);

    // Persist the exact PG error to logging_errors — preview deploys have
    // no log stream, so DB is our only signal. Try a separate INSERT; if
    // THAT fails too, at least the client gets the detail via
    // upstream_message below.
    try {
      await sql`
        INSERT INTO logging_errors (
          error_id, error_name, error_message, user_id, chart_id, request_metadata
        )
        VALUES (
          ${crypto.randomUUID()},
          'DiagnosticChartFileInsertFailed',
          ${`chart_files INSERT failed: ${detail}`},
          ${userId},
          ${chartId},
          ${JSON.stringify({
            file_id: fileId,
            filename,
            size_bytes: sizeBytes,
            mime_type: mimeType,
            input_tokens: inputTokens,
            deployment_host: new URL(request.url).hostname,
          })}
        )
        ON CONFLICT (error_id) DO NOTHING
      `;
    } catch (logErr) {
      console.error('[upload-file] failed to log chart_files insert diagnostic:', logErr);
    }

    const headersOut = new Headers({ 'content-type': 'application/json' });
    if (anonSetCookie) headersOut.append('Set-Cookie', anonSetCookie);
    return new Response(
      JSON.stringify({
        error: 'db_insert_failed',
        upstream_message: `Couldn't record the upload in our database: ${detail}`,
      }),
      { status: 500, headers: headersOut },
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
