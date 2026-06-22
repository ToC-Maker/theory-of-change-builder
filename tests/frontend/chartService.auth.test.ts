// Per-request auth-token resolution in ChartService
// (src/services/chartService.ts).
//
// PR 7 round-2 feedback (signed-in 401s + silent save failure): the
// worker now requires a valid Bearer JWT on getUserCharts (and on
// updateChart for owned, restricted charts) — see commit 533e6ba and
// tests/worker/{getUserCharts,updateChart}-auth.test.ts. The client,
// however, attached a token only from `ChartService.authToken`, a
// static snapshot fetched ONCE per editor mount (src/App.tsx auth
// effect). Two real-world states broke it:
//   1. Auth0 silent refresh fails at mount → the effect intentionally
//      clears the static while `isAuthenticated` stays true → every
//      "authenticated" call goes out with NO Authorization header.
//   2. The snapshot expires mid-session (ID tokens have a fixed exp;
//      nothing ever refreshed the static) → every call goes out with
//      an EXPIRED token.
// Both produce the reviewer's evidence: 401 on
// /api/getUserCharts?userId=auth0|…, and 403 on autosave (surfacing as
// "changes might not have been saved").
//
// Fix under test: `ChartService.setAuthTokenProvider(provider)` — a
// provider resolved at REQUEST time (App registers
// `() => getFreshIdToken(...)`, which returns the cached ID token and
// transparently refreshes it near/after expiry). The static setter
// stays as a fallback for callers that don't register a provider.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChartService } from '../../src/services/chartService';
import type { ToCData } from '../../src/types';

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

let fetchSpy: ReturnType<typeof vi.fn>;

/** The Authorization header of the n-th (default: only) fetch call. */
function sentAuthHeader(call = 0): string | undefined {
  const init = fetchSpy.mock.calls[call]?.[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.['Authorization'];
}

const chartData: ToCData = { title: 'T', sections: [] };

beforeEach(() => {
  fetchSpy = vi.fn(async () => okJson({ charts: [], success: true }));
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  // ChartService keeps module-level static state; reset so test order
  // can't leak tokens/providers across cases.
  ChartService.setAuthToken(null);
  ChartService.setAuthTokenProvider(null);
  vi.unstubAllGlobals();
});

describe('ChartService request-time token resolution', () => {
  it('getUserCharts attaches a Bearer token resolved from the provider at request time', async () => {
    // The reviewer's state: authenticated UI, static token never set
    // (silent-refresh failure path in the App auth effect). With a
    // provider registered, the request must still carry the token.
    ChartService.setAuthToken(null);
    ChartService.setAuthTokenProvider(async () => 'fresh-token');

    await ChartService.getUserCharts('auth0|reviewer');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/getUserCharts');
    expect(sentAuthHeader()).toBe('Bearer fresh-token');
  });

  it('updateChart (the autosave path) prefers the provider token over a stale static token', async () => {
    // Mid-session staleness: the mount-time static is expired; the
    // provider yields the refreshed one. The save must send the fresh
    // token, otherwise the worker 403s and the save silently fails.
    ChartService.setAuthToken('stale-mount-time-token');
    ChartService.setAuthTokenProvider(async () => 'refreshed-token');

    await ChartService.updateChart('edit-tok-1', chartData);

    expect(sentAuthHeader()).toBe('Bearer refreshed-token');
  });

  it('falls back to the static token when no provider is registered (legacy callers)', async () => {
    ChartService.setAuthToken('static-token');

    await ChartService.getUserCharts('auth0|reviewer');

    expect(sentAuthHeader()).toBe('Bearer static-token');
  });

  it('falls back to the static token when the provider throws', async () => {
    // A provider crash (Auth0 SDK hiccup) must not take down the
    // request — a possibly-stale token beats none.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ChartService.setAuthToken('last-known-token');
    ChartService.setAuthTokenProvider(async () => {
      throw new Error('auth0 exploded');
    });

    await ChartService.getUserCharts('auth0|reviewer');

    expect(sentAuthHeader()).toBe('Bearer last-known-token');
    warnSpy.mockRestore();
  });

  it('sends no Authorization header when the provider resolves null (signed-out)', async () => {
    // Provider null is authoritative: "there is no session right now".
    // Sending a known-stale static would just 401 with a misleading
    // "expired" message instead of a clean anonymous request.
    ChartService.setAuthToken('stale-token');
    ChartService.setAuthTokenProvider(async () => null);

    await ChartService.updateChart('edit-tok-1', chartData);

    expect(sentAuthHeader()).toBeUndefined();
  });

  it('createChart resolves the provider token too (ownership at creation)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    ChartService.setAuthTokenProvider(async () => 'fresh-token');

    await ChartService.createChart(chartData);

    expect(sentAuthHeader()).toBe('Bearer fresh-token');
    logSpy.mockRestore();
  });

  it('surfaces the server error message on a failed updateChart (not a generic string)', async () => {
    // The 403 body from worker/api/updateChart.ts explains WHY the save
    // failed ("Invalid or expired authentication. Please log in
    // again."). That message feeds the SaveIndicator tooltip; squashing
    // it to "Failed to update chart" hides the actionable part.
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'Invalid or expired authentication. Please log in again.' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(ChartService.updateChart('edit-tok-1', chartData)).rejects.toThrow(
      /invalid or expired authentication/i,
    );
  });
});
