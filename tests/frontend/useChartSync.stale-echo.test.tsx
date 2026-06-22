// useChartSync — stale-echo regression tests (PR #34 round-7, issue 80).
//
// The bug, as measured live (see the timeline in useChartSync.ts):
// the edit-mode sync poll GETs the chart, the user edits WHILE the
// response is in flight, and the response — a snapshot read before the
// edit — lands afterwards and `setData`s the old state over the new.
// Visible as: slider value correct while dragging, brief revert to the
// previous value after release, settling to the correct value a few
// seconds later when the next poll echoes the save back.
//
// These tests re-enact that ordering deterministically against the real
// hook with a controllable ChartService mock and fake timers:
//
//   1. dead-epoch response (the measured repro: effect re-ran while the
//      GET was in flight; pendingChanges already cleared by save #2) —
//      guard (A)
//   2. same-epoch response landing after a local edit but before React
//      re-runs the effect (pendingChanges still set) — guard (B)
//   3. own-echo snapshot equal to local state is not re-applied —
//      guard (C)
//   4. legit cross-tab remote changes still apply when local is idle
//      (the guards must not break the feature the poll exists for)
//
// The fixtures vary `curvature` AND `textSize` so the assertion covers
// the sibling Format-menu settings too: the stomp is field-agnostic
// (one `setData(result.chartData)` for the whole chart), so one guard
// covers curvature, textSize, fontFamily, and the paddings alike.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
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

// ---------------------------------------------------------------------------
// Fixtures: three chart snapshots. curvature AND textSize differ so a
// revert of either field is caught (sibling coverage).
// ---------------------------------------------------------------------------

const chart = (curvature: number, textSize: number): ToCData => ({
  title: 'Chart',
  curvature,
  textSize,
  sections: [{ title: 'A', columns: [{ nodes: [] }] }],
});

const BASE = chart(0.5, 1.0); // initial server state
const V1 = chart(0.8, 1.2); // user's first edit
const V2 = chart(0.2, 0.8); // user's second edit (the one that must survive)

interface Deferred {
  resolve: (data: ToCData) => void;
  reject: (err: unknown) => void;
}

let deferreds: Deferred[];

const getChartResponse = (chartData: ToCData) => ({
  chartData,
  chartId: 'c1',
  canEdit: true,
  isOwner: false,
});

// Let the `await ChartService.getChartByEditToken(...)` continuation
// (guards + JSON compare + onRemoteData) run to completion.
const flushMicrotasks = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function setup(initialData: ToCData | null = null) {
  const isDragInFlightRef: MutableRefObject<boolean> = { current: false };
  const pendingChangesRef: MutableRefObject<ToCData | null> = { current: null };
  const dataRef: MutableRefObject<ToCData | null> = { current: initialData };
  // Mirrors App: applying a remote snapshot updates local state.
  const onRemoteData = vi.fn((d: ToCData) => {
    dataRef.current = d;
  });

  const { rerender, unmount } = renderHook(
    ({ isSaving }: { isSaving: boolean }) =>
      useChartSync({
        editToken: 'tok',
        authTokenReady: true,
        isSaving,
        isDragInFlightRef,
        pendingChangesRef,
        dataRef,
        onRemoteData,
      }),
    { initialProps: { isSaving: false } },
  );

  // Mirrors App's handleDataChange essentials: local state and the
  // pending-save marker update synchronously; `isSaving` flips via
  // React state (a rerender here).
  const localEdit = (next: ToCData) => {
    dataRef.current = next;
    pendingChangesRef.current = next;
    rerender({ isSaving: true });
  };

  // Mirrors the save-success .then(): pending cleared, isSaving off.
  const saveCompletes = () => {
    pendingChangesRef.current = null;
    rerender({ isSaving: false });
  };

  return { onRemoteData, dataRef, pendingChangesRef, localEdit, saveCompletes, rerender, unmount };
}

const appliedCurvatures = (fn: ReturnType<typeof vi.fn>) =>
  fn.mock.calls.map((c) => (c[0] as ToCData).curvature);

beforeEach(() => {
  vi.useFakeTimers();
  deferreds = [];
  mockGetChart.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        deferreds.push({
          resolve: (data: ToCData) => resolve(getChartResponse(data)),
          reject,
        });
      }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useChartSync stale-echo guards (issue 80)', () => {
  it('drops a dead-epoch response that lands after newer local edits (measured repro)', async () => {
    const { onRemoteData, dataRef, localEdit, saveCompletes } = setup();

    // Epoch 1: initial sync at +1s returns the base chart — applies.
    vi.advanceTimersByTime(1000);
    expect(mockGetChart).toHaveBeenCalledTimes(1);
    deferreds[0].resolve(BASE);
    await flushMicrotasks();
    expect(appliedCurvatures(onRemoteData)).toEqual([0.5]);

    // User drags the curvature slider to 0.8; debounced save runs.
    localEdit(V1);
    saveCompletes();

    // Epoch 3 (post-save): its 1s initial-sync timer issues a GET.
    vi.advanceTimersByTime(1000);
    expect(mockGetChart).toHaveBeenCalledTimes(2);

    // User drags again to 0.2 WHILE that GET is in flight (tears the
    // epoch down), and the second save completes (pending cleared) —
    // the exact measured interleaving from the live repro.
    localEdit(V2);
    saveCompletes();

    // The in-flight GET now resolves with the STALE snapshot (server
    // state as of save #1). Pre-fix this called setData(V1): the
    // visible revert 0.2 -> 0.8 (and textSize 0.8 -> 1.2).
    deferreds[1].resolve(V1);
    await flushMicrotasks();

    expect(appliedCurvatures(onRemoteData)).toEqual([0.5]); // no revert
    expect(dataRef.current?.curvature).toBe(0.2);
    expect(dataRef.current?.textSize).toBe(0.8); // sibling field intact

    // Settle path: the live epoch's 1s timer fetches the fresh state.
    // Server now matches local (own echo) — bookkept, not re-applied.
    vi.advanceTimersByTime(1000);
    expect(mockGetChart).toHaveBeenCalledTimes(3);
    deferreds[2].resolve(chart(0.2, 0.8));
    await flushMicrotasks();

    expect(appliedCurvatures(onRemoteData)).toEqual([0.5]);
    expect(dataRef.current?.curvature).toBe(0.2);
  });

  it('drops a same-epoch response that lands after a local edit but before the effect re-runs', async () => {
    const { onRemoteData, dataRef, pendingChangesRef } = setup(BASE);

    // A periodic GET goes out while idle.
    vi.advanceTimersByTime(1000);
    expect(mockGetChart).toHaveBeenCalledTimes(1);

    // The user edits while it is in flight. React has NOT yet processed
    // the isSaving flip (passive effects run post-paint), so the epoch
    // is still live — only the synchronous pending marker protects us.
    dataRef.current = V1;
    pendingChangesRef.current = V1;

    deferreds[0].resolve(BASE); // stale: read before the edit
    await flushMicrotasks();

    expect(onRemoteData).not.toHaveBeenCalled();
    expect(dataRef.current?.curvature).toBe(0.8);
  });

  it('does not re-apply an own-echo snapshot equal to current local state', async () => {
    const { onRemoteData } = setup(BASE);

    vi.advanceTimersByTime(1000);
    deferreds[0].resolve(chart(0.5, 1.0)); // deep-equal copy of local
    await flushMicrotasks();

    // Identity churn through setData would re-trigger the ToC
    // initialData effect (height recalcs, settings re-sync) for no
    // visible change.
    expect(onRemoteData).not.toHaveBeenCalled();
  });

  it('still applies remote (cross-tab) changes when local state is idle', async () => {
    const { onRemoteData, dataRef } = setup(BASE);

    // First poll: another tab changed the chart. No local pending
    // edits, live epoch -> must apply (the poll's reason to exist).
    vi.advanceTimersByTime(1000);
    deferreds[0].resolve(V1);
    await flushMicrotasks();
    expect(appliedCurvatures(onRemoteData)).toEqual([0.8]);
    expect(dataRef.current).toEqual(V1);

    // Next interval tick: a further remote change also applies.
    vi.advanceTimersByTime(10000);
    expect(mockGetChart).toHaveBeenCalledTimes(2);
    deferreds[1].resolve(V2);
    await flushMicrotasks();
    expect(appliedCurvatures(onRemoteData)).toEqual([0.8, 0.2]);
  });
});
