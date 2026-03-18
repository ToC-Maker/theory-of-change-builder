import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import type { NeonQueryFunction } from '@neondatabase/serverless';

// JWKS client to fetch Auth0 public keys
const client = jwksClient({
  jwksUri: `https://${process.env.VITE_AUTH0_DOMAIN}/.well-known/jwks.json`,
  cache: true,
  rateLimit: true,
});

// Get the signing key from Auth0
function getKey(header: any, callback: any) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) {
      callback(err);
      return;
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

// Verify Auth0 JWT token
export async function verifyToken(token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        audience: process.env.VITE_AUTH0_CLIENT_ID,
        issuer: `https://${process.env.VITE_AUTH0_DOMAIN}/`,
        algorithms: ['RS256'],
      },
      (err, decoded) => {
        if (err) {
          reject(err);
        } else {
          resolve(decoded);
        }
      }
    );
  });
}

// Extract token from Authorization header
export function extractToken(authHeader: string | undefined): string | null {
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
  logPrefix: string
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
  authHeader: string | undefined,
  logPrefix: string
): Promise<void> {
  const token = extractToken(authHeader);
  if (!token) return;

  let decodedToken;
  try {
    decodedToken = await verifyToken(token);
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
// Requires email to be a verified email address, not a display name.
async function migrateUserIfNeeded(sql: NeonQueryFunction<false, false>, newUserId: string, email: string) {
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

    // Merge token usage (PK on user_id) — add old total to new, then delete old row
    sql`INSERT INTO user_token_usage (user_id, total_tokens_used)
        SELECT ${newUserId}, total_tokens_used FROM user_token_usage WHERE user_id = ${oldUserId}
        ON CONFLICT (user_id) DO UPDATE SET
          total_tokens_used = user_token_usage.total_tokens_used + EXCLUDED.total_tokens_used`,
    sql`DELETE FROM user_token_usage WHERE user_id = ${oldUserId}`,
  ]);
}

