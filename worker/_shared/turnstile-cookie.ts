// HMAC-SHA256 signed session cookie bound to anon_id (hmac(cf-ip, salt)).
// Used by /api/verify-turnstile (sign) and /api/anthropic-stream (verify).

async function hmacSha256(key: string, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

function b64urlEncode(bytes: Uint8Array | string): string {
  const str = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): string {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

export const TURNSTILE_COOKIE_NAME = 'tocb_anon';

/**
 * Parse the Cookie header and extract the `tocb_anon` cookie value if present.
 * Returns null when the header is absent, the cookie is not set, or its value
 * is empty. Callers pass the result straight to `verifyTurnstileCookie`.
 */
export function extractTurnstileCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const needle = TURNSTILE_COOKIE_NAME + '=';
  for (const entry of cookieHeader.split(';')) {
    const trimmed = entry.trimStart();
    if (trimmed.startsWith(needle)) {
      const value = trimmed.slice(needle.length).trim();
      return value || null;
    }
  }
  return null;
}

/**
 * Lifetime of the `tocb_anon` Turnstile-session cookie.
 *
 * This cookie ONLY proves the visitor solved a Turnstile challenge — it is
 * not the cap-accounting identity. The anon user_id (key for
 * user_api_usage) lives in the separate `tocb_actor_id` cookie (1 year)
 * handled in `anon-id.ts`; that one is what preserves cumulative spend
 * across IP changes via the resolveAnonActor migration path.
 *
 * 24 hours is a deliberate abuse-resistance floor — a visitor trying to
 * sidestep the cap by rotating IPs has to re-solve the widget at least
 * daily. Longer cookie buys nothing for cap preservation (already pinned
 * by the actor cookie) and weakens the automation-resistance gate.
 */
export const TOCB_ANON_COOKIE_TTL_SECONDS = 24 * 60 * 60;

export async function signTurnstileCookie(
  anonId: string,
  salt: string,
  ttlSeconds: number = TOCB_ANON_COOKIE_TTL_SECONDS,
): Promise<string> {
  const payload = JSON.stringify({ anon_id: anonId, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  const payloadB64 = b64urlEncode(payload);
  const sigBytes = await hmacSha256(salt, payloadB64);
  const sigB64 = b64urlEncode(sigBytes);
  return `${payloadB64}.${sigB64}`;
}

export async function verifyTurnstileCookie(
  cookie: string | null,
  expectedAnonId: string,
  salt: string,
): Promise<'ok' | 'missing' | 'expired' | 'ip_mismatch' | 'invalid'> {
  if (!cookie) return 'missing';
  const parts = cookie.split('.');
  if (parts.length !== 2) return 'invalid';
  const [payloadB64, sigB64] = parts;
  const expectedSigBytes = await hmacSha256(salt, payloadB64);
  const expectedSigB64 = b64urlEncode(expectedSigBytes);
  // Constant-time comparison
  if (expectedSigB64.length !== sigB64.length) return 'invalid';
  let diff = 0;
  for (let i = 0; i < sigB64.length; i++) diff |= expectedSigB64.charCodeAt(i) ^ sigB64.charCodeAt(i);
  if (diff !== 0) return 'invalid';
  try {
    const payload = JSON.parse(b64urlDecode(payloadB64));
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return 'expired';
    if (payload.anon_id !== expectedAnonId) return 'ip_mismatch';
    return 'ok';
  } catch {
    return 'invalid';
  }
}
