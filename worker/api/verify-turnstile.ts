import type { Env } from '../_shared/types';
import {
  signTurnstileCookie,
  verifyTurnstileCookie,
  extractTurnstileCookie,
} from '../_shared/turnstile-cookie';
import { hashIP, extractIP } from '../_shared/anon-id';

// POST /api/verify-turnstile — validates a Turnstile response token against
// Cloudflare's siteverify API, then issues an HMAC-signed session cookie bound
// to the caller's anon_id (hmac(cf-connecting-ip, IP_HASH_SALT)). The cookie
// is later checked by /api/anthropic-stream to satisfy the anon-tier bot gate
// without re-challenging Turnstile on every streamed request.
//
// GET /api/verify-turnstile — returns {valid: boolean} based on whether the
// caller's existing tocb_anon cookie still verifies against the current IP.
// Used by the client on mount so a returning visitor with a still-valid cookie
// doesn't have to re-solve the widget.

export async function handler(request: Request, env: Env): Promise<Response> {
  if (!env.TURNSTILE_SECRET_KEY) {
    return Response.json({ error: 'turnstile_not_configured' }, { status: 501 });
  }

  if (request.method === 'GET') {
    const cookieValue = extractTurnstileCookie(request.headers.get('cookie'));
    if (!cookieValue) return Response.json({ valid: false });
    try {
      const expectedAnonId = await hashIP(extractIP(request), env.IP_HASH_SALT);
      const status = await verifyTurnstileCookie(cookieValue, expectedAnonId, env.IP_HASH_SALT);
      return Response.json({ valid: status === 'ok' });
    } catch (err) {
      console.error('[verify-turnstile] status check failed:', err);
      return Response.json({ valid: false });
    }
  }

  let body: { token?: unknown };
  try {
    body = await request.json() as { token?: unknown };
  } catch {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  const token = body.token;
  if (typeof token !== 'string' || !token) {
    return Response.json({ error: 'missing_token' }, { status: 400 });
  }

  const ip = extractIP(request);

  // Cloudflare's siteverify expects application/x-www-form-urlencoded with
  // `secret`, `response`, and optional `remoteip`. URLSearchParams auto-encodes.
  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', token);
  form.set('remoteip', ip);

  let verifyResp: Response;
  try {
    verifyResp = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      },
    );
  } catch (err) {
    console.error('[verify-turnstile] siteverify fetch failed:', err);
    return Response.json({ error: 'turnstile_failed' }, { status: 401 });
  }

  let result: { success?: boolean; 'error-codes'?: string[] };
  try {
    result = await verifyResp.json() as typeof result;
  } catch (err) {
    console.error('[verify-turnstile] siteverify JSON parse failed:', err);
    return Response.json({ error: 'turnstile_failed' }, { status: 401 });
  }

  if (!result.success) {
    return Response.json({ error: 'turnstile_failed' }, { status: 401 });
  }

  // Bind the cookie to the raw IP-hash. `anthropic-stream.ts` recomputes
  // the same raw hash (no `anon-` prefix) and checks equality; adding a
  // prefix here would fail every verify and re-challenge the widget on
  // each request.
  const anonId = await hashIP(ip, env.IP_HASH_SALT);
  const cookieValue = await signTurnstileCookie(anonId, env.IP_HASH_SALT, 86400);

  const headers = new Headers({ 'content-type': 'application/json' });
  headers.append(
    'Set-Cookie',
    `tocb_anon=${cookieValue}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Lax`,
  );

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
