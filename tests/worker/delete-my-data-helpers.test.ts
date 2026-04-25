// Helpers for the DELETE /api/my-data ("Delete all my data") endpoint.
// We test pure functions in isolation; the SQL cascade is exercised manually
// + by integration testing in dev. These helpers are the bits that don't
// need a DB to verify and where regressions would silently break the privacy
// guarantees of the feature.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildExpiredCookieHeader,
  buildClearedCookieHeaders,
  classifyDbError,
  COOKIES_TO_CLEAR_ON_DATA_DELETE,
  COOKIES_TO_PRESERVE_ON_DATA_DELETE,
  fanOutAnthropicDeletes,
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

describe('classifyDbError', () => {
  it('maps Postgres 08* (connection-class) codes to 503 retry', async () => {
    const r = classifyDbError({ code: '08006' }, 'inc-1');
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body).toEqual({ error: 'database_unavailable' });
  });

  it('maps non-08 PG codes (e.g. constraint violations) to 500 with incident_id', async () => {
    const r = classifyDbError({ code: '23503' }, 'inc-2');
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string; incident_id: string | null };
    expect(body.error).toBe('database_error');
    expect(body.incident_id).toBe('inc-2');
  });

  it('maps a non-PG error (no .code) to 500', async () => {
    const r = classifyDbError(new Error('something fell over'));
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string; incident_id: string | null };
    expect(body.error).toBe('database_error');
    expect(body.incident_id).toBe(null);
  });

  it('does not leak the raw error message to the client', async () => {
    const r = classifyDbError(new Error('connection to database "secret_db" failed'));
    const body = await r.text();
    // The user-facing payload should not include the raw error text.
    expect(body).not.toContain('secret_db');
  });
});

describe('fanOutAnthropicDeletes', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns an empty failed list when every DELETE responds 200', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 })) as typeof fetch;
    const failed = await fanOutAnthropicDeletes('sk-test', ['file_a', 'file_b', 'file_c']);
    expect(failed).toEqual([]);
  });

  it('treats a 404 (already gone) as success', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 404 })) as typeof fetch;
    const failed = await fanOutAnthropicDeletes('sk-test', ['file_x']);
    expect(failed).toEqual([]);
  });

  it('returns only the failed file_ids on partial server-side failure', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // file_b 500s, others succeed
      if (url.includes('file_b')) return new Response('boom', { status: 500 });
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const failed = await fanOutAnthropicDeletes('sk-test', ['file_a', 'file_b', 'file_c']);
    expect(failed).toEqual(['file_b']);
  });

  it('returns the failed file_ids when fetch itself throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const failed = await fanOutAnthropicDeletes('sk-test', ['file_a', 'file_b']);
    expect(failed.sort()).toEqual(['file_a', 'file_b']);
  });

  it('processes all ids when there are more than the per-chunk concurrency limit', async () => {
    // Internal concurrency is 6; 14 ids exercises the chunk boundary.
    const ids = Array.from({ length: 14 }, (_, i) => `file_${i}`);
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 })) as typeof fetch;
    const failed = await fanOutAnthropicDeletes('sk-test', ids);
    expect(failed).toEqual([]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(14);
  });

  it('URL-encodes the file_id so opaque ids with reserved chars route correctly', async () => {
    let captured = '';
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      captured = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return new Response('', { status: 200 });
    }) as typeof fetch;
    await fanOutAnthropicDeletes('sk-test', ['file abc/def']);
    expect(captured).toContain(encodeURIComponent('file abc/def'));
  });
});
