// useChartSave: the network side of the chart document's saves.
//
// The contract under test, in the user's terms:
//   - one save in flight at a time; an edit made meanwhile waits and goes
//     out when the running save lands, so an older save can never land
//     after a newer one
//   - each save names the version the previous acknowledgement returned
//   - a save the server answers with a newer chart (409) is merged and sent
//     again at once, with no further wait
//   - "Saved" (nothing unsaved, no error) only once the server holds the
//     latest local data: a save that lands must not clear edits made after
//     it was sent
//   - a failed save keeps the edits pending and the failure visible and
//     retries for as long as they stay pending: quickly at first, then
//     every 30 seconds for network errors and 5xx, and only every 30
//     seconds for 401/403 (which a transient token failure can cause);
//     other 4xx are not retried
//   - a chart the merge cannot handle, and a server that went back to an
//     older version, stop saving with a visible error and one report that
//     carries versions and no chart content
//
// The document is the real one, so the merge in these tests is the merge the
// app runs; the network is a mocked ChartService whose requests the tests
// settle by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useChartSave } from '../../src/hooks/useChartSave';
import { ChartApiError, ChartService } from '../../src/services/chartService';
import { loggingService } from '../../src/services/loggingService';
import { ChartDocument, type ServerState } from '../../src/sync/ChartDocument';
import { ChartShapeError } from '../../shared/chart-model';
import type { ToCData } from '../../src/types';
import { edit as editChart, findNode, nodeIn, seedChart } from '../shared/chart-fixtures';
import { deepFreeze } from './helpers/deepFreeze';

vi.mock('../../src/services/chartService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/chartService')>();
  return { ...actual, ChartService: { updateChart: vi.fn() } };
});

vi.mock('../../src/services/loggingService', () => ({
  loggingService: { reportError: vi.fn(), getCurrentChartId: vi.fn(() => 'chart-1') },
}));

const mockUpdateChart = vi.mocked(ChartService.updateChart);
const mockReportError = vi.mocked(loggingService.reportError);

const WENT_BACKWARDS = 'The saved chart went back to an older version. Reload to continue.';

const chart = (title: string): ToCData => ({ title, sections: [] });
const BASE = chart('base');
const V1 = chart('v1');
const V2 = chart('v2');
const V3 = chart('v3');

interface Request {
  token: string;
  chart: ToCData;
  baseVersion: number;
  /** The server accepts the save; `version` defaults to one past the last one it holds. */
  saved: (version?: number) => Promise<void>;
  /** The server answers 409 with `theirs`. */
  conflict: (theirs: ServerState) => Promise<void>;
  fail: (err: unknown) => Promise<void>;
}

let requests: Request[];
let inFlight: number;
let maxInFlight: number;
/** What the server would hold: the last save that succeeded. */
let serverChart: ToCData | null;
let serverVersion: number;

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

const START_VERSION = 3;

/** A document on the server at version 3 holding `server`, or, with no `server`, one for a chart that does not exist yet. */
function setup(server: ToCData | null = BASE) {
  const doc = new ChartDocument({
    chart: server ?? BASE,
    editToken: server ? 'tok' : null,
    server: server ? { version: START_VERSION, chart: server } : null,
  });
  const onSaveFailed = vi.fn<(data: ToCData) => void>();
  const rendered = renderHook(() => useChartSave({ doc, onSaveFailed }));
  const edit = (next: ToCData) => act(() => doc.edit(() => next));
  return { ...rendered, doc, onSaveFailed, edit };
}

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  inFlight = 0;
  maxInFlight = 0;
  serverChart = null;
  serverVersion = START_VERSION;
  mockUpdateChart.mockImplementation(
    (token, data, baseVersion) =>
      new Promise((resolve, reject) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        requests.push({
          token,
          chart: data,
          baseVersion,
          saved: (version = serverVersion + 1) =>
            settle(() => {
              inFlight -= 1;
              serverChart = data;
              serverVersion = version;
              resolve({ status: 'saved', version });
            }),
          conflict: (theirs) =>
            settle(() => {
              inFlight -= 1;
              serverVersion = theirs.version;
              resolve({ status: 'conflict', theirs });
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
    const { result, doc, edit } = setup();

    edit(V1);
    expect(doc.getStatus().unsaved).toBe(true);
    expect(result.current.isSaving).toBe(true);
    expect(requests).toHaveLength(0);

    await advance(300);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ token: 'tok', chart: V1, baseVersion: 3 });

    await requests[0].saved();
    expect(doc.getStatus().unsaved).toBe(false);
    expect(result.current.isSaving).toBe(false);
    expect(result.current.saveError).toBeNull();

    // Nothing is left armed to run again once the chart is saved.
    await advance(10_000);
    expect(requests).toHaveLength(1);
    expect(result.current.isSaving).toBe(false);
  });

  it('sends only the latest of a burst of edits inside the debounce window', async () => {
    const { edit } = setup();

    edit(V1);
    await advance(100);
    edit(V2);
    await advance(100);
    edit(V3);
    // Each edit pushes the send back: 300 ms after the last one, not after the first.
    await advance(299);
    expect(requests).toHaveLength(0);
    await advance(1);

    expect(requests).toHaveLength(1);
    expect(requests[0].chart).toBe(V3);
  });

  it('names the version each acknowledgement returned in the next save', async () => {
    const { edit } = setup();

    edit(V1);
    await advance(300);
    expect(requests[0].baseVersion).toBe(3);
    await requests[0].saved(4);

    edit(V2);
    await advance(300);
    expect(requests[1].baseVersion).toBe(4);
    await requests[1].saved(9);

    edit(V3);
    await advance(300);
    expect(requests[2].baseVersion).toBe(9);
  });

  it('keeps edits pending, without sending, while the chart has no edit token', async () => {
    const { result, doc, edit } = setup(null);

    edit(V1);
    await advance(1000);
    expect(requests).toHaveLength(0);
    expect(doc.getStatus().unsaved).toBe(true);
    expect(result.current.isSaving).toBe(false);

    // The chart gets created: the next edit saves normally.
    act(() => doc.attachServer('new-tok', { version: 1, chart: BASE }));
    edit(V2);
    await advance(300);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ token: 'new-tok', chart: V2, baseVersion: 1 });
  });

  it('sends edits made before the chart existed once its edit token arrives, with no further edit', async () => {
    const { result, doc, edit } = setup(null);

    // Edited while the chart was still being created.
    edit(V1);
    await advance(1000);
    expect(requests).toHaveLength(0);

    act(() => doc.attachServer('new-tok', { version: 1, chart: BASE }));
    await advance(300);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ token: 'new-tok', chart: V1, baseVersion: 1 });
    expect(result.current.isSaving).toBe(true);

    await requests[0].saved();
    expect(serverChart).toBe(V1);
    expect(doc.getStatus().unsaved).toBe(false);
    expect(result.current.isSaving).toBe(false);
  });

  it('does not report Saving or send anything when the edit token arrives with no edit pending', async () => {
    const { result, doc } = setup(null);

    // Opening an existing chart: the token arrives with nothing to save.
    act(() => doc.attachServer('tok', { version: 1, chart: BASE }));
    expect(result.current.isSaving).toBe(false);
    await advance(1000);

    expect(requests).toHaveLength(0);
    expect(result.current.isSaving).toBe(false);
    expect(doc.getStatus().unsaved).toBe(false);
  });

  it('sends a debounced edit that is still waiting when the editor unmounts', async () => {
    const { edit, unmount } = setup();

    edit(V1);
    unmount();

    expect(requests).toHaveLength(1);
    expect(requests[0].chart).toBe(V1);
  });
});

describe('useChartSave: a save the server answers with a newer chart', () => {
  const seed = deepFreeze(seedChart());
  const retitle = (from: ToCData, id: string, title: string) =>
    deepFreeze(
      editChart(from, (draft) => {
        nodeIn(draft, id).title = title;
      }),
    );

  it('merges it and sends again at once, on the version it carried', async () => {
    const { doc, edit } = setup(seed);

    edit(retitle(seed, 'a', 'Mine'));
    await advance(300);
    expect(requests).toHaveLength(1);
    expect(requests[0].baseVersion).toBe(3);

    await requests[0].conflict({ version: 5, chart: retitle(seed, 'b', 'Theirs') });

    // No further timer advance: the resend carries both edits.
    expect(requests).toHaveLength(2);
    expect(requests[1].baseVersion).toBe(5);
    expect(findNode(requests[1].chart, 'a')?.title).toBe('Mine');
    expect(findNode(requests[1].chart, 'b')?.title).toBe('Theirs');
    expect(maxInFlight).toBe(1);

    await requests[1].saved(6);
    expect(doc.getStatus().unsaved).toBe(false);
  });

  it('keeps a failed resend visible and retries it like any failed save', async () => {
    const { result, doc, edit } = setup(seed);

    edit(retitle(seed, 'a', 'Mine'));
    await advance(300);
    await requests[0].conflict({ version: 5, chart: retitle(seed, 'b', 'Theirs') });
    await requests[1].fail(new TypeError('Failed to fetch'));

    expect(result.current.saveError).toEqual({ message: 'Failed to fetch' });
    expect(doc.getStatus().unsaved).toBe(true);
    await advance(1000);
    expect(requests).toHaveLength(3);
    expect(requests[2].baseVersion).toBe(5);
  });
});

describe('useChartSave: a save that cannot continue', () => {
  const seed = deepFreeze(seedChart());
  const edited = deepFreeze(
    editChart(seed, (draft) => {
      nodeIn(draft, 'a').title = 'A private title';
    }),
  );
  /** A chart the merge refuses: two sections share an id. */
  const repeatedSectionId = () => {
    const bad = structuredClone(seed);
    bad.sections[1].id = bad.sections[0].id;
    return deepFreeze(bad);
  };

  it('shows a failed merge, reports versions without chart content, and does not retry', async () => {
    const { result, doc, edit, onSaveFailed } = setup(seed);

    edit(edited);
    await advance(300);
    await requests[0].conflict({ version: 5, chart: repeatedSectionId() });

    // The pill says that saving stopped and what to do, not just the merge's own wording.
    expect(result.current.saveError?.message).toMatch(
      /^Saving has stopped \(Chart repeats section id .+\)\. Reload to continue\.$/,
    );
    expect(result.current.isSaving).toBe(false);
    expect(onSaveFailed).toHaveBeenCalledWith(edited);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    const report = mockReportError.mock.calls[0][0];
    expect(report).toMatchObject({
      error_name: 'ChartMergeFailed',
      chart_id: 'chart-1',
      request_metadata: { baseVersion: 3, serverVersion: 5 },
    });
    expect(JSON.stringify(report)).not.toContain('A private title');

    await advance(300_000);
    expect(requests).toHaveLength(1);

    // The document keeps what the user typed, and a later edit does not start a loop of failing saves.
    expect(doc.getCommitted()).toBe(edited);
    edit(V1);
    await advance(300_000);
    expect(requests).toHaveLength(1);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('treats a conflict chart the service could not normalise the same way', async () => {
    const { result, doc, edit } = setup(seed);

    edit(edited);
    await advance(300);
    await requests[0].fail(new ChartShapeError({ title: 'not a chart' }, 'The chart is malformed'));

    expect(result.current.saveError?.message).toMatch(
      /^Saving has stopped \(.*The chart is malformed.*\)\. Reload to continue\.$/,
    );
    expect(doc.getStatus().saving).toBe(false);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][0]).toMatchObject({
      error_name: 'ChartMergeFailed',
      request_metadata: { baseVersion: 3 },
    });
    expect(JSON.stringify(mockReportError.mock.calls[0][0])).not.toContain('not a chart');
    await advance(300_000);
    expect(requests).toHaveLength(1);
  });

  it('does not send an edit that was waiting behind the save when the merge failed', async () => {
    const { edit } = setup(seed);

    edit(edited);
    await advance(300);
    edit(
      deepFreeze(
        editChart(edited, (draft) => {
          nodeIn(draft, 'a').title = 'Typed meanwhile';
        }),
      ),
    );
    await requests[0].conflict({ version: 5, chart: repeatedSectionId() });
    await advance(300_000);

    expect(requests).toHaveLength(1);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('saves a different document normally after the previous one stopped', async () => {
    const open = () =>
      new ChartDocument({ chart: seed, editToken: 'tok', server: { version: 3, chart: seed } });
    const first = open();
    const second = open();
    const { rerender } = renderHook(({ doc }) => useChartSave({ doc }), {
      initialProps: { doc: first },
    });

    act(() => first.edit(() => edited));
    await advance(300);
    await requests[0].conflict({ version: 5, chart: repeatedSectionId() });
    await advance(300_000);
    expect(requests).toHaveLength(1);

    rerender({ doc: second });
    act(() => second.edit(() => edited));
    await advance(300);
    expect(requests).toHaveLength(2);
  });

  it('shows and reports a server that went back to an older version, once, and stops saving', async () => {
    const { result, doc, edit } = setup(seed);

    edit(edited);
    await advance(300);
    await requests[0].conflict({ version: 2, chart: seed });

    expect(result.current.saveError).toEqual({ message: WENT_BACKWARDS });
    expect(result.current.isSaving).toBe(false);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(mockReportError.mock.calls[0][0]).toMatchObject({
      request_metadata: { baseVersion: 3, serverVersion: 2 },
    });

    edit(
      deepFreeze(
        editChart(edited, (draft) => {
          nodeIn(draft, 'a').title = 'Again';
        }),
      ),
    );
    await advance(300_000);
    expect(requests).toHaveLength(1);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect(doc.getStatus().terminalError).toBe(WENT_BACKWARDS);
  });
});

describe('useChartSave: edits made while a save is in flight', () => {
  it('does not let the landing save clear a newer edit, and sends the newer one after it', async () => {
    const { result, doc, edit } = setup();

    edit(V1);
    await advance(300);
    expect(requests).toHaveLength(1);

    // Edit while the first save is still in flight (e.g. a slider paused
    // for half a second and moved again).
    await advance(150);
    edit(V2);

    await requests[0].saved(4);
    // The server holds V1, not V2: not saved, and nothing may say so.
    expect(doc.getStatus().unsaved).toBe(true);
    expect(result.current.isSaving).toBe(true);
    expect(doc.getCommitted()).toBe(V2);

    await advance(300);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ chart: V2, baseVersion: 4 });

    await requests[1].saved();
    expect(serverChart).toBe(V2);
    expect(doc.getStatus().unsaved).toBe(false);
    expect(result.current.isSaving).toBe(false);
    expect(maxInFlight).toBe(1);
  });

  it('holds a debounced edit that comes due mid-flight and sends it as soon as the save lands', async () => {
    const { doc, edit } = setup();

    edit(V1);
    await advance(300);
    edit(V2);

    // The debounce for V2 comes due while the slow first save is still out.
    await advance(400);
    expect(requests).toHaveLength(1);
    expect(maxInFlight).toBe(1);

    await requests[0].saved(4);
    // No second debounce wait: it goes out right away.
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ chart: V2, baseVersion: 4 });
    expect(doc.getStatus().unsaved).toBe(true);

    await requests[1].saved();
    expect(serverChart).toBe(V2);
    expect(doc.getStatus().unsaved).toBe(false);
  });

  it('ends with the last edit on the server however many land mid-flight', async () => {
    const { doc, edit } = setup();

    edit(V1);
    await advance(300);
    edit(V2);
    await requests[0].saved();
    await advance(300);
    edit(V3);
    await requests[1].saved();
    await advance(300);
    expect(requests).toHaveLength(3);
    await requests[2].saved();

    expect(serverChart).toBe(V3);
    expect(doc.getStatus().unsaved).toBe(false);
    expect(maxInFlight).toBe(1);
  });
});

describe('useChartSave: failures', () => {
  const networkError = () => new TypeError('Failed to fetch');

  it('stays visibly unsaved, retries after a backoff, and recovers when the server does', async () => {
    const { result, doc, edit, onSaveFailed } = setup();

    edit(V1);
    await advance(300);
    await requests[0].fail(networkError());

    expect(result.current.saveError).toEqual({ message: 'Failed to fetch' });
    expect(doc.getStatus().unsaved).toBe(true);
    expect(doc.getCommitted()).toBe(V1);
    expect(onSaveFailed).toHaveBeenCalledWith(V1);
    // Waiting out the backoff still counts as saving: the edit is not abandoned.
    expect(result.current.isSaving).toBe(true);

    // First retry after the first backoff step.
    await advance(1000);
    expect(requests).toHaveLength(2);
    expect(requests[1].chart).toBe(V1);
    // Still failed while the retry is out.
    expect(result.current.saveError).not.toBeNull();
    expect(doc.getStatus().unsaved).toBe(true);
    expect(result.current.isSaving).toBe(true);

    await requests[1].saved();
    expect(result.current.saveError).toBeNull();
    expect(doc.getStatus().unsaved).toBe(false);
    expect(result.current.isSaving).toBe(false);
  });

  it('retries a request that timed out without an answer, and does not stay blocked behind it', async () => {
    const { result, doc, edit } = setup();

    edit(V1);
    await advance(300);
    await requests[0].fail(
      Object.assign(new Error('No answer within 30s'), { name: 'TimeoutError' }),
    );
    expect(result.current.saveError).toEqual({ message: 'No answer within 30s' });

    edit(V2);
    await advance(300);
    expect(requests).toHaveLength(2);
    expect(requests[1].chart).toBe(V2);
    await requests[1].saved();
    expect(serverChart).toBe(V2);
    expect(doc.getStatus().unsaved).toBe(false);
  });

  it('retries quickly at first, then every 30 seconds for as long as the edit is pending', async () => {
    const { result, doc, edit } = setup();
    const outage = () => new ChartApiError('Failed to update chart', 503);

    edit(V1);
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
      expect(doc.getStatus().unsaved).toBe(true);
    }
  });

  it('delivers the edit and shows Saved after an outage of over a minute, with no further edits', async () => {
    const { result, doc, edit } = setup();
    const outage = () => new TypeError('Failed to fetch');

    edit(V1);
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
    expect(doc.getStatus().unsaved).toBe(true);
    expect(serverChart).toBeNull();

    await requests[5].saved();

    expect(serverChart).toBe(V1);
    expect(result.current.saveError).toBeNull();
    expect(doc.getStatus().unsaved).toBe(false);
    expect(result.current.isSaving).toBe(false);
    await advance(120_000);
    expect(requests).toHaveLength(6);
  });

  it('retries at once when the browser comes back online during a wait', async () => {
    const { doc, edit } = setup();

    edit(V1);
    await advance(300);
    await requests[0].fail(new TypeError('Failed to fetch'));
    expect(requests).toHaveLength(1);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    expect(requests).toHaveLength(2);
    expect(requests[1].chart).toBe(V1);

    await requests[1].saved();
    expect(doc.getStatus().unsaved).toBe(false);
    await advance(60_000);
    expect(requests).toHaveLength(2);
  });

  it('retries at once when the tab becomes visible again, but not while it is hidden', async () => {
    const { edit } = setup();
    const visibility = vi.spyOn(document, 'visibilityState', 'get');

    edit(V1);
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
    const { edit } = setup();

    edit(V1);
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
    const { edit } = setup();

    edit(V1);
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
    const { edit } = setup();
    const outage = () => new TypeError('Failed to fetch');

    edit(V1);
    await advance(300);
    await requests[0].fail(outage());
    for (let i = 1; i <= 3; i++) {
      await advance(1000 * 2 ** (i - 1));
      await requests[i].fail(outage());
    }
    // Now in the 30s wait.
    await advance(10_000);
    expect(requests).toHaveLength(4);

    edit(V2);
    await advance(300);
    expect(requests).toHaveLength(5);
    expect(requests[4].chart).toBe(V2);
    await requests[4].fail(outage());

    // The quick schedule applies again.
    await advance(1000);
    expect(requests).toHaveLength(6);
  });

  it('stops retrying once the editor has unmounted', async () => {
    const { edit, unmount } = setup();
    const outage = () => new TypeError('Failed to fetch');

    edit(V1);
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
      const { result, doc, edit } = setup();
      const refusal = () => new ChartApiError('Invalid or expired authentication.', status);

      edit(V1);
      await advance(300);
      await requests[0].fail(refusal());
      expect(result.current.saveError).toEqual({ message: 'Invalid or expired authentication.' });
      expect(doc.getStatus().unsaved).toBe(true);
      expect(result.current.isSaving).toBe(true);

      for (let attempt = 2; attempt <= 4; attempt++) {
        await advance(29_999);
        expect(requests).toHaveLength(attempt - 1);
        await advance(1);
        expect(requests).toHaveLength(attempt);
        expect(requests[attempt - 1].chart).toBe(V1);
        if (attempt < 4) await requests[attempt - 1].fail(refusal());
      }

      await requests[3].saved();
      expect(serverChart).toBe(V1);
      expect(result.current.saveError).toBeNull();
      expect(doc.getStatus().unsaved).toBe(false);
      expect(result.current.isSaving).toBe(false);
    },
  );

  describe('a failed save whose data the server turns out to hold', () => {
    // A save lands but its acknowledgement is lost: the retry sends the old base and is answered
    // with a conflict carrying exactly what was sent.
    it('stops showing the failure when the retry finds the server already holds the chart', async () => {
      const { result, doc, edit } = setup();

      edit(V1);
      await advance(300);
      await requests[0].fail(
        Object.assign(new Error('No answer within 30s'), { name: 'TimeoutError' }),
      );
      expect(result.current.saveError).not.toBeNull();

      await advance(1000);
      expect(requests).toHaveLength(2);
      expect(requests[1].baseVersion).toBe(3);
      await requests[1].conflict({ version: 4, chart: V1 });

      expect(doc.getStatus().unsaved).toBe(false);
      expect(result.current.saveError).toBeNull();
      expect(result.current.isSaving).toBe(false);
      expect(requests).toHaveLength(2);
    });

    it('stops showing the failure when a poll lands the same chart during the wait', async () => {
      const { result, doc, edit } = setup();

      edit(V1);
      await advance(300);
      await requests[0].fail(networkError());
      expect(result.current.saveError).not.toBeNull();

      act(() => doc.receiveRemote({ version: 4, chart: V1 }));
      await advance(300);

      expect(doc.getStatus().unsaved).toBe(false);
      expect(result.current.saveError).toBeNull();
      expect(result.current.isSaving).toBe(false);
      expect(requests).toHaveLength(1);
    });

    it('leaves an error the app set itself, such as a failed delete', async () => {
      const { result, doc, edit } = setup();

      edit(V1);
      await advance(300);
      await requests[0].fail(networkError());
      act(() => result.current.setSaveError({ message: 'Delete failed' }));

      act(() => doc.receiveRemote({ version: 4, chart: V1 }));
      await advance(300);

      expect(result.current.saveError).toEqual({ message: 'Delete failed' });
    });
  });

  it('does not retry a 404, which no retry can fix', async () => {
    const { edit } = setup();

    edit(V1);
    await advance(300);
    await requests[0].fail(new ChartApiError('Chart not found or invalid edit token', 404));

    await advance(60_000);
    expect(requests).toHaveLength(1);
  });

  it('does not retry a success that carries no version, which would answer the same again', async () => {
    const { result, edit } = setup();

    edit(V1);
    await advance(300);
    await requests[0].fail(new ChartApiError('The server did not return a version', 200));

    expect(result.current.saveError).not.toBeNull();
    await advance(60_000);
    expect(requests).toHaveLength(1);
  });

  it('sends the next edit made after a save the server will not accept, and recovers on success', async () => {
    const { result, doc, edit } = setup();

    edit(V1);
    await advance(300);
    await requests[0].fail(new ChartApiError('Chart not found or invalid edit token', 404));
    expect(result.current.isSaving).toBe(false);

    edit(V2);
    await advance(300);
    expect(requests).toHaveLength(2);
    expect(requests[1].chart).toBe(V2);
    await requests[1].saved();

    expect(result.current.saveError).toBeNull();
    expect(doc.getStatus().unsaved).toBe(false);
  });

  it('sends an edit made during a retry wait with the next debounce, not after the backoff', async () => {
    const { result, doc, edit } = setup();

    edit(V1);
    await advance(300);
    await requests[0].fail(networkError());

    await advance(400);
    edit(V2);
    await advance(300);

    expect(requests).toHaveLength(2);
    expect(requests[1].chart).toBe(V2);
    // Still failed until a save succeeds.
    expect(result.current.saveError).not.toBeNull();

    await requests[1].saved();
    expect(serverChart).toBe(V2);
    expect(result.current.saveError).toBeNull();
    expect(doc.getStatus().unsaved).toBe(false);

    // The abandoned backoff timer must not send anything afterwards.
    await advance(10_000);
    expect(requests).toHaveLength(2);
  });

  it('keeps a newer edit pending when the retry that carried an older one succeeds', async () => {
    const { doc, edit } = setup();

    edit(V1);
    await advance(300);
    await requests[0].fail(networkError());
    await advance(1000);
    expect(requests).toHaveLength(2);

    edit(V2);
    await requests[1].saved(4);

    expect(doc.getStatus().unsaved).toBe(true);
    expect(doc.getCommitted()).toBe(V2);
    await advance(300);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toMatchObject({ chart: V2, baseVersion: 4 });
  });

  it('sends an edit that came due during the failed save after the backoff', async () => {
    const { edit } = setup();

    edit(V1);
    await advance(300);
    edit(V2);
    // V2's debounce comes due while the first save is still out and is held.
    await advance(400);
    expect(requests).toHaveLength(1);

    await requests[0].fail(networkError());
    expect(requests).toHaveLength(1);

    await advance(1000);
    expect(requests).toHaveLength(2);
    expect(requests[1].chart).toBe(V2);
  });

  it('makes one last attempt when the editor unmounts during a retry wait', async () => {
    const { edit, unmount } = setup();

    edit(V1);
    await advance(300);
    await requests[0].fail(networkError());

    unmount();

    expect(requests).toHaveLength(2);
    expect(requests[1].chart).toBe(V1);
  });

  it('sends an edit still waiting behind a running save even if the editor unmounts first', async () => {
    const { edit, unmount } = setup();

    edit(V1);
    await advance(300);
    edit(V2);
    unmount();

    // V2 waits behind the running save, then goes out when it lands.
    expect(requests).toHaveLength(1);
    await requests[0].saved(4);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ chart: V2, baseVersion: 4 });
  });
});
