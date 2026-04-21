import type { Env } from '../_shared/types';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { probeAnthropicKey } from '../_shared/anthropic-probe';

/**
 * Same Anthropic probe as POST /api/byok-key, but does not store the key.
 * Used by the frontend to pre-validate keys before confirming storage.
 */
export async function handler(request: Request, env: Env): Promise<Response> {
  const token = extractToken(request.headers.get('authorization'));
  if (!token) {
    return Response.json({ error: 'Authentication required' }, { status: 401 });
  }

  try {
    await verifyToken(token, env);
  } catch (err) {
    if (err instanceof JWKSFetchError) {
      return Response.json({ error: 'Authentication service unavailable' }, { status: 502 });
    }
    return Response.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

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

  const probe = await probeAnthropicKey(userKey, 'validate-byok');
  if (probe === 'invalid') {
    return Response.json({ error: 'invalid_byok_key' }, { status: 401 });
  }
  if (probe === 'error') {
    return Response.json({ error: 'byok_verification_failed' }, { status: 502 });
  }

  return Response.json({ verified: true });
}
