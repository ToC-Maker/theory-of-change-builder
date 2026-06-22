// Per-request auth-token resolution in chatService
// (src/services/chatService.ts) — follow-up to the ChartService round-2
// 401 fix; same staleness class.
//
// Blast radius of the mount-time static token on the AI streaming path
// (all confirmed in worker/api/anthropic-stream.ts `resolveActor`):
//   - STALE token  → 401 invalid_token, fail-closed (line ~194). Every
//     AI message errors for the rest of the session.
//   - NULL token (the App auth effect's silent-refresh fallback) → the
//     request is treated as ANONYMOUS: BYOK header ignored ("ignoring
//     X-User-Anthropic-Key from anon caller"), anon tier caps/remedies
//     apply, and the anon Turnstile session gate kicks in.
// Plus /api/reconcile-cost (chatCostTracker / reconcilePolling carry a
// token snapshot) → 401 invalid_token on stale, so cost reconciliation
// silently stops converging.
//
// Fix under test: chatService.setAuthTokenProvider() — resolved at
// request time (stream start, queue drains), mirroring
// ChartService.setAuthTokenProvider.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chatService, type ChatMessage } from '../../src/services/chatService';

let fetchSpy: ReturnType<typeof vi.fn>;

/** Authorization header of the first /api/anthropic-stream POST. */
function streamAuthHeader(): string | undefined {
  const call = fetchSpy.mock.calls.find(([url]) => String(url).includes('/api/anthropic-stream'));
  const init = call?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.['Authorization'];
}

const messages: ChatMessage[] = [
  { id: 'm1', role: 'user', content: 'hello', timestamp: new Date() },
];

/**
 * Drive one streamMessage call against a stubbed fetch. The stream
 * endpoint replies 402 global_budget_exhausted — a terminal cost error
 * that streamFromApi handles BEFORE any SSE parsing, so the test never
 * needs a fake event stream; we only care about the request headers.
 * Other endpoints (logging, reconcile drains) get a generic 200.
 */
async function runStream(): Promise<void> {
  await chatService
    .streamMessage({
      messages,
      currentGraphData: { title: 'T', sections: [] },
      mode: 'chat',
      callbacks: { onCostError: () => {}, onError: () => {} },
    })
    .catch(() => {
      // cost_error rethrow (or marked error) — irrelevant to the assertion.
    });
}

beforeEach(() => {
  localStorage.clear(); // empty pending-reconcile queue → no drain POSTs
  fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes('/api/anthropic-stream')) {
      return new Response(JSON.stringify({ error: 'global_budget_exhausted' }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  // chatService is a module singleton — reset its token state so order
  // can't leak across tests/files.
  chatService.setAuthTokenProvider(null);
  chatService.setAuthToken(null);
  vi.unstubAllGlobals();
});

describe('chatService request-time token resolution', () => {
  it('streamMessage attaches a Bearer token resolved from the provider at request time', async () => {
    chatService.setAuthToken(null);
    chatService.setAuthTokenProvider(async () => 'fresh-token');

    await runStream();

    expect(streamAuthHeader()).toBe('Bearer fresh-token');
  });

  it('prefers the provider token over a stale static token', async () => {
    chatService.setAuthToken('stale-mount-time-token');
    chatService.setAuthTokenProvider(async () => 'refreshed-token');

    await runStream();

    expect(streamAuthHeader()).toBe('Bearer refreshed-token');
  });

  it('falls back to the static token when no provider is registered (legacy callers)', async () => {
    chatService.setAuthToken('static-token');

    await runStream();

    expect(streamAuthHeader()).toBe('Bearer static-token');
  });

  it('falls back to the static token when the provider throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    chatService.setAuthToken('last-known-token');
    chatService.setAuthTokenProvider(async () => {
      throw new Error('auth0 exploded');
    });

    await runStream();

    expect(streamAuthHeader()).toBe('Bearer last-known-token');
    warnSpy.mockRestore();
  });

  it('sends NO Authorization header when the provider resolves null (anon invariance)', async () => {
    // Load-bearing for the Turnstile-gated anon flow: a null provider
    // result must produce a byte-identical anonymous request (cookie
    // identity only), not a stale Bearer header that would 401.
    chatService.setAuthToken('stale-token');
    chatService.setAuthTokenProvider(async () => null);

    await runStream();

    expect(streamAuthHeader()).toBeUndefined();
  });
});
