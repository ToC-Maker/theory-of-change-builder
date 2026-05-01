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
  isTransientPgErrorCode,
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

describe('isTransientPgErrorCode', () => {
  it('returns true for 08* (connection_exception)', () => {
    // 08006: connection_failure, 08001: sqlclient_unable_to_establish_sqlconnection
    expect(isTransientPgErrorCode('08006')).toBe(true);
    expect(isTransientPgErrorCode('08001')).toBe(true);
    expect(isTransientPgErrorCode('08000')).toBe(true);
  });

  it('returns true for 53* (insufficient_resources)', () => {
    // 53100: disk_full, 53200: out_of_memory, 53300: too_many_connections
    expect(isTransientPgErrorCode('53100')).toBe(true);
    expect(isTransientPgErrorCode('53200')).toBe(true);
    expect(isTransientPgErrorCode('53300')).toBe(true);
  });

  it('returns true for 57P0* (operator_intervention — covers Neon idle-reconnect 57P01)', () => {
    // Neon raises 57P01 (admin_shutdown) when its serverless control plane
    // recycles a compute. Without this we'd 500 every cold-path delete.
    expect(isTransientPgErrorCode('57P01')).toBe(true);
    expect(isTransientPgErrorCode('57P02')).toBe(true);
    expect(isTransientPgErrorCode('57P03')).toBe(true);
    expect(isTransientPgErrorCode('57P04')).toBe(true);
  });

  it('returns true for 40001 (serialization_failure)', () => {
    expect(isTransientPgErrorCode('40001')).toBe(true);
  });

  it('returns true for 40P01 (deadlock_detected)', () => {
    expect(isTransientPgErrorCode('40P01')).toBe(true);
  });

  it('returns false for non-transient classes (constraint, syntax, permission)', () => {
    // 23503: foreign_key_violation, 42601: syntax_error, 42501: insufficient_privilege
    expect(isTransientPgErrorCode('23503')).toBe(false);
    expect(isTransientPgErrorCode('42601')).toBe(false);
    expect(isTransientPgErrorCode('42501')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTransientPgErrorCode('')).toBe(false);
  });

  it('does not match non-57P0 codes that share the 57 prefix', () => {
    // 57014 (query_canceled) is in class 57 but not 57P0; we exclude it
    // because it usually means the client cancelled, not a transient
    // server-side fault.
    expect(isTransientPgErrorCode('57014')).toBe(false);
  });
});

describe('classifyDbError', () => {
  it('maps Postgres 08* (connection-class) codes to 503 retry', async () => {
    const r = classifyDbError({ code: '08006' }, 'inc-1');
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body).toEqual({ error: 'database_unavailable' });
  });

  it('maps Neon 57P01 (operator_intervention / idle reconnect) to 503 retry', async () => {
    // Round 2 review flagged that Neon's idle-reconnect was being mis-classified
    // as a 500 corruption error.
    const r = classifyDbError({ code: '57P01' }, 'inc-neon');
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body).toEqual({ error: 'database_unavailable' });
  });

  it('maps 40001 (serialization_failure) to 503 retry', async () => {
    const r = classifyDbError({ code: '40001' }, 'inc-ser');
    expect(r.status).toBe(503);
  });

  it('maps 40P01 (deadlock_detected) to 503 retry', async () => {
    const r = classifyDbError({ code: '40P01' }, 'inc-dl');
    expect(r.status).toBe(503);
  });

  it('maps 53200 (out_of_memory) to 503 retry', async () => {
    const r = classifyDbError({ code: '53200' }, 'inc-oom');
    expect(r.status).toBe(503);
  });

  it('maps non-transient PG codes (e.g. constraint violations) to 500 with incident_id', async () => {
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

  it('classifies 5xx as transient so the retry job picks it up', async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('file_b')) return new Response('boom', { status: 500 });
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const failed = await fanOutAnthropicDeletes('sk-test', ['file_a', 'file_b', 'file_c']);
    expect(failed).toEqual([{ fid: 'file_b', transient: true }]);
  });

  it('classifies non-404 4xx as permanent so the retry job skips it', async () => {
    // 401/403/422 etc — retrying with the same key won't change the answer.
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('file_b')) return new Response('forbidden', { status: 403 });
      return new Response('', { status: 200 });
    }) as typeof fetch;
    const failed = await fanOutAnthropicDeletes('sk-test', ['file_a', 'file_b']);
    expect(failed).toEqual([{ fid: 'file_b', transient: false }]);
  });

  it('treats fetch-throw as transient (network-level fault, retry might recover)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const failed = await fanOutAnthropicDeletes('sk-test', ['file_a', 'file_b']);
    // Sort by fid so the test is order-independent.
    const sorted = [...failed].sort((a, b) => a.fid.localeCompare(b.fid));
    expect(sorted).toEqual([
      { fid: 'file_a', transient: true },
      { fid: 'file_b', transient: true },
    ]);
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
