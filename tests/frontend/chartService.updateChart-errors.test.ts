// ChartService.updateChart failures carry the HTTP status so the save
// loop can retry server-side failures (5xx, network) and leave auth and
// permission failures (401/403) to the session-expired flow.
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
});
