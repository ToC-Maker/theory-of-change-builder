import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError, tryMigrateDecoded } from '../_shared/auth';
import { encryptByokKey } from '../_shared/byok-crypto';
import { probeAnthropicKey } from '../_shared/anthropic-probe';

async function handlePost(request: Request, env: Env): Promise<Response> {
  if (!env.BYOK_ENCRYPTION_KEY) {
    return Response.json({ error: 'byok_not_configured' }, { status: 503 });
  }

  const token = extractToken(request.headers.get('authorization'));
  if (!token) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  let decodedToken;
  try {
    decodedToken = await verifyToken(token, env);
  } catch (err) {
    if (err instanceof JWKSFetchError) {
      return Response.json({ error: 'Authentication service unavailable' }, { status: 502 });
    }
    return Response.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  const userId = decodedToken.sub;

  let body: { key?: unknown };
  try {
    body = await request.json() as { key?: unknown };
  } catch {
    return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  const userKey = body.key;
  if (typeof userKey !== 'string' || !userKey.startsWith('sk-ant-')) {
    return Response.json({ error: 'invalid_byok_key' }, { status: 401 });
  }

  const probe = await probeAnthropicKey(userKey, 'byok-key');
  if (probe === 'invalid') {
    return Response.json({ error: 'invalid_byok_key' }, { status: 401 });
  }
  if (probe === 'error') {
    return Response.json({ error: 'byok_verification_failed' }, { status: 502 });
  }

  const last4 = userKey.slice(-4);

  let encrypted: Uint8Array;
  try {
    encrypted = await encryptByokKey(userKey, userId, env.BYOK_ENCRYPTION_KEY);
  } catch (e) {
    console.error('BYOK encryption failed for last4', last4, e);
    return Response.json({ error: 'byok_encryption_failed' }, { status: 500 });
  }

  const sql = getDb(env);
  // Best-effort tenant-migration before storing, mirroring other auth'd routes.
  await tryMigrateDecoded(sql, decodedToken, 'byok-key');

  try {
    // Postgres bytea accepts Buffer/Uint8Array via the Neon driver.
    await sql`
      INSERT INTO user_byok_keys (user_id, encrypted_key, key_last4, verified_at)
      VALUES (${userId}, ${encrypted}, ${last4}, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        encrypted_key = EXCLUDED.encrypted_key,
        key_last4 = EXCLUDED.key_last4,
        verified_at = EXCLUDED.verified_at
    `;
  } catch (e) {
    console.error('BYOK DB upsert failed for last4', last4, e);
    return Response.json({ error: 'database_unavailable' }, { status: 503 });
  }

  return Response.json({ verified: true, last4 });
}

async function handleDelete(request: Request, env: Env): Promise<Response> {
  const token = extractToken(request.headers.get('authorization'));
  if (!token) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  let decodedToken;
  try {
    decodedToken = await verifyToken(token, env);
  } catch (err) {
    if (err instanceof JWKSFetchError) {
      return Response.json({ error: 'Authentication service unavailable' }, { status: 502 });
    }
    return Response.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  const userId = decodedToken.sub;

  const sql = getDb(env);
  try {
    // Zeroize-then-delete in one transaction to reduce WAL/replica recovery surface.
    await sql.transaction([
      sql`UPDATE user_byok_keys SET encrypted_key = '\\x'::bytea WHERE user_id = ${userId}`,
      sql`DELETE FROM user_byok_keys WHERE user_id = ${userId}`,
    ]);
  } catch (e) {
    console.error('BYOK delete failed:', e);
    return Response.json({ error: 'database_unavailable' }, { status: 503 });
  }

  return Response.json({ deleted: true });
}

export async function handler(request: Request, env: Env): Promise<Response> {
  if (request.method === 'POST') return handlePost(request, env);
  if (request.method === 'DELETE') return handleDelete(request, env);
  return Response.json({ error: 'Method not allowed' }, { status: 405 });
}
