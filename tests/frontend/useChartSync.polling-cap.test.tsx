// useChartSync — the poll cadence settles at the 60s cap and stays there.
//
// While the chart is unchanged the interval backs off from 10s toward
// 60s. An active user must keep polling at the cap indefinitely so other
// people's edits keep arriving; a hidden tab or a user idle for five
// minutes is skipped without ending the poll.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { MutableRefObject } from 'react';
import { useChartSync } from '../../src/hooks/useChartSync';
import { ChartService } from '../../src/services/chartService';
import type { ToCData } from '../../src/types';

vi.mock('../../src/services/chartService', () => ({
  ChartService: {
    getChartByEditToken: vi.fn(),
  },
}));

const mockGetChart = vi.mocked(ChartService.getChartByEditToken);

const SERVER: ToCData = {
  title: 'Chart',
  curvature: 0.5,
  textSize: 1,
  sections: [{ title: 'A', columns: [{ nodes: [] }] }],
};

const MINUTE = 60_000;

function mountSync() {
  const isDragInFlightRef: MutableRefObject<boolean> = { current: false };
  const pendingChangesRef: MutableRefObject<ToCData | null> = { current: null };
  const dataRef: MutableRefObject<ToCData | null> = { current: SERVER };
  return renderHook(() =>
    useChartSync({
      editToken: 'tok',
      authTokenReady: true,
      isSaving: false,
      isDragInFlightRef,
      pendingChangesRef,
      dataRef,
      onRemoteData: vi.fn(),
    }),
  );
}

/**
 * Advance `ms` of fake time in one-minute steps, with the user moving the
 * mouse at the start of each step (a user who is present, never idle).
 */
async function advanceWhileActive(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += MINUTE) {
    document.dispatchEvent(new Event('mousemove'));
    await vi.advanceTimersByTimeAsync(Math.min(MINUTE, ms - elapsed));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  mockGetChart.mockImplementation(async () => ({
    chartData: structuredClone(SERVER),
    chartId: 'c1',
    canEdit: true,
    isOwner: false,
  }));
});

afterEach(() => {
  // Unmount first: a hook left mounted keeps its document listeners and
  // would answer the next test's visibility events.
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useChartSync poll cadence', () => {
  it('keeps polling every 60s after the backoff reaches its cap', async () => {
    mountSync();

    // Well past the point where ten unchanged polls at 60s have elapsed
    // (about 5.7 minutes after load, once backoff has run its course).
    await advanceWhileActive(8 * MINUTE);
    const callsAtEightMinutes = mockGetChart.mock.calls.length;

    await advanceWhileActive(5 * MINUTE);

    // Five more minutes at a 60s cap is five more polls.
    expect(mockGetChart.mock.calls.length - callsAtEightMinutes).toBeGreaterThanOrEqual(4);
  });

  it('still skips polling for a user idle past five minutes', async () => {
    mountSync();
    await advanceWhileActive(MINUTE);
    const callsBeforeIdle = mockGetChart.mock.calls.length;

    // No input events for 6 minutes: polls past the 5-minute mark are skipped.
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    const callsWhileIdle = mockGetChart.mock.calls.length - callsBeforeIdle;
    await vi.advanceTimersByTimeAsync(3 * MINUTE);

    expect(mockGetChart.mock.calls.length - callsBeforeIdle).toBe(callsWhileIdle);
  });

  it('skips polls while the tab is hidden and syncs at once when it returns', async () => {
    mountSync();
    await advanceWhileActive(MINUTE);

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    const callsWhenHidden = mockGetChart.mock.calls.length;
    await advanceWhileActive(4 * MINUTE);
    expect(mockGetChart.mock.calls.length).toBe(callsWhenHidden);

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(mockGetChart.mock.calls.length).toBe(callsWhenHidden + 1);

    // And the poll carries on afterwards.
    await advanceWhileActive(2 * MINUTE);
    expect(mockGetChart.mock.calls.length).toBeGreaterThan(callsWhenHidden + 1);
  });
});
