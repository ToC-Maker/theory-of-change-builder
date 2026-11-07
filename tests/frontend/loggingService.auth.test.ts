// Per-request auth-token resolution in LoggingService
// (src/services/loggingService.ts) — follow-up to the ChartService
// round-2 401 fix; same staleness class.
//
// Blast radius of the mount-time static token on logging writes: the
// session/message/snapshot/preference routes fail closed on a bad token
// (`401 Token verification failed` — see worker/api/logging-saveMessage
// .ts:67 et al.), and LoggingService's circuit breaker counts those as
// failures — after MAX_FAILURES it opens and ALL logging (including
// reportError fetches) silently stops for the session. A stale token
// therefore means silent loss of AI-improvement logs + diagnostics.
// (logging-reportError itself is token-tolerant server-side, but the
// row loses its user attribution and the breaker still trips on the
// strict routes.)
//
// Fix under test: LoggingServiceClass.setAuthTokenProvider() — token
// resolved per request inside fetchWithCircuitBreaker, mirroring
// ChartService.setAuthTokenProvider.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LoggingServiceClass } from '../../src/services/loggingService';

let fetchSpy: ReturnType<typeof vi.fn>;

function sentAuthHeader(call = 0): string | undefined {
  const init = fetchSpy.mock.calls[call]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.['Authorization'];
}

/** reportError is fire-and-forget (sync); flush its internal promise. */
async function reportAndFlush(service: InstanceType<typeof LoggingServiceClass>): Promise<void> {
  service.reportError({ error_name: 'TestError', error_message: 'boom' });
  // Two macrotask-ish hops: header resolution (provider await) + fetch.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  // Class-level statics — reset so order can't leak across tests/files.
  LoggingServiceClass.setAuthTokenProvider(null);
  LoggingServiceClass.setAuthToken(null);
  vi.unstubAllGlobals();
});

describe('LoggingService request-time token resolution', () => {
  it('reportError attaches a Bearer token resolved from the provider at request time', async () => {
    const service = new LoggingServiceClass();
    LoggingServiceClass.setAuthToken(null);
    LoggingServiceClass.setAuthTokenProvider(async () => 'fresh-token');

    await reportAndFlush(service);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/logging-reportError');
    expect(sentAuthHeader()).toBe('Bearer fresh-token');
  });

  it('prefers the provider token over a stale static token', async () => {
    const service = new LoggingServiceClass();
    LoggingServiceClass.setAuthToken('stale-mount-time-token');
    LoggingServiceClass.setAuthTokenProvider(async () => 'refreshed-token');

    await reportAndFlush(service);

    expect(sentAuthHeader()).toBe('Bearer refreshed-token');
  });

  it('falls back to the static token when no provider is registered (legacy callers)', async () => {
    const service = new LoggingServiceClass();
    LoggingServiceClass.setAuthToken('static-token');

    await reportAndFlush(service);

    expect(sentAuthHeader()).toBe('Bearer static-token');
  });

  it('falls back to the static token when the provider throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = new LoggingServiceClass();
    LoggingServiceClass.setAuthToken('last-known-token');
    LoggingServiceClass.setAuthTokenProvider(async () => {
      throw new Error('auth0 exploded');
    });

    await reportAndFlush(service);

    expect(sentAuthHeader()).toBe('Bearer last-known-token');
    warnSpy.mockRestore();
  });

  it('sends NO Authorization header when the provider resolves null (anon invariance)', async () => {
    const service = new LoggingServiceClass();
    LoggingServiceClass.setAuthToken('stale-token');
    LoggingServiceClass.setAuthTokenProvider(async () => null);

    await reportAndFlush(service);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sentAuthHeader()).toBeUndefined();
  });
});
