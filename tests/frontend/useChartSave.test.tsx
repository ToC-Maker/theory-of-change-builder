// useChartSave — the single save path for edits, imports, undo and redo.
//
// The contract under test, in the user's terms:
//   - one save in flight at a time; an edit made meanwhile waits and goes
//     out when the running save lands, so an older save can never land
//     after a newer one
//   - "Saved" (no pending changes, no error) only once the server holds
//     the latest local data: a save that lands must not clear edits made
//     after it was sent
//   - a failed save keeps the edits pending and the failure visible and
//     retries for as long as they stay pending: quickly at first, then
//     every 30 seconds for network errors and 5xx, and only every 30
//     seconds for 401/403 (which a transient token failure can cause);
//     other 4xx are not retried
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useChartSave } from '../../src/hooks/useChartSave';
import { ChartApiError, ChartService } from '../../src/services/chartService';
import type { ToCData } from '../../src/types';

vi.mock('../../src/services/chartService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/chartService')>();
  return { ...actual, ChartService: { updateChart: vi.fn() } };
});

const mockUpdateChart = vi.mocked(ChartService.updateChart);

const chart = (title: string): ToCData => ({ title, sections: [] });
const V1 = chart('v1');
const V2 = chart('v2');
const V3 = chart('v3');

interface Request {
  token: string;
  data: ToCData;
  succeed: () => Promise<void>;
  fail: (err: unknown) => Promise<void>;
}

let requests: Request[];
let inFlight: number;
let maxInFlight: number;

const settle = async (action: () => void) => {
  await act(async () => {
    action();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function setup(initialToken: string | null = 'tok') {
  const onSaveFailed = vi.fn<(data: ToCData) => void>();
  const rendered = renderHook(
    ({ editToken }: { editToken: string | null }) => useChartSave({ editToken, onSaveFailed }),
    { initialProps: { editToken: initialToken } },
  );
  const save = (data: ToCData) => act(() => rendered.result.current.saveChart(data));
  return { ...rendered, onSaveFailed, save };
}

/** The data the server would hold: the last request that succeeded. */
let serverData: ToCData | null;

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  inFlight = 0;
  maxInFlight = 0;
  serverData = null;
  mockUpdateChart.mockImplementation(
    (token, data) =>
      new Promise<void>((resolve, reject) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        requests.push({
          token,
          data,
          succeed: () =>
            settle(() => {
              inFlight -= 1;
              serverData = data;
              resolve();
            }),
          fail: (err) =>
            settle(() => {
              inFlight -= 1;
              reject(err);
            }),
        });
      }),
  );
});

afterEach(() => {
  // Unmount first: a hook left mounted keeps its window and document
  // listeners and would answer the next test's online/visibility events.
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useChartSave: the normal save', () => {
  it('sends the edit after the debounce and shows Saved once it lands', async () => {
    const { result, save } = setup();

    save(V1);
    expect(result.current.hasPendingChanges).toBe(true);
    expect(result.current.isSaving).toBe(true);
    expect(result.current.pendingChangesRef.current).toBe(V1);
    expect(requests).toHaveLength(0);

    await advance(300);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ token: 'tok', data: V1 });

    await requests[0].succeed();
    expect(result.current.hasPendingChanges).toBe(false);
    expect(result.current.isSaving).toBe(false);
    expect(result.current.saveError).toBeNull();
    expect(result.current.pendingChangesRef.current).toBeNull();
  });

  it('sends only the latest of a burst of edits inside the debounce window', async () => {
    const { save } = setup();

    save(V1);
    await advance(100);
    save(V2);
    await advance(100);
    save(V3);
    await advance(300);

    expect(requests).toHaveLength(1);
    expect(requests[0].data).toBe(V3);
  });

  it('keeps edits pending, without sending, while the chart has no edit token', async () => {
    const { result, save, rerender } = setup(null);

    save(V1);
    await advance(1000);
    expect(requests).toHaveLength(0);
    expect(result.current.hasPendingChanges).toBe(true);
    expect(result.current.isSaving).toBe(false);

    // The chart gets created: the next edit saves normally.
    rerender({ editToken: 'new-tok' });
    save(V2);
    await advance(300);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ token: 'new-tok', data: V2 });
  });

  it('sends edits made before the chart existed once its edit token arrives, with no further edit', async () => {
    const { result, save, rerender } = setup(null);

    // Edited while the chart was still being created.
    save(V1);
    await advance(1000);
    expect(requests).toHaveLength(0);

    rerender({ editToken: 'new-tok' });
    await advance(300);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ token: 'new-tok', data: V1 });
    expect(result.current.isSaving).toBe(true);

    await requests[0].succeed();
    expect(serverData).toBe(V1);
    expect(result.current.hasPendingChanges).toBe(false);
    expect(result.current.isSaving).toBe(false);
  });

  it('sends a debounced edit that is still waiting when the editor unmounts', async () => {
    const { save, unmount } = setup();

    save(V1);
    unmount();

    expect(requests).toHaveLength(1);
    expect(requests[0].data).toBe(V1);
  });
});

describe('useChartSave: edits made while a save is in flight', () => {
  it('does not let the landing save clear a newer edit, and sends the newer one after it', async () => {
    const { result, save } = setup();

    save(V1);
    await advance(300);
    expect(requests).toHaveLength(1);

    // Edit while the first save is still in flight (e.g. a slider paused
    // for half a second and moved again).
    await advance(150);
    save(V2);

    await requests[0].succeed();
    // The server holds V1, not V2: not saved, and nothing may say so.
    expect(result.current.hasPendingChanges).toBe(true);
    expect(result.current.isSaving).toBe(true);
    expect(result.current.pendingChangesRef.current).toBe(V2);

    await advance(300);
    expect(requests).toHaveLength(2);
    expect(requests[1].data).toBe(V2);

    await requests[1].succeed();
    expect(serverData).toBe(V2);
    expect(result.current.hasPendingChanges).toBe(false);
    expect(result.current.isSaving).toBe(false);
    expect(maxInFlight).toBe(1);
  });

  it('holds a debounced edit that comes due mid-flight and sends it as soon as the save lands', async () => {
    const { result, save } = setup();

    save(V1);
    await advance(300);
    save(V2);

    // The debounce for V2 comes due while the slow first save is still out.
    await advance(400);
    expect(requests).toHaveLength(1);
    expect(maxInFlight).toBe(1);

    await requests[0].succeed();
    // No second debounce wait: it goes out right away.
    expect(requests).toHaveLength(2);
    expect(requests[1].data).toBe(V2);
    expect(result.current.hasPendingChanges).toBe(true);

    await requests[1].succeed();
    expect(serverData).toBe(V2);
    expect(result.current.hasPendingChanges).toBe(false);
  });

  it('ends with the last edit on the server however many land mid-flight', async () => {
    const { result, save } = setup();

    save(V1);
    await advance(300);
    save(V2);
    await requests[0].succeed();
    await advance(300);
    save(V3);
    await requests[1].succeed();
    await advance(300);
    expect(requests).toHaveLength(3);
    await requests[2].succeed();

    expect(serverData).toBe(V3);
    expect(result.current.hasPendingChanges).toBe(false);
    expect(maxInFlight).toBe(1);
  });
});

describe('useChartSave: failures', () => {
  const networkError = () => new TypeError('Failed to fetch');

  it('stays visibly unsaved, retries after a backoff, and recovers when the server does', async () => {
    const { result, save, onSaveFailed } = setup();

    save(V1);
    await advance(300);
    await requests[0].fail(networkError());

    expect(result.current.saveError).toEqual({ message: 'Failed to fetch' });
    expect(result.current.hasPendingChanges).toBe(true);
    expect(result.current.pendingChangesRef.current).toBe(V1);
    expect(onSaveFailed).toHaveBeenCalledWith(V1);
    // Waiting out the backoff still counts as saving: the edit is not abandoned.
    expect(result.current.isSaving).toBe(true);

    // First retry after the first backoff step.
    await advance(1000);
    expect(requests).toHaveLength(2);
    expect(requests[1].data).toBe(V1);
    // Still failed while the retry is out.
    expect(result.current.saveError).not.toBeNull();
    expect(result.current.hasPendingChanges).toBe(true);
    expect(result.current.isSaving).toBe(true);

    await requests[1].succeed();
    expect(result.current.saveError).toBeNull();
    expect(result.current.hasPendingChanges).toBe(false);
    expect(result.current.isSaving).toBe(false);
  });

  it('retries a request that timed out without an answer, and does not stay blocked behind it', async () => {
    const { result, save } = setup();

    save(V1);
    await advance(300);
    await requests[0].fail(
      Object.assign(new Error('No answer within 30s'), { name: 'TimeoutError' }),
    );
    expect(result.current.saveError).toEqual({ message: 'No answer within 30s' });

    save(V2);
    await advance(300);
    expect(requests).toHaveLength(2);
    expect(requests[1].data).toBe(V2);
    await requests[1].succeed();
    expect(serverData).toBe(V2);
    expect(result.current.hasPendingChanges).toBe(false);
  });

  it('retries quickly at first, then every 30 seconds for as long as the edit is pending', async () => {
    const { result, save } = setup();
    const outage = () => new ChartApiError('Failed to update chart', 503);

    save(V1);
    await advance(300);
    await requests[0].fail(outage());

    // Three quick retries, each wait longer than the last.
    await advance(1000);
    expect(requests).toHaveLength(2);
    await requests[1].fail(outage());
    await advance(1999);
    expect(requests).toHaveLength(2);
    await advance(1);
    expect(requests).toHaveLength(3);
    await requests[2].fail(outage());
    await advance(4000);
    expect(requests).toHaveLength(4);
    await requests[3].fail(outage());

    // Then a capped interval, with no end while the edit stays unsaved.
    for (let attempt = 5; attempt <= 8; attempt++) {
      await advance(29_999);
      expect(requests).toHaveLength(attempt - 1);
      await advance(1);
      expect(requests).toHaveLength(attempt);
      await requests[attempt - 1].fail(outage());
      expect(result.current.saveError).toEqual({ message: 'Failed to update chart' });
      expect(result.current.hasPendingChanges).toBe(true);
    }
  });

  it('delivers the edit and shows Saved after an outage of over a minute, with no further edits', async () => {
    const { result, save } = setup();
    const outage = () => new TypeError('Failed to fetch');

    save(V1);
    await advance(300);
    await requests[0].fail(outage());
    // 1s + 2s + 4s of quick retries, then 30s intervals: past one minute.
    for (let i = 1; i <= 3; i++) {
      await advance(1000 * 2 ** (i - 1));
      await requests[i].fail(outage());
    }
    await advance(30_000);
    await requests[4].fail(outage());
    await advance(30_000);
    expect(requests).toHaveLength(6);
    expect(result.current.saveError).not.toBeNull();
    expect(result.current.hasPendingChanges).toBe(true);
    expect(serverData).toBeNull();

    await requests[5].succeed();

    expect(serverData).toBe(V1);
    expect(result.current.saveError).toBeNull();
    expect(result.current.hasPendingChanges).toBe(false);
    expect(result.current.isSaving).toBe(false);
    await advance(120_000);
    expect(requests).toHaveLength(6);
  });

  it('retries at once when the browser comes back online during a wait', async () => {
    const { result, save } = setup();

    save(V1);
    await advance(300);
    await requests[0].fail(new TypeError('Failed to fetch'));
    expect(requests).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].data).toBe(V1);

    await requests[1].succeed();
    expect(result.current.hasPendingChanges).toBe(false);
    await advance(60_000);
    expect(requests).toHaveLength(2);
  });

  it('retries at once when the tab becomes visible again, but not while it is hidden', async () => {
    const { save } = setup();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');

    save(V1);
    await advance(300);
    await requests[0].fail(new TypeError('Failed to fetch'));

    visibility.mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(requests).toHaveLength(1);

    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(requests).toHaveLength(2);
    visibility.mockRestore();
  });

  it('does not send early on online or visibility events when no save has failed', async () => {
    const { save } = setup();

    save(V1);
    await advance(100);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(requests).toHaveLength(0);

    await advance(200);
    expect(requests).toHaveLength(1);
  });

  it('does not cut the wait after a refused save short on online or visibility events', async () => {
    const { save } = setup();

    save(V1);
    await advance(300);
    await requests[0].fail(new ChartApiError('Invalid or expired authentication.', 403));

    await advance(1000);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(requests).toHaveLength(1);

    await advance(29_000);
    expect(requests).toHaveLength(2);
  });

  it('starts over with a fast attempt when a new edit arrives during a long wait', async () => {
    const { save } = setup();
    const outage = () => new TypeError('Failed to fetch');

    save(V1);
    await advance(300);
    await requests[0].fail(outage());
    for (let i = 1; i <= 3; i++) {
      await advance(1000 * 2 ** (i - 1));
      await requests[i].fail(outage());
    }
    // Now in the 30s wait.
    await advance(10_000);
    expect(requests).toHaveLength(4);

    save(V2);
    await advance(300);
    expect(requests).toHaveLength(5);
    expect(requests[4].data).toBe(V2);
    await requests[4].fail(outage());

    // The quick schedule applies again.
    await advance(1000);
    expect(requests).toHaveLength(6);
  });

  it('stops retrying once the editor has unmounted', async () => {
    const { save, unmount } = setup();
    const outage = () => new TypeError('Failed to fetch');

    save(V1);
    await advance(300);
    await requests[0].fail(outage());
    unmount();

    // The one last attempt on the way out fails too.
    expect(requests).toHaveLength(2);
    await requests[1].fail(outage());

    await advance(300_000);
    expect(requests).toHaveLength(2);
  });

  // A 401/403 can come from an auth token that failed to resolve once, so
  // the edit is not left waiting for another edit; a refusal that is real
  // is not worth hammering, so it is retried only at the slow interval.
  it.each([401, 403])(
    'retries a %i every 30 seconds, never quickly, and shows Saved once the server accepts',
    async (status) => {
      const { result, save } = setup();
      const refusal = () => new ChartApiError('Invalid or expired authentication.', status);

      save(V1);
      await advance(300);
      await requests[0].fail(refusal());
      expect(result.current.saveError).toEqual({ message: 'Invalid or expired authentication.' });
      expect(result.current.hasPendingChanges).toBe(true);
      expect(result.current.isSaving).toBe(true);

      for (let attempt = 2; attempt <= 4; attempt++) {
        await advance(29_999);
        expect(requests).toHaveLength(attempt - 1);
        await advance(1);
        expect(requests).toHaveLength(attempt);
        expect(requests[attempt - 1].data).toBe(V1);
        if (attempt < 4) await requests[attempt - 1].fail(refusal());
      }

      await requests[3].succeed();
      expect(serverData).toBe(V1);
      expect(result.current.saveError).toBeNull();
      expect(result.current.hasPendingChanges).toBe(false);
      expect(result.current.isSaving).toBe(false);
    },
  );

  it('does not retry a 404, which no retry can fix', async () => {
    const { save } = setup();

    save(V1);
    await advance(300);
    await requests[0].fail(new ChartApiError('Chart not found or invalid edit token', 404));

    await advance(60_000);
    expect(requests).toHaveLength(1);
  });

  it('sends the next edit made after a save the server will not accept, and recovers on success', async () => {
    const { result, save } = setup();

    save(V1);
    await advance(300);
    await requests[0].fail(new ChartApiError('Chart not found or invalid edit token', 404));
    expect(result.current.isSaving).toBe(false);

    save(V2);
    await advance(300);
    expect(requests).toHaveLength(2);
    expect(requests[1].data).toBe(V2);
    await requests[1].succeed();

    expect(result.current.saveError).toBeNull();
    expect(result.current.hasPendingChanges).toBe(false);
  });

  it('sends an edit made during a retry wait with the next debounce, not after the backoff', async () => {
    const { result, save } = setup();

    save(V1);
    await advance(300);
    await requests[0].fail(networkError());

    await advance(400);
    save(V2);
    await advance(300);

    expect(requests).toHaveLength(2);
    expect(requests[1].data).toBe(V2);
    // Still failed until a save succeeds.
    expect(result.current.saveError).not.toBeNull();

    await requests[1].succeed();
    expect(serverData).toBe(V2);
    expect(result.current.saveError).toBeNull();
    expect(result.current.hasPendingChanges).toBe(false);

    // The abandoned backoff timer must not send anything afterwards.
    await advance(10_000);
    expect(requests).toHaveLength(2);
  });

  it('keeps a newer edit pending when the retry that carried an older one succeeds', async () => {
    const { result, save } = setup();

    save(V1);
    await advance(300);
    await requests[0].fail(networkError());
    await advance(1000);
    expect(requests).toHaveLength(2);

    save(V2);
    await requests[1].succeed();

    expect(result.current.hasPendingChanges).toBe(true);
    expect(result.current.pendingChangesRef.current).toBe(V2);
    await advance(300);
    expect(requests).toHaveLength(3);
    expect(requests[2].data).toBe(V2);
  });

  it('sends an edit that came due during the failed save after the backoff', async () => {
    const { save } = setup();

    save(V1);
    await advance(300);
    save(V2);
    // V2's debounce comes due while the first save is still out and is held.
    await advance(400);
    expect(requests).toHaveLength(1);

    await requests[0].fail(networkError());
    expect(requests).toHaveLength(1);

    await advance(1000);
    expect(requests).toHaveLength(2);
    expect(requests[1].data).toBe(V2);
  });

  it('makes one last attempt when the editor unmounts during a retry wait', async () => {
    const { save, unmount } = setup();

    save(V1);
    await advance(300);
    await requests[0].fail(networkError());

    unmount();

    expect(requests).toHaveLength(2);
    expect(requests[1].data).toBe(V1);
  });

  it('sends an edit still waiting behind a running save even if the editor unmounts first', async () => {
    const { save, unmount } = setup();

    save(V1);
    await advance(300);
    save(V2);
    unmount();

    // V2 waits behind the running save, then goes out when it lands.
    expect(requests).toHaveLength(1);
    await requests[0].succeed();
    expect(requests).toHaveLength(2);
    expect(requests[1].data).toBe(V2);
  });
});
