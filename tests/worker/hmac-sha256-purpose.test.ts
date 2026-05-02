import { describe, expect, it } from 'vitest';
import { hmacSha256Purpose } from '../../worker/_shared/anon-id';

const KEY = 'test-ip-hash-salt';
const ALT_KEY = 'different-salt';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

describe('hmacSha256Purpose', () => {
  it('is deterministic: same (key, purpose, payload) → same bytes', async () => {
    const a = await hmacSha256Purpose(KEY, 'ip-hash', 'payload-1');
    const b = await hmacSha256Purpose(KEY, 'ip-hash', 'payload-1');
    expect(toHex(a)).toBe(toHex(b));
  });

  it('domain separation: different purpose tags yield different outputs', async () => {
    const ipHash = await hmacSha256Purpose(KEY, 'ip-hash', 'payload');
    const authLink = await hmacSha256Purpose(KEY, 'auth-link', 'payload');
    const turnstile = await hmacSha256Purpose(KEY, 'turnstile', 'payload');
    expect(toHex(ipHash)).not.toBe(toHex(authLink));
    expect(toHex(ipHash)).not.toBe(toHex(turnstile));
    expect(toHex(authLink)).not.toBe(toHex(turnstile));
  });

  it('different keys yield different outputs', async () => {
    const a = await hmacSha256Purpose(KEY, 'ip-hash', 'payload');
    const b = await hmacSha256Purpose(ALT_KEY, 'ip-hash', 'payload');
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('different payloads yield different outputs', async () => {
    const a = await hmacSha256Purpose(KEY, 'ip-hash', 'payload-1');
    const b = await hmacSha256Purpose(KEY, 'ip-hash', 'payload-2');
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('output is 32 bytes (SHA-256 width), constant per call', async () => {
    const a = await hmacSha256Purpose(KEY, 'ip-hash', 'anything');
    expect(a).toBeInstanceOf(Uint8Array);
    expect(a.length).toBe(32);
    const b = await hmacSha256Purpose(KEY, 'ip-hash', '');
    expect(b.length).toBe(32);
    const c = await hmacSha256Purpose(KEY, 'ip-hash', 'a'.repeat(10_000));
    expect(c.length).toBe(32);
  });

  it('empty payload returns a valid 32-byte output (no throw)', async () => {
    const a = await hmacSha256Purpose(KEY, 'ip-hash', '');
    expect(a.length).toBe(32);
    // Deterministic even when payload is empty.
    const b = await hmacSha256Purpose(KEY, 'ip-hash', '');
    expect(toHex(a)).toBe(toHex(b));
  });

  it('NUL-terminator separation: purpose="a", payload="\\x00b" != purpose="a\\x00b", payload=""', async () => {
    // The impl formats the HMAC input as `${purpose}\x00${payload}`. This
    // test checks the CONCATENATED byte sequence is distinguishable from a
    // payload that starts with NUL — which it IS in practice because the
    // callers use fixed-vocabulary purpose strings ('ip-hash', 'auth-link',
    // 'turnstile'), none of which contain NUL. We verify they diverge here.
    const a = await hmacSha256Purpose(KEY, 'ip-hash', '\x00extra');
    const b = await hmacSha256Purpose(KEY, 'ip-hash\x00extra', '');
    // Both produce the same HMAC input string `ip-hash\x00\x00extra` vs
    // `ip-hash\x00extra\x00`, so the outputs differ.
    expect(toHex(a)).not.toBe(toHex(b));
  });
});
