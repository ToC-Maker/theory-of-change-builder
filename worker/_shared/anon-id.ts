// Shared anonymous-actor identity helpers.
//
// Anonymous users are identified by `anon-<hex>` where <hex> is a hex-encoded
// HMAC-SHA256 of the caller's IP under `env.IP_HASH_SALT`. The same derivation
// is used as the `anon_id` payload in the Turnstile session cookie so that
// cookie validity is bound to the IP that solved the challenge.
//
// Keep the derivation identical across every call site — any drift means
// cookies issued by one endpoint won't verify at another, and users would
// appear to be different actors to different endpoints.

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

export async function anonIdFor(request: Request, salt: string): Promise<string> {
  return `anon-${await hashIP(extractIP(request), salt)}`;
}
