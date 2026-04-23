import type { NeonQueryFunction } from '@neondatabase/serverless';

// Shared anonymous-actor identity helpers.
//
// Anonymous users are identified by `anon-<id>` where <id> is a random
// UUIDv4 persisted in a first-party `tocb_actor_id` cookie. Identity is
// strictly per-browser — an actor row is created the first time the
// cookie is missing, and re-used every visit after. Clearing cookies
// produces a fresh identity with a fresh cap. Two users behind the same
// NAT / CGNAT / corporate IP each get their own cap (each browser has
// its own cookie).
//
// Rationale for dropping the previous IP-derived scheme:
//   - Shared IPs are very common (office NAT, campus wifi, CGNAT, VPNs),
//     and lumping every visitor behind the same public IP into a shared
//     $5 cap meant colleagues at the same org would lock each other out.
//   - The only thing the IP tie added was an anti-abuse floor against
//     cookie-clearing. Turnstile still gates bots, and the Anthropic
//     Console monthly cap is the authoritative damage ceiling. A human
//     who manually clears cookies repeatedly still has to solve a
//     Turnstile for each reset — not a cheap attack.
//
// Cookie precedence in resolveAnonActor:
//   1. `tocb_auth_link` valid → return the linked auth sub (closes the
//      "log out to reset cap" path after a prior sign-in on this browser).
//   2. `tocb_actor_id` valid → return `anon-<cookie-value>`.
//   3. Neither → mint a fresh UUID, return `anon-<uuid>` + Set-Cookie.
//
// Keep derivation identical across every call site — any drift means
// the same user looks like different actors to different endpoints.

export const ACTOR_COOKIE_NAME = 'tocb_actor_id';
/** 1 year — effectively permanent for a browser profile. */
export const ACTOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** UUIDv4 string. Any other shape (including the pre-Policy-B IP-hash hex)
 * is rejected so we mint a fresh UUID instead. Only preview-branch testing
 * ever produced the legacy format, so no real users get reset by this. */
function isValidActorId(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
}

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const needle = name + '=';
  for (const entry of cookieHeader.split(';')) {
    const trimmed = entry.trimStart();
    if (trimmed.startsWith(needle)) {
      const value = trimmed.slice(needle.length).trim();
      return value || null;
    }
  }
  return null;
}

export async function hashIP(ip: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function extractIP(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

/**
 * Legacy one-shot anon-id helper (IP hash only). Retained for one or two
 * endpoints that still want a plain identity without cookie semantics;
 * new code should prefer `resolveAnonActor`.
 */
export async function anonIdFor(request: Request, salt: string): Promise<string> {
  return `anon-${await hashIP(extractIP(request), salt)}`;
}

export type AnonActorResolution = {
  /** The `anon-*` user_id to attribute usage / cap checks / Turnstile against. */
  userId: string;
  /**
   * Set when this request did not present a valid actor cookie. Caller
   * should append as a Set-Cookie header on the outbound Response so the
   * browser persists the identity.
   */
  setCookieHeader?: string;
};

function buildCookieHeader(value: string): string {
  return `${ACTOR_COOKIE_NAME}=${value}; Path=/; Max-Age=${ACTOR_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Lax`;
}

/**
 * Resolve the anonymous actor for a request.
 *
 *   1. If a valid `tocb_auth_link` cookie is present, the browser has
 *      previously been signed in as an auth user — resolve to that sub
 *      so post-logout anon traffic still attributes to the same cap row.
 *      Closes the "log out to reset cap" path.
 *   2. Else if a valid `tocb_actor_id` cookie is present (UUID or legacy
 *      hex), resolve to `anon-<cookie-value>`.
 *   3. Else mint a fresh UUID, return `anon-<uuid>` plus a Set-Cookie
 *      header the caller should append to the outbound response.
 *
 * No sql parameter — the old migration path (`anon-<hash>` →
 * `anon-<hash>` on IP change) was dropped along with the IP-derived
 * cookie scheme. Callers can stop threading their db handle through.
 */
export async function resolveAnonActor(
  request: Request,
  env: { IP_HASH_SALT: string },
): Promise<AnonActorResolution> {
  const cookieHeader = request.headers.get('cookie');

  // (1) Auth-link cookie wins — this browser was authenticated before
  // and we want the cap to follow, even after sign-out.
  const linkCookie = readCookie(cookieHeader, AUTH_LINK_COOKIE_NAME);
  if (linkCookie) {
    const linked = await verifyAuthLinkCookie(linkCookie, env.IP_HASH_SALT);
    if (linked) return { userId: linked };
  }

  // (2) Existing actor cookie.
  const existing = readCookie(cookieHeader, ACTOR_COOKIE_NAME);
  if (existing && isValidActorId(existing)) {
    return { userId: `anon-${existing}` };
  }

  // (3) Fresh visit (no cookies / garbage cookie) → new identity.
  const fresh = crypto.randomUUID();
  return {
    userId: `anon-${fresh}`,
    setCookieHeader: buildCookieHeader(fresh),
  };
}

/**
 * On an authenticated request that still carries the anon `tocb_actor_id`
 * cookie, fold any outstanding `anon-<hash>` `user_api_usage` row into the
 * authenticated user's row, then delete the anon row.
 *
 * Idempotent: after the first successful merge the anon row is gone, so
 * subsequent calls INSERT…SELECT nothing and DELETE matches nothing.
 *
 * Closes the "sign in to reset the anon cap" loophole — without this a
 * user could spend $4.99 as anon, sign in, and immediately get a fresh
 * $5 quota because the authenticated identity started with no row.
 *
 * Non-fatal on error: the reservation path in anthropic-stream still runs
 * against whatever user_id we were handed, so a failed merge just means
 * the anon spend stays orphaned rather than crediting into the auth cap.
 */
export async function mergeAnonUsageIntoAuth(
  sql: NeonQueryFunction<false, false>,
  authUserId: string,
  request: Request,
): Promise<void> {
  const existing = readCookie(request.headers.get('cookie'), ACTOR_COOKIE_NAME);
  if (!existing || !isValidActorId(existing)) return;
  const anonUserId = `anon-${existing}`;

  try {
    await sql.transaction([
      // INSERT … SELECT is a no-op when the anon row doesn't exist, so the
      // common post-first-login case (already merged) pays one empty INSERT
      // plus one empty DELETE — no separate existence probe needed.
      sql`INSERT INTO user_api_usage (user_id, input_tokens, output_tokens, cache_create_tokens,
                                      cache_read_tokens, web_search_uses, cost_micro_usd,
                                      first_activity_at, last_activity_at)
          SELECT ${authUserId}, input_tokens, output_tokens, cache_create_tokens,
                 cache_read_tokens, web_search_uses, cost_micro_usd,
                 first_activity_at, last_activity_at
          FROM user_api_usage WHERE user_id = ${anonUserId}
          ON CONFLICT (user_id) DO UPDATE SET
            input_tokens        = user_api_usage.input_tokens + EXCLUDED.input_tokens,
            output_tokens       = user_api_usage.output_tokens + EXCLUDED.output_tokens,
            cache_create_tokens = user_api_usage.cache_create_tokens + EXCLUDED.cache_create_tokens,
            cache_read_tokens   = user_api_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
            web_search_uses     = user_api_usage.web_search_uses + EXCLUDED.web_search_uses,
            cost_micro_usd      = user_api_usage.cost_micro_usd + EXCLUDED.cost_micro_usd,
            first_activity_at   = LEAST(user_api_usage.first_activity_at, EXCLUDED.first_activity_at),
            last_activity_at    = GREATEST(user_api_usage.last_activity_at, EXCLUDED.last_activity_at)`,
      sql`DELETE FROM user_api_usage WHERE user_id = ${anonUserId}`,
    ]);
  } catch (e) {
    console.error('[mergeAnonUsageIntoAuth] merge failed (non-fatal):', e);
  }
}

// --- tocb_auth_link cookie -------------------------------------------------
//
// Server-signed cookie that remembers "this browser has been signed in as
// <auth_sub>." Minted on every successful JWT verification (refresh each
// time to keep it alive) and consumed by resolveAnonActor so a post-logout
// request still resolves to the auth sub's `user_api_usage` row — cap stays
// put across sign-out, just like the anon cookie survives a sign-in via
// mergeAnonUsageIntoAuth.
//
// Format mirrors tocb_anon (the Turnstile session cookie): HMAC-SHA256 of
// the base64url(payload) using env.IP_HASH_SALT as the signing key, payload
// = JSON {sub, exp}. Verified constant-time. HttpOnly + Secure +
// SameSite=Lax.
//
// Trust model: a valid auth-link cookie is treated as proof of identity for
// cap attribution only — NOT for BYOK, not for permission checks, not as a
// substitute for a JWT anywhere else. Reading the cap row under someone
// else's sub is the maximum leak if an attacker were to forge one, and the
// HMAC makes forging infeasible without the salt.

export const AUTH_LINK_COOKIE_NAME = 'tocb_auth_link';
/** 1 year; refreshed on every auth'd request, so this is the idle ceiling. */
export const AUTH_LINK_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

function b64urlEncode(bytes: Uint8Array | string): string {
  const str = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): string {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

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

export async function signAuthLinkCookie(
  authSub: string,
  salt: string,
  ttlSeconds: number = AUTH_LINK_COOKIE_MAX_AGE,
): Promise<string> {
  const payload = JSON.stringify({ sub: authSub, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  const payloadB64 = b64urlEncode(payload);
  const sigBytes = await hmacSha256(salt, payloadB64);
  return `${payloadB64}.${b64urlEncode(sigBytes)}`;
}

/**
 * Returns the verified auth sub on success, null otherwise. Null covers
 * missing / malformed / expired / bad-signature — callers don't
 * distinguish; they just fall through to the anon-cookie path.
 */
export async function verifyAuthLinkCookie(
  cookie: string | null,
  salt: string,
): Promise<string | null> {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  const expectedSigBytes = await hmacSha256(salt, payloadB64);
  const expectedSigB64 = b64urlEncode(expectedSigBytes);
  if (expectedSigB64.length !== sigB64.length) return null;
  // Constant-time compare of the base64url signatures (same technique as
  // the turnstile cookie verifier — no subtle.timingSafeEqual in Workers).
  let diff = 0;
  for (let i = 0; i < sigB64.length; i++) diff |= expectedSigB64.charCodeAt(i) ^ sigB64.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(b64urlDecode(payloadB64)) as { sub?: unknown; exp?: unknown };
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

export function buildAuthLinkCookieHeader(value: string): string {
  return `${AUTH_LINK_COOKIE_NAME}=${value}; Path=/; Max-Age=${AUTH_LINK_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Lax`;
}
