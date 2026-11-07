// Integration test for the polling-pause propagation chain.
//
//   usePointerDrag.dragState (null↔non-null)
//     → TheoryOfChangeGraph's useEffect notifies via prop
//     → App's onDragActiveChange handler writes isDragInFlightRef.current
//     → useChartSync's version check is skipped while the ref is set
//
// The unit suite covers each link in isolation. This test stitches the
// chain end-to-end with a small harness so a refactor that breaks the
// callback wiring (renames the prop, drops the effect, forgets the
// useEffect cleanup) shows up here rather than silently re-enabling
// the cross-tab mid-drag delete race.
//
// What we DON'T do: render the full TheoryOfChangeGraph (too much
// scaffolding for a single seam). Instead we model the
// onDragActiveChange contract directly, with the real useChartSync as its
// consumer: the consumer must
//   (a) receive a `true` when drag starts,
//   (b) make no pollChart request while the flag is true,
//   (c) receive a `false` when drag ends (or when ToC unmounts mid-drag),
//   (d) poll again after the flag clears.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useEffect, useRef as useReactRef } from 'react';
import { usePointerDrag } from '../../src/hooks/usePointerDrag';
import { POLL_MS, useChartSync } from '../../src/hooks/useChartSync';
import { ChartService } from '../../src/services/chartService';
import { ChartDocument } from '../../src/sync/ChartDocument';
import { _resetCanvasGestureStateForTest } from '../../src/hooks/_canvasGestureState';
import type { LayoutSnapshot } from '../../src/hooks/useGraphLayout';
import type { ToCData } from '../../src/types';
import { deepFreeze } from './helpers/deepFreeze';

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

// ---------------------------------------------------------------------------
// Fixtures (subset of usePointerDrag.test.ts; intentionally local so a
// fixture refactor there doesn't accidentally redefine this seam)
// ---------------------------------------------------------------------------

const sampleNode = (id: string, yPosition = 0) => ({
  id,
  title: `Node ${id}`,
  text: '',
  connectionIds: [],
  connections: [],
  yPosition,
});

const sampleData = (): ToCData => ({
  sections: [{ title: 'A', columns: [{ nodes: [sampleNode('n-1')] }, { nodes: [] }] }],
});

const makeSnapshot = (): LayoutSnapshot => ({
  sectionPadding: 32,
  columnPadding: 24,
  columnRects: [
    [
      { left: 50, right: 250, top: 100, bottom: 900 },
      { left: 274, right: 474, top: 100, bottom: 900 },
    ],
  ],
  containerWidth: 800,
  containerHeight: 1000,
  nodeRects: { '0-0': [], '0-1': [] },
});

function makeMockElement(): HTMLDivElement {
  const el = document.createElement('div');
  el.setPointerCapture = vi.fn();
  el.releasePointerCapture = vi.fn();
  el.hasPointerCapture = vi.fn().mockReturnValue(true);
  el.getBoundingClientRect = vi.fn().mockReturnValue({
    left: 0,
    right: 200,
    top: 0,
    bottom: 60,
    width: 200,
    height: 60,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  Object.defineProperty(el, 'offsetWidth', { value: 200, configurable: true });
  Object.defineProperty(el, 'offsetHeight', { value: 60, configurable: true });
  return el;
}

function pointerDownEvent(init: {
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  nodeEl: HTMLElement;
}): React.PointerEvent {
  return {
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    pointerId: init.pointerId ?? 1,
    pointerType: 'mouse',
    button: 0,
    target: init.nodeEl,
    currentTarget: init.nodeEl,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.PointerEvent;
}

function pointerEvent(
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number },
): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(event, {
    clientX: { value: init.clientX ?? 0 },
    clientY: { value: init.clientY ?? 0 },
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: 'mouse' },
  });
  return event;
}

// ---------------------------------------------------------------------------
// Harness: model App + ToC end-to-end
// ---------------------------------------------------------------------------

/**
 * `setupChain` returns the same shape that App.tsx + ToC produce:
 *   - `isDragInFlight()`: reads the ref the sync hook reads
 *   - `trySync()`: waits one poll interval and returns 'ran' if the real
 *      `useChartSync` asked the server for the version meanwhile, 'skipped'
 *      if it did not.
 *   - `result`: the renderHook handle for the inner hook(s).
 * The inner hook composes usePointerDrag with the ToC-side useEffect
 * notifier (TheoryOfChangeGraph.tsx:806-816) so the propagation chain
 * is exactly the one production runs through.
 */
function setupChain() {
  const isDragInFlightRef = { current: false };

  const chart = sampleData();
  const doc = new ChartDocument({
    chart,
    editToken: 'tok',
    server: { version: 1, chart },
  });
  renderHook(() => useChartSync({ doc, authTokenReady: true, isDragInFlightRef }));

  const trySync = async (): Promise<'ran' | 'skipped'> => {
    const before = mockPollChart.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    return mockPollChart.mock.calls.length > before ? 'ran' : 'skipped';
  };

  let containerEl: HTMLDivElement;
  const { result, unmount } = renderHook(() => {
    const containerRef = useReactRef<HTMLDivElement>(null);
    if (!containerEl) {
      containerEl = document.createElement('div');
      document.body.appendChild(containerEl);
      containerEl.getBoundingClientRect = vi.fn().mockReturnValue({
        left: 0,
        right: 800,
        top: 0,
        bottom: 1000,
        width: 800,
        height: 1000,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    }
    containerRef.current = containerEl;

    const drag = usePointerDrag({
      data: deepFreeze(sampleData()),
      containerRef,
      getSnapshot: () => makeSnapshot(),
      editMode: true,
      zoomScale: 1,
      nodeHeights: { 'n-1': 60 },
      onDrop: vi.fn(),
    });

    // Mirror TheoryOfChangeGraph.tsx:806-816 verbatim — propagate
    // isDragActive transitions to a callback the App owns.
    useEffect(() => {
      isDragInFlightRef.current = drag.isActive;
      return () => {
        if (drag.isActive) isDragInFlightRef.current = false;
      };
    }, [drag.isActive]);

    return drag;
  });

  return {
    result,
    unmount,
    isDragInFlight: () => isDragInFlightRef.current,
    trySync,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('polling-pause propagation chain (App ↔ ToC ↔ usePointerDrag)', () => {
  it('the version check runs when no drag is active', async () => {
    const { trySync, isDragInFlight } = setupChain();
    expect(isDragInFlight()).toBe(false);
    expect(await trySync()).toBe('ran');
  });

  it('the version check is skipped while a pointer-drag is in flight', async () => {
    const { result, isDragInFlight, trySync } = setupChain();

    const nodeEl = makeMockElement();
    const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
    act(() => {
      result.current.bindNode('n-1').onPointerDown(down);
    });

    expect(isDragInFlight()).toBe(true);
    expect(await trySync()).toBe('skipped');
  });

  it('the version check resumes after pointerup (drag completes)', async () => {
    const { result, isDragInFlight, trySync } = setupChain();

    const nodeEl = makeMockElement();
    const down = pointerDownEvent({ clientX: 100, clientY: 200, nodeEl });
    act(() => {
      result.current.bindNode('n-1').onPointerDown(down);
    });

    expect(await trySync()).toBe('skipped');

    const up = pointerEvent('pointerup', { clientX: 350, clientY: 400 });
    act(() => {
      document.dispatchEvent(up);
    });

    expect(isDragInFlight()).toBe(false);
    expect(await trySync()).toBe('ran');
  });

  it('the version check resumes after Escape cancel', async () => {
    const { result, trySync } = setupChain();

    const nodeEl = makeMockElement();
    act(() => {
      result.current
        .bindNode('n-1')
        .onPointerDown(pointerDownEvent({ clientX: 100, clientY: 200, nodeEl }));
    });
    expect(await trySync()).toBe('skipped');

    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    act(() => {
      document.dispatchEvent(esc);
    });

    expect(await trySync()).toBe('ran');
  });

  it('unmount mid-drag clears isDragInFlight (so polling does not stay paused)', async () => {
    // This is the type-analyzer I2 contract: if the ToC unmounts
    // while a drag is in flight (route change, App swap-out), the
    // onDragActiveChange cleanup must fire `false` — otherwise App's
    // ref stays `true` for the rest of the App's lifetime and the
    // poll loop silently skips every check.
    const { result, unmount, isDragInFlight, trySync } = setupChain();

    const nodeEl = makeMockElement();
    act(() => {
      result.current
        .bindNode('n-1')
        .onPointerDown(pointerDownEvent({ clientX: 100, clientY: 200, nodeEl }));
    });
    expect(isDragInFlight()).toBe(true);

    unmount();

    expect(isDragInFlight()).toBe(false);
    expect(await trySync()).toBe('ran');
  });
});
