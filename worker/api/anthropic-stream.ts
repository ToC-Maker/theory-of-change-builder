import type { Env } from '../_shared/types';

async function hashIP(ip: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Wraps an SSE stream with periodic keepalive comments to prevent idle
 * timeouts from killing long-running responses. Originally needed for
 * Cloudflare's ~60s QUIC max_idle_timeout when proxied via HTTP/3; still
 * valuable for client-facing H3 connections even when running on Workers.
 * SSE comment lines (`: keepalive`) are ignored by EventSource parsers
 * and the client's manual line parser.
 */
function createKeepaliveStream(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  intervalMs = 25000
): ReadableStream<Uint8Array> {
  const keepaliveBytes = new TextEncoder().encode(': keepalive\n\n');
  let intervalId: ReturnType<typeof setInterval>;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      intervalId = setInterval(() => {
        try {
          controller.enqueue(keepaliveBytes);
        } catch {
          // Controller closed, clean up
          clearInterval(intervalId);
        }
      }, intervalMs);

      signal.addEventListener('abort', () => clearInterval(intervalId));
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      clearInterval(intervalId);
    },
    cancel() {
      clearInterval(intervalId);
    },
  });

  return source.pipeThrough(transform);
}

export async function handler(request: Request, env: Env): Promise<Response> {
  // HTTP/2 fallback: when SSE streaming fails over HTTP/3 (QUIC), the client
  // retries with ?force-h2=1. The response includes Alt-Svc: clear (RFC 7838)
  // to tell the browser to stop using H3 for this origin.
  const requestUrl = new URL(request.url);
  const forceH2 = requestUrl.searchParams.get('force-h2') === '1';
  const altSvcHeaders: Record<string, string> = forceH2 ? { 'Alt-Svc': 'clear' } : {};

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'API key not configured on server' },
      { status: 500, headers: altSvcHeaders }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: 'Invalid JSON in request body' },
      { status: 400, headers: altSvcHeaders }
    );
  }

  try {
    // Set metadata.user_id server-side (never trust client-provided value).
    // JWT is decoded but not signature-verified; full JWKS verification adds
    // ~100-200ms on cold starts (near-zero when the JWKS cache is warm, but
    // this endpoint doesn't need verified identity). Only used for Anthropic's
    // per-user abuse tracking metadata, not for authorization.
    let userId: string | null = null;
    const authHeader = request.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const b64url = authHeader.slice(7).split('.')[1];
        const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(b64));
        if (payload.sub) userId = payload.sub;
      } catch (e) {
        console.warn('Failed to decode JWT for user_id:', e);
      }
    }
    if (!userId) {
      try {
        // cf-connecting-ip is authoritative and unforgeable on Cloudflare Workers;
        // x-forwarded-for and x-real-ip are client-spoofable fallbacks.
        const ip = request.headers.get('cf-connecting-ip')
          || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          || request.headers.get('x-real-ip')
          || 'unknown';
        userId = `anon-${await hashIP(ip, env.IP_HASH_SALT)}`;
      } catch (e) {
        console.error('Failed to hash IP for anonymous user tracking:', e);
        userId = 'anon-unknown';
      }
    }

    // Log client disconnects for transport-layer debugging
    request.signal.addEventListener('abort', () => {
      console.log(JSON.stringify({
        event: 'client_disconnect',
        timestamp: new Date().toISOString(),
        userId,
      }));
    });

    body.metadata = { user_id: userId };

    // Forward the request to Anthropic API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic API error:', errorText);
      return new Response(errorText, {
        status: response.status,
        headers: { 'Content-Type': 'application/json', ...altSvcHeaders },
      });
    }

    if (!response.body) {
      return Response.json(
        { error: 'AI service returned empty response' },
        { status: 502, headers: altSvcHeaders }
      );
    }

    // Stream the response back to the client
    const responseHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      ...altSvcHeaders,
    };

    return new Response(createKeepaliveStream(response.body, request.signal), {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return Response.json(
      {
        error: 'Failed to process request',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500, headers: altSvcHeaders }
    );
  }
};
