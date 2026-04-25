// Helpers for the DELETE /api/my-data ("Delete all my data") endpoint.
// We test pure functions in isolation; the SQL fan-out and Anthropic
// Files API DELETE are exercised manually + by integration testing in
// dev. These helpers are the bits that don't need a DB / network to
// verify and where regressions would silently break the privacy
// guarantees of the feature.
import { describe, expect, it } from 'vitest';
import {
  buildExpiredCookieHeader,
  buildClearedCookieHeaders,
  COOKIES_TO_CLEAR_ON_DATA_DELETE,
  COOKIES_TO_PRESERVE_ON_DATA_DELETE,
} from '../../worker/api/delete-my-data';

describe('buildExpiredCookieHeader', () => {
  it('returns a Set-Cookie value with Max-Age=0', () => {
    const header = buildExpiredCookieHeader('tocb_anon');
    expect(header).toContain('tocb_anon=');
    expect(header).toContain('Max-Age=0');
  });

  it('includes Expires in the past so old browsers also drop it', () => {
    const header = buildExpiredCookieHeader('tocb_anon');
    expect(header).toContain('Expires=');
    // 1970 is a robust marker — any sane Expires date in the past matches.
    expect(header).toContain('1970');
  });

  it('keeps the security attributes the live cookie was set with', () => {
    const header = buildExpiredCookieHeader('tocb_anon');
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
  });

  it('rejects cookie names with control characters', () => {
    expect(() => buildExpiredCookieHeader('bad\nname')).toThrow();
    expect(() => buildExpiredCookieHeader('bad name')).toThrow();
  });
});

describe('COOKIES_TO_CLEAR_ON_DATA_DELETE', () => {
  it('clears tocb_anon (Turnstile session)', () => {
    expect(COOKIES_TO_CLEAR_ON_DATA_DELETE).toContain('tocb_anon');
  });

  it('clears tocb_auth_link (auth-sub binding)', () => {
    expect(COOKIES_TO_CLEAR_ON_DATA_DELETE).toContain('tocb_auth_link');
  });

  it('does NOT clear tocb_actor_id (anon cap stays attached to the browser)', () => {
    // This is a privacy / anti-abuse boundary. The cap row in user_api_usage
    // is preserved under a separate Art 6(1)(f) basis, so the cookie that
    // keys into it must also stay. Removing this assertion would silently
    // give a user a fresh cap on every "delete my data" press.
    expect(COOKIES_TO_CLEAR_ON_DATA_DELETE).not.toContain('tocb_actor_id');
    expect(COOKIES_TO_PRESERVE_ON_DATA_DELETE).toContain('tocb_actor_id');
  });
});

describe('buildClearedCookieHeaders', () => {
  it('returns one Set-Cookie value per cookie to clear', () => {
    const headers = buildClearedCookieHeaders();
    expect(headers).toHaveLength(COOKIES_TO_CLEAR_ON_DATA_DELETE.length);
    for (const name of COOKIES_TO_CLEAR_ON_DATA_DELETE) {
      expect(headers.some((h) => h.startsWith(`${name}=`))).toBe(true);
    }
  });

  it('does not emit a clearing header for tocb_actor_id', () => {
    const headers = buildClearedCookieHeaders();
    expect(headers.every((h) => !h.startsWith('tocb_actor_id='))).toBe(true);
  });
});
