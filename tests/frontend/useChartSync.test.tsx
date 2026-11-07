// useChartSync: the version check an open editor makes every 2.5 seconds.
//
// The contract under test, in the user's terms:
//   - while the editor is in use, the server is asked for its version every
//     2.5 s, and the chart travels (and is merged) only when the version
//     differs from the one the document holds
//   - nothing is asked while the tab is hidden, after 5 minutes without
//     activity, during a pointer drag, while a save is in flight, or for a
//     chart that does not exist yet; none of that ends the polling
//   - a chart that arrives after a drag began is not applied (the next check
//     fetches it again once the drag is over)
//   - one request at a time; coming back to the tab or to the editor after a
//     long idle checks at once
//   - a failed check waits 30 s and then carries on; a chart the merge cannot
//     use is reported once per server version, with versions only
//
// The document is the real one; the network is a mocked ChartService.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useChartSync } from '../../src/hooks/useChartSync';
import { ChartApiError, ChartService } from '../../src/services/chartService';
import { loggingService } from '../../src/services/loggingService';
import { ChartDocument } from '../../src/sync/ChartDocument';
import type { ToCData } from '../../src/types';
import { edit as editChart, findNode, nodeIn, seedChart } from '../shared/chart-fixtures';
import { deepFreeze } from './helpers/deepFreeze';

vi.mock('../../src/services/chartService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/chartService')>();
  return { ...actual, ChartService: { pollChart: vi.fn() } };
});

vi.mock('../../src/services/loggingService', () => ({
  loggingService: { reportError: vi.fn(), getCurrentChartId: vi.fn(() => 'chart-1') },
}));

const mockPollChart = vi.mocked(ChartService.pollChart);
const mockReportError = vi.mocked(loggingService.reportError);

const SEED = deepFreeze(seedChart());
const retitle = (from: ToCData, id: string, title: string) =>
  deepFreeze(
    editChart(from, (draft) => {
      nodeIn(draft, id).title = title;
    }),
  );
const titleOf = (chart: ToCData, id: string) => findNode(chart, id)?.title;

/** A chart the merge refuses: two sections share an id. */
function chartWithRepeatedSectionId(): ToCData {
  const bad = structuredClone(SEED);
  bad.sections[1].id = bad.sections[0].id;
  return deepFreeze(bad);
}

const MINUTE = 60_000;

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

/** A poll the test answers by hand, to act while it is in flight. */
function pendingPoll() {
  let resolve!: (value: Awaited<ReturnType<typeof ChartService.pollChart>>) => void;
  let reject!: (err: unknown) => void;
  mockPollChart.mockImplementationOnce(
    () =>
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return {
    resolve: (value: Awaited<ReturnType<typeof ChartService.pollChart>>) =>
      act(async () => {
        resolve(value);
        await Promise.resolve();
      }),
    reject: (err: unknown) =>
      act(async () => {
        reject(err);
        await Promise.resolve();
      }),
  };
}

function openDoc(version = 3) {
  return new ChartDocument({
    chart: SEED,
    editToken: 'tok',
    server: { version, chart: SEED },
  });
}

function setup(doc = openDoc(), authTokenReady = true) {
  const isDragInFlightRef = { current: false };
  const receiveRemote = vi.spyOn(doc, 'receiveRemote');
  const rendered = renderHook(
    ({ ready }: { ready: boolean }) =>
      useChartSync({ doc, authTokenReady: ready, isDragInFlightRef }),
    { initialProps: { ready: authTokenReady } },
  );
  return { ...rendered, doc, isDragInFlightRef, receiveRemote };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  mockPollChart.mockImplementation(async (_token, knownVersion) => ({ version: knownVersion }));
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  // Unmount first: a hook left mounted keeps its document listeners and
  // would answer the next test's visibility events.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('useChartSync: the cadence', () => {
  it('asks for the version every 2.5 s and never merges when it is unchanged', async () => {
    const { receiveRemote } = setup();

    await advance(2499);
    expect(mockPollChart).not.toHaveBeenCalled();
    await advance(1);
    expect(mockPollChart).toHaveBeenCalledTimes(1);
    expect(mockPollChart).toHaveBeenLastCalledWith('tok', 3);

    await advance(2500);
    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(3);
    expect(receiveRemote).not.toHaveBeenCalled();
  });

  it('does not log a line per quiet check', async () => {
    setup();

    await advance(60_000);

    expect(mockPollChart.mock.calls.length).toBeGreaterThan(20);
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('merges the chart that comes with a changed version, then polls from the new version', async () => {
    const theirs = retitle(SEED, 'b', 'Theirs');
    mockPollChart.mockResolvedValueOnce({ version: 4, chartData: theirs });
    const { doc, receiveRemote } = setup();

    await advance(2500);

    expect(receiveRemote).toHaveBeenCalledWith({ version: 4, chart: theirs });
    expect(doc.getStatus().serverVersion).toBe(4);
    expect(titleOf(doc.getCommitted(), 'b')).toBe('Theirs');

    await advance(2500);
    expect(mockPollChart).toHaveBeenLastCalledWith('tok', 4);
  });

  it('asks one question at a time, however long the server takes to answer', async () => {
    const slow = pendingPoll();
    setup();

    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(mockPollChart).toHaveBeenCalledTimes(1);

    await slow.resolve({ version: 3 });
    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(2);
  });

  it('does not start a second check when the tab becomes visible while one is still out', async () => {
    const slow = pendingPoll();
    setup();
    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(mockPollChart).toHaveBeenCalledTimes(1);

    await slow.resolve({ version: 3 });
    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(2);
  });

  it('does not poll until the auth token is ready', async () => {
    const { rerender } = setup(openDoc(), false);

    await advance(10_000);
    expect(mockPollChart).not.toHaveBeenCalled();

    rerender({ ready: true });
    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(1);
  });

  it('stops polling when the editor unmounts, even with a request still out', async () => {
    const slow = pendingPoll();
    const { unmount, doc, receiveRemote } = setup();
    await advance(2500);

    unmount();
    await slow.resolve({ version: 9, chartData: retitle(SEED, 'b', 'Late') });
    await advance(MINUTE);

    expect(mockPollChart).toHaveBeenCalledTimes(1);
    expect(receiveRemote).not.toHaveBeenCalled();
    expect(doc.getStatus().serverVersion).toBe(3);
  });
});

describe('useChartSync: when it does not ask', () => {
  it('skips while the tab is hidden and resumes with a check as soon as it is visible', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    setup();

    await advance(5 * 2500);
    expect(mockPollChart).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(mockPollChart).toHaveBeenCalledTimes(1);

    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(2);
  });

  it('skips after 5 minutes without activity and checks at once when the user returns', async () => {
    setup();
    await advance(6 * MINUTE);
    const callsWhenIdle = mockPollChart.mock.calls.length;
    await advance(MINUTE);
    expect(mockPollChart.mock.calls.length).toBe(callsWhenIdle);

    await act(async () => {
      document.dispatchEvent(new Event('mousemove'));
    });
    expect(mockPollChart.mock.calls.length).toBe(callsWhenIdle + 1);

    await advance(2500);
    expect(mockPollChart.mock.calls.length).toBe(callsWhenIdle + 2);
  });

  it('keeps polling for a user who stays active past 5 minutes', async () => {
    setup();
    for (let elapsed = 0; elapsed < 8 * MINUTE; elapsed += MINUTE) {
      document.dispatchEvent(new Event('keydown'));
      await advance(MINUTE);
    }
    const calls = mockPollChart.mock.calls.length;

    await advance(2500);
    expect(mockPollChart.mock.calls.length).toBe(calls + 1);
  });

  it('skips during a pointer drag and resumes when it ends', async () => {
    const { isDragInFlightRef } = setup();
    isDragInFlightRef.current = true;

    await advance(5 * 2500);
    expect(mockPollChart).not.toHaveBeenCalled();

    isDragInFlightRef.current = false;
    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(1);
  });

  it('skips while a save is in flight and resumes when it lands', async () => {
    const { doc } = setup();
    act(() => doc.edit((chart) => retitle(chart, 'a', 'Mine')));
    const save = doc.takeSave();
    expect(save).not.toBeNull();

    await advance(5 * 2500);
    expect(mockPollChart).not.toHaveBeenCalled();

    act(() => doc.saveSucceeded(4));
    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(1);
    expect(mockPollChart).toHaveBeenLastCalledWith('tok', 4);
  });

  it('skips for a chart that does not exist on the server yet, and starts once it does', async () => {
    const doc = new ChartDocument({ chart: SEED, editToken: null, server: null });
    setup(doc);

    await advance(5 * 2500);
    expect(mockPollChart).not.toHaveBeenCalled();

    act(() => doc.attachServer('new-tok', { version: 1, chart: SEED }));
    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(1);
    expect(mockPollChart).toHaveBeenLastCalledWith('new-tok', 1);
  });

  it('stops asking once the document has gone terminal, which only a reload can fix', async () => {
    const { doc } = setup();
    act(() => doc.edit((chart) => retitle(chart, 'a', 'Mine')));
    doc.takeSave();
    act(() => doc.saveConflicted({ version: 2, chart: SEED }));
    expect(doc.getStatus().terminalError).not.toBeNull();

    await advance(5 * 2500);

    expect(mockPollChart).not.toHaveBeenCalled();
  });
});

describe('useChartSync: a response that arrives late', () => {
  it('is dropped when a pointer drag began meanwhile, and fetched again once it is over', async () => {
    const theirs = retitle(SEED, 'b', 'Theirs');
    const slow = pendingPoll();
    const { doc, isDragInFlightRef, receiveRemote } = setup();
    await advance(2500);

    isDragInFlightRef.current = true;
    await slow.resolve({ version: 4, chartData: theirs });
    expect(receiveRemote).not.toHaveBeenCalled();
    expect(doc.getStatus().serverVersion).toBe(3);

    // The drag ends; the next check asks from the same version and gets the chart again.
    isDragInFlightRef.current = false;
    mockPollChart.mockResolvedValueOnce({ version: 4, chartData: theirs });
    await advance(2500);
    expect(mockPollChart).toHaveBeenLastCalledWith('tok', 3);
    expect(doc.getStatus().serverVersion).toBe(4);
    expect(titleOf(doc.getCommitted(), 'b')).toBe('Theirs');
  });

  it('leaves a save that started meanwhile to the document, which ignores landings during a save', async () => {
    const theirs = retitle(SEED, 'b', 'Theirs');
    const slow = pendingPoll();
    const { doc } = setup();
    await advance(2500);

    act(() => doc.edit((chart) => retitle(chart, 'a', 'Mine')));
    const save = doc.takeSave();
    expect(save?.baseVersion).toBe(3);
    await slow.resolve({ version: 4, chartData: theirs });

    // Not merged: the save's own answer brings the newer chart.
    expect(doc.getStatus().serverVersion).toBe(3);
    expect(titleOf(doc.getCommitted(), 'b')).toBe('B');
  });
});

describe('useChartSync: failures', () => {
  it('logs a failed check, waits 30 s, then carries on at the usual pace', async () => {
    mockPollChart.mockRejectedValueOnce(new ChartApiError('Failed to poll chart', 503));
    setup();

    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('503');

    await advance(29_999);
    expect(mockPollChart).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockPollChart).toHaveBeenCalledTimes(2);

    await advance(2500);
    expect(mockPollChart).toHaveBeenCalledTimes(3);
  });

  it('survives a network failure with no status', async () => {
    mockPollChart.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    setup();

    await advance(2500 + 30_000);
    expect(mockPollChart).toHaveBeenCalledTimes(2);
  });

  describe('a chart the merge cannot use', () => {
    /** A document with a local edit, so a landing needs a real merge rather than adopting the server's chart. */
    function setupWithLocalEdit() {
      const rendered = setup();
      act(() => rendered.doc.edit((chart) => retitle(chart, 'a', 'A private title')));
      return rendered;
    }

    it('is reported with versions only, and the document keeps what the user typed', async () => {
      mockPollChart.mockResolvedValue({ version: 5, chartData: chartWithRepeatedSectionId() });
      const { doc } = setupWithLocalEdit();
      const typed = doc.getCommitted();

      await advance(2500);

      expect(mockReportError).toHaveBeenCalledTimes(1);
      const report = mockReportError.mock.calls[0][0];
      expect(report).toMatchObject({
        error_name: 'ChartMergeFailed',
        chart_id: 'chart-1',
        request_metadata: { baseVersion: 3, serverVersion: 5 },
      });
      expect(JSON.stringify(report)).not.toContain('A private title');
      expect(doc.getCommitted()).toBe(typed);
      expect(doc.getStatus().serverVersion).toBe(3);
    });

    it('waits 30 s, keeps polling, and reports the same server version only once', async () => {
      mockPollChart.mockResolvedValue({ version: 5, chartData: chartWithRepeatedSectionId() });
      setupWithLocalEdit();

      await advance(2500);
      await advance(29_999);
      expect(mockPollChart).toHaveBeenCalledTimes(1);
      await advance(1);
      expect(mockPollChart).toHaveBeenCalledTimes(2);
      expect(mockReportError).toHaveBeenCalledTimes(1);

      // A different server version is a new failure.
      mockPollChart.mockResolvedValue({ version: 6, chartData: chartWithRepeatedSectionId() });
      await advance(30_000);
      expect(mockPollChart).toHaveBeenCalledTimes(3);
      expect(mockReportError).toHaveBeenCalledTimes(2);
    });

    it('does not stop the loop: a good chart lands on a later check', async () => {
      const good = retitle(SEED, 'b', 'Theirs');
      mockPollChart
        .mockResolvedValueOnce({ version: 5, chartData: chartWithRepeatedSectionId() })
        .mockResolvedValueOnce({ version: 6, chartData: good });
      const { doc } = setupWithLocalEdit();

      await advance(2500 + 30_000);

      expect(doc.getStatus().serverVersion).toBe(6);
      expect(titleOf(doc.getCommitted(), 'b')).toBe('Theirs');
      expect(titleOf(doc.getCommitted(), 'a')).toBe('A private title');
    });
  });
});
