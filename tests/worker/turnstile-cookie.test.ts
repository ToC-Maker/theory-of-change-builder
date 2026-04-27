// NOTE: This test imports from `worker/_shared/turnstile-cookie.ts`, which is
// being created in parallel by U14. Until U14 lands and integrates, this spec
// will fail at import-resolution. That is expected — keeping the spec here so
// the helper is immediately under test once the file appears.

import { describe, expect, it } from 'vitest';
import { signTurnstileCookie, verifyTurnstileCookie } from '../../worker/_shared/turnstile-cookie';

const TEST_SALT = 'test-ip-hash-salt';
const TEST_ANON = 'abc123deadbeef';

describe('turnstile-cookie round-trip', () => {
  it('signs and verifies', async () => {
    const cookie = await signTurnstileCookie(TEST_ANON, TEST_SALT);
    expect(await verifyTurnstileCookie(cookie, TEST_ANON, TEST_SALT)).toBe('ok');
  });
  it('missing cookie returns missing', async () => {
    expect(await verifyTurnstileCookie(null, TEST_ANON, TEST_SALT)).toBe('missing');
  });
  it('anon_id mismatch returns actor_mismatch', async () => {
    const cookie = await signTurnstileCookie(TEST_ANON, TEST_SALT);
    expect(await verifyTurnstileCookie(cookie, 'different-anon', TEST_SALT)).toBe('actor_mismatch');
  });
  it('tampered signature returns invalid', async () => {
    const cookie = await signTurnstileCookie(TEST_ANON, TEST_SALT);
    const [payload] = cookie.split('.');
    const tampered = `${payload}.AAAA`;
    expect(await verifyTurnstileCookie(tampered, TEST_ANON, TEST_SALT)).toBe('invalid');
  });
  it('expired cookie returns expired', async () => {
    const cookie = await signTurnstileCookie(TEST_ANON, TEST_SALT, -10); // expired 10 s ago
    expect(await verifyTurnstileCookie(cookie, TEST_ANON, TEST_SALT)).toBe('expired');
  });
  it('malformed cookie (no dot) returns invalid', async () => {
    expect(await verifyTurnstileCookie('no-dot-here', TEST_ANON, TEST_SALT)).toBe('invalid');
  });
});
