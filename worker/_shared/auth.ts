import { jwtVerify, createRemoteJWKSet } from 'jose';
import {
  JWTClaimValidationFailed,
  JWTExpired,
  JWTInvalid,
  JWSInvalid,
  JWSSignatureVerificationFailed,
  JWKSNoMatchingKey,
} from 'jose/errors';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from './types';

// jose caches JWKS keys internally; module-level variable persists across
// warm invocations within the same Workers isolate. Auth0 key rotations
// are picked up when the isolate is recycled or when jose's internal
// cache expires.
let cachedJWKS: ReturnType<typeof createRemoteJWKSet>;
let cachedDomain: string;

function getJWKS(domain: string) {
  if (!cachedJWKS || cachedDomain !== domain) {
    cachedJWKS = createRemoteJWKSet(new URL(`https://${domain}/.well-known/jwks.json`));
    cachedDomain = domain;
  }
  return cachedJWKS;
}

/**
 * Thrown when JWKS fetch fails (Auth0 outage, DNS error, timeout).
 * Callers should return 502/503, not 401, since the token may be valid.
 */
export class JWKSFetchError extends Error {
  constructor(cause: unknown) {
    super('Failed to fetch JWKS signing keys');
    this.name = 'JWKSFetchError';
    this.cause = cause;
  }
}

export interface DecodedToken {
  sub: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
}

export async function verifyToken(token: string, env: Env): Promise<DecodedToken> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, getJWKS(env.VITE_AUTH0_DOMAIN), {
      audience: env.VITE_AUTH0_CLIENT_ID,
      issuer: `https://${env.VITE_AUTH0_DOMAIN}/`,
      algorithms: ['RS256'],
    }));
  } catch (err) {
    // Distinguish token validation errors from infrastructure errors.
    // Known token errors mean the JWT itself is bad; everything else
    // (JWKS timeout, DNS failure, non-200 JWKS response, etc.) is an
    // infrastructure problem where the token may actually be valid.
    const isTokenError =
      err instanceof JWTClaimValidationFailed ||
      err instanceof JWTExpired ||
      err instanceof JWTInvalid ||
      err instanceof JWSInvalid ||
      err instanceof JWSSignatureVerificationFailed ||
      err instanceof JWKSNoMatchingKey;
    if (!isTokenError) {
      throw new JWKSFetchError(err);
    }
    throw err;
  }
  if (typeof payload.sub !== 'string') {
    throw new Error('JWT missing required sub claim');
  }
  return payload as DecodedToken;
}

export function extractToken(authHeader: string | null): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.substring(7);
}

// Best-effort migration from an already-verified token.
// No-op if the token has no email. Errors are logged and swallowed.
export async function tryMigrateDecoded(
  sql: NeonQueryFunction<false, false>,
  decodedToken: { sub: string; email?: string },
  logPrefix: string,
): Promise<void> {
  if (!decodedToken?.email) return;

  try {
    await migrateUserIfNeeded(sql, decodedToken.sub, decodedToken.email);
  } catch (err) {
    console.error(`[${logPrefix}] User migration failed:`, err);
  }
}

// Best-effort migration attempt from an Authorization header.
// Extracts and verifies the token, then delegates to tryMigrateDecoded.
// Failures are logged and swallowed — migration is never required for the request to succeed.
export async function tryMigrateUser(
  sql: NeonQueryFunction<false, false>,
  authHeader: string | null,
  logPrefix: string,
  env: Env,
): Promise<void> {
  const token = extractToken(authHeader);
  if (!token) return;

  let decodedToken;
  try {
    decodedToken = await verifyToken(token, env);
  } catch {
    console.log(`[${logPrefix}] Token verification failed, skipping migration check`);
    return;
  }

  await tryMigrateDecoded(sql, decodedToken, logPrefix);
}

// Migrate user data from old Auth0 user_id to new one (matched by verified email).
// This handles tenant migrations where sub values change but emails stay the same.
// No-op after the first post-migration login: once old user_id rows are updated,
// the lookup query returns no results.
async function migrateUserIfNeeded(
  sql: NeonQueryFunction<false, false>,
  newUserId: string,
  email: string,
) {
  const old = await sql`
    SELECT DISTINCT user_id FROM chart_permissions
    WHERE user_email = ${email} AND user_id != ${newUserId}
    LIMIT 1
  `;
  if (old.length === 0) return;

  const oldUserId = old[0].user_id;
  console.log(`[auth-migration] Migrating user data: ${oldUserId} -> ${newUserId}`);

  await sql.transaction([
    sql`UPDATE charts SET user_id = ${newUserId} WHERE user_id = ${oldUserId}`,

    // Remove conflicting permission rows before updating (UNIQUE on chart_id, user_id)
    sql`DELETE FROM chart_permissions
        WHERE user_id = ${oldUserId}
          AND chart_id IN (SELECT chart_id FROM chart_permissions WHERE user_id = ${newUserId})`,
    sql`UPDATE chart_permissions SET user_id = ${newUserId} WHERE user_id = ${oldUserId}`,
    sql`UPDATE chart_permissions SET granted_by = ${newUserId} WHERE granted_by = ${oldUserId}`,

    // Merge API usage (PK on user_id) — fold old row into new, then delete old row.
    // Reads/writes user_api_usage; the legacy user_token_usage table is frozen
    // (see freeze-user-token-usage.sql).
    sql`INSERT INTO user_api_usage (user_id, input_tokens, output_tokens, cache_create_tokens,
                                    cache_read_tokens, web_search_uses, cost_micro_usd,
                                    first_activity_at, last_activity_at)
        SELECT ${newUserId}, input_tokens, output_tokens, cache_create_tokens,
               cache_read_tokens, web_search_uses, cost_micro_usd,
               first_activity_at, last_activity_at
        FROM user_api_usage WHERE user_id = ${oldUserId}
        ON CONFLICT (user_id) DO UPDATE SET
          input_tokens        = user_api_usage.input_tokens + EXCLUDED.input_tokens,
          output_tokens       = user_api_usage.output_tokens + EXCLUDED.output_tokens,
          cache_create_tokens = user_api_usage.cache_create_tokens + EXCLUDED.cache_create_tokens,
          cache_read_tokens   = user_api_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
          web_search_uses     = user_api_usage.web_search_uses + EXCLUDED.web_search_uses,
          cost_micro_usd      = user_api_usage.cost_micro_usd + EXCLUDED.cost_micro_usd,
          first_activity_at   = LEAST(user_api_usage.first_activity_at, EXCLUDED.first_activity_at),
          last_activity_at    = GREATEST(user_api_usage.last_activity_at, EXCLUDED.last_activity_at)`,
    sql`DELETE FROM user_api_usage WHERE user_id = ${oldUserId}`,
  ]);
}
