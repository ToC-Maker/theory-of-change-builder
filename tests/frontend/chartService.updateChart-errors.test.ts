// ChartService.updateChart: the save's three outcomes and what the save loop
// needs to distinguish them.
//   - 200 with the new version: saved.
//   - 409 with the latest chart: a conflict, handed back (normalised) for the
//     caller to merge; it is a result, not an error.
//   - anything else is an error carrying the HTTP status, so the loop can tell
//     what to retry: network failures and 5xx quickly and then every 30
//     seconds, 401/403 (which a token that failed to resolve can cause) only
//     every 30 seconds, and other 4xx not at all. A request the server never
//     answers fails after a timeout, also as a retryable (status-less) failure,
//     so one stalled request cannot hold the save loop forever.
// Every non-2xx answer is logged with its raw body, since the body is the only
// trace of why the Worker refused; a conflict logs the two versions and never
// the chart.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartApiError, ChartService } from '../../src/services/chartService';
import { ChartShapeError } from '../../shared/chart-model';
import type { ToCData } from '../../src/types';

const chartData: ToCData = { title: 'T', sections: [] };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

let fetchSpy: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

/** Everything a console spy was called with, as one searchable string. */
const loggedText = (spy: { mock: { calls: unknown[][] } }) => JSON.stringify(spy.mock.calls);

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ChartService.updateChart outcomes', () => {
  it('posts the chart with the version it was based on and returns the version it produced', async () => {
    fetchSpy.mockResolvedValue(json({ success: true, version: 4 }));

    const outcome = await ChartService.updateChart('tok', chartData, 3);

    expect(outcome).toEqual({ status: 'saved', version: 4 });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/updateChart');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      editToken: 'tok',
      chartData,
      baseVersion: 3,
    });
  });

  it('returns a conflict carrying the latest chart, normalised, instead of throwing', async () => {
    // The stored chart of a tab that never saved from an up-to-date client: no section ids.
    const stored = {
      title: 'Theirs',
      sections: [{ title: 'S', columns: [{ nodes: [] }] }],
    };
    fetchSpy.mockResolvedValue(json({ error: 'conflict', version: 7, chartData: stored }, 409));

    const outcome = await ChartService.updateChart('tok', chartData, 5);

    expect(outcome).toEqual({
      status: 'conflict',
      theirs: {
        version: 7,
        chart: {
          title: 'Theirs',
          sections: [{ id: 's0', title: 'S', columns: [{ id: 'c0.0', nodes: [] }] }],
        },
      },
    });
  });

  it('logs the base and server versions of a conflict and never the chart', async () => {
    const secret = 'a-title-nobody-should-find-in-the-console';
    fetchSpy.mockResolvedValue(
      json({ error: 'conflict', version: 7, chartData: { title: secret, sections: [] } }, 409),
    );

    await ChartService.updateChart('tok', chartData, 5);

    const logged = loggedText(logSpy);
    expect(logged).toContain('5');
    expect(logged).toContain('7');
    expect(logged).not.toContain(secret);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('throws a terminal error when a success body carries no integer version', async () => {
    // An old Worker answered: looping the save would never end.
    fetchSpy.mockResolvedValue(json({ success: true }));

    const failure = ChartService.updateChart('tok', chartData, 3);

    await expect(failure).rejects.toBeInstanceOf(ChartApiError);
    await expect(failure).rejects.toMatchObject({ status: 200 });
  });

  it('treats a 409 that is not the conflict shape as an ordinary failure', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'Something else' }, 409));

    await expect(ChartService.updateChart('tok', chartData, 3)).rejects.toMatchObject({
      message: 'Something else',
      status: 409,
    });
  });

  it('treats a conflict that names no version as an ordinary failure', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'conflict', chartData }, 409));

    await expect(ChartService.updateChart('tok', chartData, 3)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('rejects with a shape error when the conflict carries something that is not a chart', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'conflict', version: 7, chartData: {} }, 409));

    await expect(ChartService.updateChart('tok', chartData, 3)).rejects.toBeInstanceOf(
      ChartShapeError,
    );
  });
});

describe('ChartService.updateChart failures', () => {
  it("rejects with the worker's message and the HTTP status", async () => {
    fetchSpy.mockResolvedValue(json({ error: 'Invalid or expired authentication.' }, 403));

    const failure = ChartService.updateChart('tok', chartData, 3);

    await expect(failure).rejects.toBeInstanceOf(ChartApiError);
    await expect(failure).rejects.toMatchObject({
      message: 'Invalid or expired authentication.',
      status: 403,
    });
  });

  it('keeps a generic message and the status for a non-JSON error body', async () => {
    fetchSpy.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }));

    await expect(ChartService.updateChart('tok', chartData, 3)).rejects.toMatchObject({
      message: 'Failed to update chart',
      status: 502,
    });
  });

  it('logs the method, path, status and raw body of a non-2xx answer', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 500 }));

    await expect(ChartService.updateChart('tok', chartData, 3)).rejects.toMatchObject({
      status: 500,
    });

    const logged = loggedText(errorSpy);
    expect(logged).toContain('POST');
    expect(logged).toContain('/api/updateChart');
    expect(logged).toContain('500');
    expect(logged).toContain('boom');
  });

  it('lets a network failure through untouched, with no status', async () => {
    const networkError = new TypeError('Failed to fetch');
    fetchSpy.mockRejectedValue(networkError);

    await expect(ChartService.updateChart('tok', chartData, 3)).rejects.toBe(networkError);
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

      const failure = ChartService.updateChart('tok', chartData, 3);
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
        return json({ success: true, version: 4 });
      });

      await ChartService.updateChart('tok', chartData, 3);
      await vi.advanceTimersByTimeAsync(60_000);

      expect(signal?.aborted).toBe(false);
    });
  });
});
