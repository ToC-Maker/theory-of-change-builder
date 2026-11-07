// The poll stays off a drag: the real canvas reports the gesture through
// `onDragActiveChange`, App keeps the flag in `isDragInFlightRef`, and the real
// `useChartSync` skips its version check while the flag is set.
//
//   node drag (usePointerDrag)
//     → ToC notifies through `onDragActiveChange`
//     → the ref App owns is set
//     → `useChartSync` makes no `pollChart` request until it clears
//
// `TheoryOfChangeGraph.dragActive.test.tsx` pins every gesture's own link to the
// callback; this test stitches the callback to the poll hook. A consumer must
//   (a) make no pollChart request while the flag is set,
//   (b) poll again once the drag ends, is cancelled or the canvas unmounts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, fireEvent } from '@testing-library/react';
import { POLL_MS, useChartSync } from '../../src/hooks/useChartSync';
import { ChartService } from '../../src/services/chartService';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import type { ChartInput } from '../../src/types';
import { renderToC } from './helpers/renderToC';

vi.mock('../../src/services/loggingService', () => ({
  loggingService: { reportError: vi.fn() },
}));

vi.mock('../../src/services/chartService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/chartService')>();
  return { ...actual, ChartService: { pollChart: vi.fn() } };
});

const mockPollChart = vi.mocked(ChartService.pollChart);

beforeEach(() => {
  vi.useFakeTimers();
  mockPollChart.mockImplementation(async (_token, knownVersion) => ({ version: knownVersion }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  _resetCanvasGestureStateForTest();
  vi.clearAllMocks();
});

const chart = (): ChartInput => ({
  title: 'Test',
  sections: [
    {
      title: 'A',
      columns: [
        {
          nodes: [
            {
              id: 'n-1',
              title: 'Node',
              text: '',
              connectionIds: [],
              connections: [],
              yPosition: 0,
            },
          ],
        },
        { nodes: [] },
      ],
    },
  ],
});

/**
 * The canvas and the poll hook on one document, wired the way App wires them.
 * `trySync` waits one poll interval and says whether the poll hook asked the
 * server about the version meanwhile.
 */
function setupChain() {
  const isDragInFlightRef = { current: false };
  const rendered = renderToC(chart(), {
    onDragActiveChange: (isActive) => {
      isDragInFlightRef.current = isActive;
    },
  });
  renderHook(() => useChartSync({ doc: rendered.doc, authTokenReady: true, isDragInFlightRef }));

  const trySync = async (): Promise<'ran' | 'skipped'> => {
    const before = mockPollChart.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    return mockPollChart.mock.calls.length > before ? 'ran' : 'skipped';
  };

  const startDrag = () =>
    fireEvent.pointerDown(document.getElementById('node-n-1')!, {
      clientX: 100,
      clientY: 200,
      button: 0,
      pointerId: 1,
    });

  return {
    unmountCanvas: rendered.unmount,
    isDragInFlight: () => isDragInFlightRef.current,
    startDrag,
    trySync,
  };
}

describe('the poll stays off a drag (App ↔ ToC ↔ useChartSync)', () => {
  it('the version check runs when no drag is active', async () => {
    const { trySync, isDragInFlight } = setupChain();
    expect(isDragInFlight()).toBe(false);
    expect(await trySync()).toBe('ran');
  });

  it('the version check is skipped while a pointer-drag is in flight', async () => {
    const { startDrag, isDragInFlight, trySync } = setupChain();

    startDrag();

    expect(isDragInFlight()).toBe(true);
    expect(await trySync()).toBe('skipped');
  });

  it('the version check resumes after pointerup (drag completes)', async () => {
    const { startDrag, isDragInFlight, trySync } = setupChain();

    startDrag();
    expect(await trySync()).toBe('skipped');

    fireEvent.pointerUp(document, { clientX: 350, clientY: 400, pointerId: 1 });

    expect(isDragInFlight()).toBe(false);
    expect(await trySync()).toBe('ran');
  });

  it('the version check resumes after Escape cancel', async () => {
    const { startDrag, trySync } = setupChain();

    startDrag();
    expect(await trySync()).toBe('skipped');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(await trySync()).toBe('ran');
  });

  it('unmount mid-drag clears isDragInFlight (so polling does not stay paused)', async () => {
    // If the canvas unmounts while a drag is in flight (route change, App
    // swap-out), the flag must clear: otherwise it stays set for the rest of
    // App's lifetime and the poll loop silently skips every check.
    const { startDrag, unmountCanvas, isDragInFlight, trySync } = setupChain();

    startDrag();
    expect(isDragInFlight()).toBe(true);

    unmountCanvas();

    expect(isDragInFlight()).toBe(false);
    expect(await trySync()).toBe('ran');
  });
});
