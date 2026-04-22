// Shared anonymous-actor identity helpers.
//
// Anonymous users are identified by `anon-<value>` where <value> is either:
//   (a) a stable random UUID persisted in a first-party `tocb_actor_id`
//       cookie — the primary path, robust to IP changes.
//   (b) an HMAC-SHA256 hash of cf-connecting-ip under env.IP_HASH_SALT —
//       the fallback path when no cookie is present (first visit, or
//       cookie-disabled browsers).
//
// Keep the derivation identical across every call site — any drift means
// the same user looks like different actors to different endpoints,
// splitting their usage rows and cap tracking.
//
// Historical note: pre-cookie, identity was purely `hashIP(ip)`. That
// broke for any user whose IP shifted (dual-stack Happy Eyeballs, CGNAT,
// WiFi↔LTE), which both re-challenged Turnstile and reset their cap.
// Cookie identity pins the actor across IP changes; IP stays as the
// first-visit tiebreaker so cookie-blocking clients still get some
// rate-limit coherence (at the cost of rotating on IP changes).

export const ACTOR_COOKIE_NAME = 'tocb_actor_id';
/** 1 year — effectively permanent for a browser profile. */
export const ACTOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** RFC 4122 v4 shape check. */
function isValidUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
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
 * Legacy one-shot anon-id helper (IP hash only). Retained because a couple
 * of endpoints still call it; new code should prefer `resolveAnonActor`.
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
   * browser persists the stable identity for next time.
   */
  setCookieHeader?: string;
};

/**
 * Resolve the anonymous actor for a request.
 *
 * Cookie-first: if `tocb_actor_id` is present and a valid UUID, use it.
 * The UUID is the stable identity; IP changes don't affect it.
 *
 * Fallback: no cookie → identity becomes `anon-<ipHash>` so cookie-blocking
 * clients still get consistent rate limiting for the lifetime of their IP.
 * The same request also gets a fresh UUID cookie in the response; clients
 * that honour cookies migrate to the UUID identity on the next request.
 *
 * The identity MIGRATION on cookie-set (IP-hash → UUID) does split a user's
 * usage row across the two identities on first visit. We accept this —
 * first visits are low-volume and the second row inherits from there. If
 * this proves too messy, a follow-up could reuse the ipHash as the UUID
 * seed so both map to the same row; out of scope here.
 */
export async function resolveAnonActor(
  request: Request,
  env: { IP_HASH_SALT: string },
): Promise<AnonActorResolution> {
  const existing = readCookie(request.headers.get('cookie'), ACTOR_COOKIE_NAME);
  if (existing && isValidUuid(existing)) {
    return { userId: `anon-${existing}` };
  }

  // No cookie → attribute this request to the IP hash (tiebreaker) while
  // asking the browser to persist a fresh UUID for next time.
  const ipHash = await hashIP(extractIP(request), env.IP_HASH_SALT);
  const uuid = crypto.randomUUID();
  const cookieHeader =
    `${ACTOR_COOKIE_NAME}=${uuid}; Path=/; Max-Age=${ACTOR_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Lax`;
  return {
    userId: `anon-${ipHash}`,
    setCookieHeader: cookieHeader,
  };
}
