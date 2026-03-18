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

// Migrate user data from old Auth0 user_id to new one (matched by email).
// This handles tenant migrations where sub values change but emails stay the same.
// No-op after first login since the old user_id will no longer exist.
export async function migrateUserIfNeeded(sql: NeonQueryFunction<false, false>, newUserId: string, email: string) {
  const old = await sql`
    SELECT DISTINCT user_id FROM chart_permissions
    WHERE user_email = ${email} AND user_id != ${newUserId}
    LIMIT 1
  `;
  if (old.length === 0) return;

  const oldUserId = old[0].user_id;
  console.log(`[auth-migration] Migrating user data from ${oldUserId} to ${newUserId} (${email})`);

  await sql`UPDATE charts SET user_id = ${newUserId} WHERE user_id = ${oldUserId}`;
  await sql`UPDATE chart_permissions SET user_id = ${newUserId} WHERE user_id = ${oldUserId}`;
  await sql`UPDATE chart_permissions SET granted_by = ${newUserId} WHERE granted_by = ${oldUserId}`;
  await sql`UPDATE user_token_usage SET user_id = ${newUserId} WHERE user_id = ${oldUserId}`;
}

