// RequestTokenSource — the shared request-time auth-token resolver
// (src/services/requestTokenSource.ts).
//
// Extracted from ChartService's round-2 401 fix so chatService and
// LoggingService share one implementation of the resolution semantics
// instead of three drifting copies:
//   - provider registered → its result is authoritative (fresh token,
//     or null = "no session right now"); the static cache syncs to it
//   - provider throws → fall back to the last-known static token
//   - no provider → legacy static-snapshot behavior
//
// The per-service integration tests (chartService.auth.test.ts,
// chatService.auth.test.ts, loggingService.auth.test.ts) assert the
// wire shape; this file pins the resolver core once.
import { describe, it, expect, vi } from 'vitest';
import { RequestTokenSource } from '../../src/services/requestTokenSource';

describe('RequestTokenSource', () => {
  it('resolves the static token when no provider is registered', async () => {
    const src = new RequestTokenSource('Test');
    src.setToken('static-token');
    expect(await src.resolve()).toBe('static-token');
  });

  it('resolves null when neither provider nor static token exist', async () => {
    const src = new RequestTokenSource('Test');
    expect(await src.resolve()).toBeNull();
  });

  it('prefers the provider result over a stale static token', async () => {
    const src = new RequestTokenSource('Test');
    src.setToken('stale-token');
    src.setProvider(async () => 'fresh-token');
    expect(await src.resolve()).toBe('fresh-token');
    // Static cache synced so hasToken()/getToken() reflect reality.
    expect(src.getToken()).toBe('fresh-token');
    expect(src.hasToken()).toBe(true);
  });

  it('treats a provider null as authoritative (no header beats stale header)', async () => {
    const src = new RequestTokenSource('Test');
    src.setToken('stale-token');
    src.setProvider(async () => null);
    expect(await src.resolve()).toBeNull();
    expect(src.hasToken()).toBe(false);
  });

  it('falls back to the last-known static token when the provider throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const src = new RequestTokenSource('Test');
    src.setToken('last-known');
    src.setProvider(async () => {
      throw new Error('auth0 exploded');
    });
    expect(await src.resolve()).toBe('last-known');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('Test');
    warnSpy.mockRestore();
  });

  it('clearing the provider restores static-snapshot behavior', async () => {
    const src = new RequestTokenSource('Test');
    src.setToken('static-token');
    src.setProvider(async () => 'fresh-token');
    src.setProvider(null);
    expect(await src.resolve()).toBe('static-token');
  });
});
