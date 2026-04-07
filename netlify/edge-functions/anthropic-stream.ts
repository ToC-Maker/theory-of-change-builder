async function hashIP(ip: string): Promise<string> {
  const salt = Deno.env.get('IP_HASH_SALT');
  if (!salt) throw new Error('IP_HASH_SALT environment variable must be set');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * Wraps an SSE stream with periodic keepalive comments to prevent
 * Cloudflare's ~60s QUIC max_idle_timeout from killing long-running
 * responses. SSE comment lines (`: keepalive`) are ignored by
 * EventSource parsers and the client's manual line parser.
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
  });

  return source.pipeThrough(transform);
}

export default async (request: Request) => {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Only allow POST requests
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  // Detect retry request for HTTP/2 fallback (parsed early so error
  // responses can also include Alt-Svc: clear when appropriate)
  const requestUrl = new URL(request.url);
  const forceH2 = requestUrl.searchParams.get('force-h2') === '1';

  // Get the API key from environment variables
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');

  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'API key not configured on server' }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          ...(forceH2 ? { 'Alt-Svc': 'clear' } : {}),
        }
      }
    );
  }

  try {
    // Parse the request body
    const body = await request.json();

    // Set metadata.user_id server-side (never trust client-provided value)
    // Note: JWT is decoded but not signature-verified. A malicious user could forge
    // a sub claim to misattribute usage in Anthropic's abuse tracking, but this is
    // not used for authorization. Full JWKS verification would add ~100-200ms latency
    // per request (edge functions can't cache across invocations).
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
          || 'unknown';
        userId = `anon-${await hashIP(ip)}`;
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

    // If the response is not OK, return the error
    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic API error:', errorText);
      return new Response(errorText, {
        status: response.status,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
          ...(forceH2 ? { 'Alt-Svc': 'clear' } : {}),
        },
      });
    }

    // Stream the response back to the client
    // Note: Connection: keep-alive is a hop-by-hop header forbidden in HTTP/2+
    // (RFC 9113 §8.2.2, RFC 9114 §4.2); it caused ERR_QUIC_PROTOCOL_ERROR
    // when Cloudflare proxied the response over HTTP/3.
    // X-Accel-Buffering: no prevents reverse proxy buffering of the SSE stream.
    const responseHeaders: Record<string, string> = {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    };
    if (forceH2) {
      // Tell browser to stop using HTTP/3 for this origin (RFC 7838)
      responseHeaders['Alt-Svc'] = 'clear';
    }

    // Wrap stream with keepalive comments to prevent Cloudflare's
    // ~60s QUIC idle timeout from killing long-running responses.
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
          ...corsHeaders,
          'Content-Type': 'application/json',
          ...(forceH2 ? { 'Alt-Svc': 'clear' } : {}),
        }
      }
    );
  }
};

export const config = {
  path: '/api/anthropic-stream'
};
