// Shared anonymous-actor identity helpers.
//
// Anonymous users are identified by `anon-<hash>` where <hash> is the
// hex-encoded HMAC-SHA256 of the caller's cf-connecting-ip under
// env.IP_HASH_SALT. The SAME value is persisted in a first-party
// `tocb_actor_id` cookie. Four cases:
//
//   - Cookie absent, first visit: identity = hash(current_ip). Cookie is
//     set to that hash.
//   - Cookie absent, same IP as a prior visit: hash(current_ip) matches
//     the prior row → cap preserved across the cookie clear.
//   - Cookie present, matches current hash(ip): normal path, no work.
//   - Cookie present, DOESN'T match current hash(ip) (IP changed): the
//     `user_api_usage` row is migrated from the old id to the new one
//     (UPDATE … WHERE user_id = old), the cookie is rewritten to the
//     current hash, and the caller proceeds under the new identity with
//     its cap preserved. If the new id already has a row (rare hash
//     collision), migration is skipped and the caller stays on the old
//     cookie identity to avoid merging two users' data.
//
// Only both resets at once — cleared cookie AND changed IP — produce a
// fresh identity with a fresh cap. Any single reset preserves the cap.
//
// Keep this derivation identical across every call site — any drift means
// the same user looks like different actors to different endpoints.

export const ACTOR_COOKIE_NAME = 'tocb_actor_id';
/** 1 year — effectively permanent for a browser profile. */
export const ACTOR_COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** 64-char lowercase hex (SHA-256 output). Guards against garbage cookie values. */
function isValidActorHash(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
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
 * Generic typing for the Neon sql template — accepts either the strict
 * or loose array type from `@neondatabase/serverless`. Kept narrow (only
 * the template-tag shape used below) so callers don't have to import
 * NeonQueryFunction for a trivial parameter type.
 */
type SqlTag = <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>;

/**
 * Resolve the anonymous actor for a request.
 *
 * Behavior:
 *   - No cookie: identity = hashIP(cf-connecting-ip, salt). Cookie is
 *     set to that value.
 *   - Cookie matches current IP hash: use cookie value as identity.
 *   - Cookie mismatches current IP hash: migrate
 *     `user_api_usage.user_id` from the old value to the new one, rewrite
 *     the cookie to the new value, and return the new identity. If the
 *     target row already exists the migration is skipped and the caller
 *     stays on the cookie's value — preserves the old cap rather than
 *     merging two users' rows.
 *
 * Pass `sql` when migration should run (anthropic-stream, usage,
 * upload-file — anything that actually consults user_api_usage). Endpoints
 * that don't need cap-aware identity (verify-turnstile on its own) can
 * omit it; then IP mismatches leave the cookie value untouched.
 */
export async function resolveAnonActor(
  request: Request,
  env: { IP_HASH_SALT: string },
  sql?: SqlTag,
): Promise<AnonActorResolution> {
  const currentHash = await hashIP(extractIP(request), env.IP_HASH_SALT);
  const existing = readCookie(request.headers.get('cookie'), ACTOR_COOKIE_NAME);

  // No valid cookie → first visit (or cookie cleared). Use the IP hash
  // directly. If the user is on the same IP they had before the clear,
  // the DB row under anon-<ipHash> is already theirs: cap preserved.
  if (!existing || !isValidActorHash(existing)) {
    return {
      userId: `anon-${currentHash}`,
      setCookieHeader: buildCookieHeader(currentHash),
    };
  }

  // Cookie matches current IP hash → no-op fast path.
  if (existing === currentHash) {
    return { userId: `anon-${existing}` };
  }

  // Cookie mismatches current IP. IP has changed since the cookie was
  // set. Migrate the user_api_usage row to the new id and rewrite the
  // cookie; if the target row already exists, fall back to cookie
  // identity to avoid merging two users' data.
  if (sql) {
    const oldId = `anon-${existing}`;
    const newId = `anon-${currentHash}`;
    try {
      const migrated = await sql<{ user_id: string }>`
        UPDATE user_api_usage
        SET user_id = ${newId}
        WHERE user_id = ${oldId}
          AND NOT EXISTS (SELECT 1 FROM user_api_usage WHERE user_id = ${newId})
        RETURNING user_id
      `;
      if (migrated.length > 0) {
        return { userId: newId, setCookieHeader: buildCookieHeader(currentHash) };
      }
      // No row migrated: either the user has no prior usage (no source
      // row) or the target already exists. Check which.
      const targetRows = await sql<{ user_id: string }>`
        SELECT user_id FROM user_api_usage WHERE user_id = ${newId} LIMIT 1
      `;
      if (targetRows.length > 0) {
        // Target exists — stay on cookie identity to protect their cap.
        return { userId: oldId };
      }
      // No source and no target: nothing to migrate, safe to roll forward.
      return { userId: newId, setCookieHeader: buildCookieHeader(currentHash) };
    } catch (e) {
      // Migration failed — stay on cookie identity so usage still tracks
      // against the row the user previously established.
      console.error('[resolveAnonActor] migration failed; keeping cookie identity:', e);
      return { userId: oldId };
    }
  }

  // No sql access (e.g. called from verify-turnstile): keep cookie
  // identity, let the next capped endpoint migrate when it fires.
  return { userId: `anon-${existing}` };
}
