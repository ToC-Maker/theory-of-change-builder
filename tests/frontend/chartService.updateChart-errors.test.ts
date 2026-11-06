// ChartService.updateChart failures carry the HTTP status so the save
// loop can retry server-side failures (5xx, network) and leave auth and
// permission failures (401/403) to the session-expired flow. A request
// the server never answers fails after a timeout, also as a retryable
// (status-less) failure, so one stalled request cannot hold the save
// loop forever.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartApiError, ChartService } from '../../src/services/chartService';
import type { ToCData } from '../../src/types';

const chartData: ToCData = { title: 'T', sections: [] };

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChartService.updateChart failures', () => {
  it("rejects with the worker's message and the HTTP status", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid or expired authentication.' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const failure = ChartService.updateChart('tok', chartData);

    await expect(failure).rejects.toBeInstanceOf(ChartApiError);
    await expect(failure).rejects.toMatchObject({
      message: 'Invalid or expired authentication.',
      status: 403,
    });
  });

  it('keeps a generic message and the status for a non-JSON error body', async () => {
    fetchSpy.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));

    await expect(ChartService.updateChart('tok', chartData)).rejects.toMatchObject({
      message: 'Failed to update chart',
      status: 502,
    });
  });

  it('lets a network failure through untouched, with no status', async () => {
    const networkError = new TypeError('Failed to fetch');
    fetchSpy.mockRejectedValue(networkError);

    await expect(ChartService.updateChart('tok', chartData)).rejects.toBe(networkError);
  });

  describe('when the server never answers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // A fetch that stays pending until its AbortSignal fires, as a real one does.
    const hangUntilAborted = () =>
      fetchSpy.mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );

    it('aborts the request after 30 seconds and rejects with a status-less timeout', async () => {
      hangUntilAborted();

      const failure = ChartService.updateChart('tok', chartData);
      const settled = vi.fn();
      failure.catch(settled);

      await vi.advanceTimersByTimeAsync(29_000);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(failure).rejects.toMatchObject({ name: 'TimeoutError' });
      await expect(failure).rejects.not.toBeInstanceOf(ChartApiError);
    });

    it('does not abort a request that was answered in time', async () => {
      let signal: AbortSignal | undefined;
      fetchSpy.mockImplementation(async (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return new Response('{}', { status: 200 });
      });

      await ChartService.updateChart('tok', chartData);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(signal?.aborted).toBe(false);
    });
  });
});
