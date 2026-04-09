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
 * Wraps an SSE stream with periodic keepalive comments to prevent
 * idle timeout from killing long-running responses. SSE comment lines
 * (`: keepalive`) are ignored by EventSource parsers and the client's
 * manual line parser.
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

  // Detect retry request for HTTP/2 fallback
  const requestUrl = new URL(request.url);
  const forceH2 = requestUrl.searchParams.get('force-h2') === '1';

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'API key not configured on server' }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...(forceH2 ? { 'Alt-Svc': 'clear' } : {}),
        }
      }
    );
  }

  try {
    const body = await request.json() as Record<string, unknown>;

    // Set metadata.user_id server-side (never trust client-provided value)
    // Note: JWT is decoded but not signature-verified here. Full JWKS verification
    // would add ~100-200ms latency per request. This is only used for Anthropic's
    // abuse tracking metadata, not for authorization.
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
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          || request.headers.get('x-real-ip')
          || request.headers.get('cf-connecting-ip')
          || 'unknown';
        userId = `anon-${await hashIP(ip, env.IP_HASH_SALT)}`;
      } catch {
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
        headers: {
          'Content-Type': 'application/json',
          ...(forceH2 ? { 'Alt-Svc': 'clear' } : {}),
        },
      });
    }

    // Stream the response back to the client
    const responseHeaders: Record<string, string> = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    };
    if (forceH2) {
      responseHeaders['Alt-Svc'] = 'clear';
    }

    return new Response(createKeepaliveStream(response.body!, request.signal), {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'Failed to process request',
        details: error instanceof Error ? error.message : 'Unknown error'
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          ...(forceH2 ? { 'Alt-Svc': 'clear' } : {}),
        }
      }
    );
  }
};
