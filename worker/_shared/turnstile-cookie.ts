/**
 * LOCAL STUB for U12. The authoritative implementation is being created by U14
 * in parallel; the main-thread merge will supersede this file. Keep the exports
 * stable so the U16 tests and the anthropic-stream call sites work against the
 * same surface either way.
 *
 * Cookie shape (per integration contract):
 *   tocb_anon=<base64url(payload_json)>.<base64url(hmac_sha256(payload_bytes, salt))>
 *   payload_json = {"anon_id":"<hex>","exp":<unix_seconds>}
 *   anon_id = hmac_sha256(cf-connecting-ip, IP_HASH_SALT) rendered lowercase hex.
 *
 * HMAC secret: reuses env.IP_HASH_SALT (same secret already protects anon IDs).
 */

const COOKIE_NAME = 'tocb_anon';

// --- base64url helpers --------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  // btoa is standard base64, then strip padding and swap +/ → -/_ for URL-safety.
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array | null {
  // Re-pad, swap -/_ → +/ for atob.
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function hmacSha256(keyBytes: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, msg);
  return new Uint8Array(sig);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// --- Cookie extraction --------------------------------------------------

export function extractTurnstileCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  // Parse "a=1; b=2; tocb_anon=xyz; c=3" style headers.
  const parts = cookieHeader.split(';');
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const name = p.slice(0, eq).trim();
    if (name === COOKIE_NAME) {
      return p.slice(eq + 1).trim();
    }
  }
  return null;
}

// --- Sign / verify ------------------------------------------------------

export async function signTurnstileCookie(
  anonId: string,
  ttlSeconds: number,
  salt: string,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payloadJson = JSON.stringify({ anon_id: anonId, exp });
  const payloadBytes = new TextEncoder().encode(payloadJson);
  const saltBytes = new TextEncoder().encode(salt);
  const mac = await hmacSha256(saltBytes, payloadBytes);
  return `${bytesToBase64Url(payloadBytes)}.${bytesToBase64Url(mac)}`;
}

export async function verifyTurnstileCookie(
  cookie: string | null,
  expectedAnonId: string,
  salt: string,
): Promise<'ok' | 'missing' | 'expired' | 'ip_mismatch' | 'invalid'> {
  if (!cookie) return 'missing';

  const dot = cookie.indexOf('.');
  if (dot < 0) return 'invalid';
  const payloadB64 = cookie.slice(0, dot);
  const macB64 = cookie.slice(dot + 1);

  const payloadBytes = base64UrlToBytes(payloadB64);
  const providedMac = base64UrlToBytes(macB64);
  if (!payloadBytes || !providedMac) return 'invalid';

  const saltBytes = new TextEncoder().encode(salt);
  let expectedMac: Uint8Array;
  try {
    expectedMac = await hmacSha256(saltBytes, payloadBytes);
  } catch {
    return 'invalid';
  }

  if (!constantTimeEqual(expectedMac, providedMac)) return 'invalid';

  let parsed: { anon_id?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return 'invalid';
  }

  if (typeof parsed.anon_id !== 'string' || typeof parsed.exp !== 'number') {
    return 'invalid';
  }

  const now = Math.floor(Date.now() / 1000);
  if (parsed.exp < now) return 'expired';

  if (parsed.anon_id !== expectedAnonId) return 'ip_mismatch';

  return 'ok';
}
