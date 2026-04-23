import type { Env } from '../_shared/types';
import {
  signTurnstileCookie,
  verifyTurnstileCookie,
  extractTurnstileCookie,
  TOCB_ANON_COOKIE_TTL_SECONDS,
} from '../_shared/turnstile-cookie';
import { resolveAnonActor } from '../_shared/anon-id';

// POST /api/verify-turnstile — validates a Turnstile response token against
// Cloudflare's siteverify API, then issues an HMAC-signed session cookie bound
// to the caller's anon actor id. Identity is now cookie-pinned (stable UUID)
// rather than IP-hash, so moving IPs no longer invalidates the Turnstile
// session. First visits also receive a `tocb_actor_id` cookie so subsequent
// requests land on the same identity.
//
// GET /api/verify-turnstile — returns {valid: boolean} based on whether the
// caller's existing tocb_anon cookie still verifies against the resolved
// actor id. Used by the client on mount so a returning anon visitor with a
// still-valid cookie doesn't have to re-solve the widget.

function actorIdPayload(userId: string): string {
  // The Turnstile cookie payload stores the raw identity value (UUID or
  // IP hash). The `anon-` prefix is added for the user_api_usage key but
  // isn't part of the cookie binding.
  return userId.startsWith('anon-') ? userId.slice(5) : userId;
}

export async function handler(request: Request, env: Env): Promise<Response> {
  if (!env.TURNSTILE_SECRET_KEY) {
    return Response.json({ error: 'turnstile_not_configured' }, { status: 501 });
  }

  // Resolve the anon actor up front for both GET and POST. A first visit
  // (no tocb_actor_id cookie) yields a fresh UUID identity plus a
  // Set-Cookie we must echo on the response so the browser persists it.
  const actor = await resolveAnonActor(request, env);
  const anonId = actorIdPayload(actor.userId);

  const baseHeaders = new Headers({ 'content-type': 'application/json' });
  if (actor.setCookieHeader) baseHeaders.append('Set-Cookie', actor.setCookieHeader);

  if (request.method === 'GET') {
    const cookieValue = extractTurnstileCookie(request.headers.get('cookie'));
    if (!cookieValue) {
      return new Response(JSON.stringify({ valid: false }), { status: 200, headers: baseHeaders });
    }
    try {
      const status = await verifyTurnstileCookie(cookieValue, anonId, env.IP_HASH_SALT);
      return new Response(
        JSON.stringify({ valid: status === 'ok' }),
        { status: 200, headers: baseHeaders },
      );
    } catch (err) {
      console.error('[verify-turnstile] status check failed:', err);
      return new Response(JSON.stringify({ valid: false }), { status: 200, headers: baseHeaders });
    }
  }

  let body: { token?: unknown };
  try {
    body = await request.json() as { token?: unknown };
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON in request body' }),
      { status: 400, headers: baseHeaders },
    );
  }

  const token = body.token;
  if (typeof token !== 'string' || !token) {
    return new Response(
      JSON.stringify({ error: 'missing_token' }),
      { status: 400, headers: baseHeaders },
    );
  }

  // Cloudflare's siteverify still gets remoteip as an anti-abuse signal
  // even though we don't bind our cookie to it any longer.
  const remoteIp =
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    '';

  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', token);
  if (remoteIp) form.set('remoteip', remoteIp);

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
    return new Response(
      JSON.stringify({ error: 'turnstile_failed' }),
      { status: 401, headers: baseHeaders },
    );
  }

  let result: { success?: boolean; 'error-codes'?: string[] };
  try {
    result = await verifyResp.json() as typeof result;
  } catch (err) {
    console.error('[verify-turnstile] siteverify JSON parse failed:', err);
    return new Response(
      JSON.stringify({ error: 'turnstile_failed' }),
      { status: 401, headers: baseHeaders },
    );
  }

  if (!result.success) {
    return new Response(
      JSON.stringify({ error: 'turnstile_failed' }),
      { status: 401, headers: baseHeaders },
    );
  }

  const cookieValue = await signTurnstileCookie(
    anonId,
    env.IP_HASH_SALT,
    TOCB_ANON_COOKIE_TTL_SECONDS,
  );

  const headers = new Headers(baseHeaders);
  headers.append(
    'Set-Cookie',
    `tocb_anon=${cookieValue}; Path=/; Max-Age=${TOCB_ANON_COOKIE_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`,
  );

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}
