// Tests for maybePostReconcile cadence/debounce + transport selection.
//
// The CostTracker exposes a `maybePostReconcile(force?, useBeacon?)` method
// that drives client-side /api/reconcile-cost POSTs:
//   - Periodic mode (force=false): debounced by $0.01 / 5s thresholds.
//   - Forced + useBeacon (abort, visibilitychange='hidden', unload): tries
//     navigator.sendBeacon first, falls back to fetch when it returns false.
//
// We swap globalThis.fetch / globalThis.navigator with vitest fakes so the
// dispatch decisions can be observed without a real network or DOM.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CostTracker } from '../../src/services/chatCostTracker';

const MODEL = 'claude-opus-4-7';

// Reconcile thresholds (kept in sync with chatCostTracker.ts).
// Used by the "5s interval refires" test below.
const RECONCILE_INTERVAL_MS = 5_000;

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface BeaconCall {
  url: string;
  body: BodyInit | null;
}

function setupFakes(opts: { fetchOk?: boolean; beaconQueued?: boolean; hasBeacon?: boolean }): {
  fetchCalls: FetchCall[];
  beaconCalls: BeaconCall[];
  restore: () => void;
} {
  const fetchCalls: FetchCall[] = [];
  const beaconCalls: BeaconCall[] = [];
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator as Navigator | undefined;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: typeof input === 'string' ? input : ((input as Request).url ?? String(input)),
      init,
    });
    return new Response('', { status: opts.fetchOk === false ? 500 : 200 });
  }) as typeof fetch;

  // navigator may be absent in workerd. Define a fresh object on globalThis.
  const beacon =
    opts.hasBeacon === false
      ? undefined
      : vi.fn((url: string, body?: BodyInit | null) => {
          beaconCalls.push({ url, body: body ?? null });
          return opts.beaconQueued !== false;
        });

  Object.defineProperty(globalThis, 'navigator', {
    value: beacon ? { sendBeacon: beacon } : {},
    writable: true,
    configurable: true,
  });

  return {
    fetchCalls,
    beaconCalls,
    restore: () => {
      globalThis.fetch = originalFetch;
      if (originalNavigator === undefined) {
        // Remove the property we added.
        try {
          // @ts-expect-error best-effort cleanup
          delete globalThis.navigator;
        } catch {
          /* ignore */
        }
      } else {
        Object.defineProperty(globalThis, 'navigator', {
          value: originalNavigator,
          writable: true,
          configurable: true,
        });
      }
    },
  };
}

describe('CostTracker.maybePostReconcile — periodic / debounced mode', () => {
  let fakes: ReturnType<typeof setupFakes>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
    fakes = setupFakes({});
  });

  afterEach(() => {
    fakes.restore();
    vi.useRealTimers();
  });

  it('does NOT fetch on tiny cost increase under the $0.01 / 5s thresholds', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: null,
    });

    tracker.recordOutputChars(40); // $0.000250 — well below $0.01.
    expect(fakes.fetchCalls.length).toBe(0);
  });

  it('DOES fetch once when crossing the $0.01 threshold', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: null,
    });

    // 4000 chars / 4 = 1000 output tokens * $25/MTok = 25_000 µUSD = $0.025 > $0.01.
    tracker.recordOutputChars(4000);
    expect(fakes.fetchCalls.length).toBe(1);
    expect(fakes.fetchCalls[0].url).toBe('/api/reconcile-cost');
    const body = JSON.parse((fakes.fetchCalls[0].init?.body as string) ?? '{}');
    expect(body.logging_message_id).toBe('msg-A');
    expect(BigInt(body.cost_micro_usd)).toBe(25_000n);
  });

  it('does NOT double-fire within the same threshold/interval window', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: null,
    });

    tracker.recordOutputChars(4000); // crosses $0.01 → fetch #1.
    expect(fakes.fetchCalls.length).toBe(1);

    // A tiny follow-up bump (sub-threshold) should not refire while clock is paused.
    tracker.recordOutputChars(40); // +$0.00025.
    expect(fakes.fetchCalls.length).toBe(1);
  });

  it('refires when the 5s interval elapses even with sub-threshold drift', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: null,
    });

    tracker.recordOutputChars(4000); // fetch #1.
    expect(fakes.fetchCalls.length).toBe(1);

    // Sub-threshold bump — but advance the wall clock past 5s.
    vi.advanceTimersByTime(RECONCILE_INTERVAL_MS + 1);
    tracker.recordOutputChars(40);
    expect(fakes.fetchCalls.length).toBe(2);
  });

  it('refires when another $0.01 threshold is crossed within the 5s window', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: null,
    });

    tracker.recordOutputChars(4000); // fetch #1 ($0.025).
    expect(fakes.fetchCalls.length).toBe(1);

    // Another sizeable bump — total $0.025 + $0.025 = $0.05, delta vs last posted = $0.025 ≥ $0.01.
    tracker.recordOutputChars(4000);
    expect(fakes.fetchCalls.length).toBe(2);
  });

  it('does not POST when loggingMessageId is missing', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: undefined,
      authToken: null,
    });

    tracker.recordOutputChars(4000);
    expect(fakes.fetchCalls.length).toBe(0);
  });

  it('does not POST when cost is zero (no data to reconcile)', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: null,
    });

    tracker.maybePostReconcile(true, false);
    expect(fakes.fetchCalls.length).toBe(0);
  });

  it('sends Authorization header when authToken is set', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: 'token-abc',
    });

    tracker.recordOutputChars(4000);
    expect(fakes.fetchCalls.length).toBe(1);
    const headers = (fakes.fetchCalls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer token-abc');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('CostTracker.maybePostReconcile — forced + sendBeacon transport', () => {
  let fakes: ReturnType<typeof setupFakes>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
  });

  afterEach(() => {
    fakes?.restore();
    vi.useRealTimers();
  });

  it('uses navigator.sendBeacon when force=true && useBeacon=true && beacon is queued', () => {
    fakes = setupFakes({ beaconQueued: true });

    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: null,
    });

    tracker.recordServerCostMicroUsd(1_000_000n);
    // Periodic write fired one fetch ($0.01 threshold).
    expect(fakes.fetchCalls.length).toBe(1);

    // Force + beacon (abort/unload path).
    tracker.maybePostReconcile(true, true);

    expect(fakes.beaconCalls.length).toBe(1);
    expect(fakes.beaconCalls[0].url).toBe('/api/reconcile-cost');
    // No additional fetch — beacon succeeded.
    expect(fakes.fetchCalls.length).toBe(1);
  });

  it('falls back to fetch when sendBeacon returns false (refused/quota)', () => {
    fakes = setupFakes({ beaconQueued: false });

    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: null,
    });

    tracker.recordServerCostMicroUsd(1_000_000n); // one periodic fetch
    expect(fakes.fetchCalls.length).toBe(1);

    tracker.maybePostReconcile(true, true);
    expect(fakes.beaconCalls.length).toBe(1);
    // Beacon refused — must fall through to fetch.
    expect(fakes.fetchCalls.length).toBe(2);
  });

  it('falls back to fetch when navigator.sendBeacon is missing', () => {
    fakes = setupFakes({ hasBeacon: false });

    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: null,
    });

    tracker.recordServerCostMicroUsd(1_000_000n); // one periodic fetch
    expect(fakes.fetchCalls.length).toBe(1);

    tracker.maybePostReconcile(true, true);
    expect(fakes.beaconCalls.length).toBe(0);
    expect(fakes.fetchCalls.length).toBe(2);
  });

  it('force=true bypasses the $0.01 / 5s debounce', () => {
    fakes = setupFakes({ beaconQueued: true });

    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: null,
    });

    // A tiny cost — sub-threshold.
    tracker.recordServerCostMicroUsd(50n);
    expect(fakes.fetchCalls.length).toBe(0); // would be 0 by debounce.

    // Force + beacon still fires.
    tracker.maybePostReconcile(true, true);
    expect(fakes.beaconCalls.length).toBe(1);
    const beaconBody = fakes.beaconCalls[0].body;
    // sendBeacon receives a Blob — read its text.
    expect(beaconBody).toBeInstanceOf(Blob);
  });

  it('beacon body is JSON with logging_message_id + cost_micro_usd as string', async () => {
    fakes = setupFakes({ beaconQueued: true });

    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-X',
      authToken: null,
    });

    tracker.recordServerCostMicroUsd(987_654n);
    tracker.maybePostReconcile(true, true);

    expect(fakes.beaconCalls.length).toBe(1);
    const blob = fakes.beaconCalls[0].body as Blob;
    const text = await blob.text();
    const parsed = JSON.parse(text);
    expect(parsed.logging_message_id).toBe('msg-X');
    expect(parsed.cost_micro_usd).toBe('987654');
  });
});

describe('CostTracker.maybePostReconcile — failure / retry queue contract', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes onFetchFailure callback with logging_message_id + cost_micro_usd on network error', async () => {
    // Make fetch throw (network error).
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('network'))) as typeof fetch;

    const onFetchFailure = vi.fn();
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-A',
      authToken: null,
      onFetchFailure,
    });

    tracker.recordServerCostMicroUsd(50_000n);
    // The fetch error is awaited inside maybePostReconcile's catch.
    await vi.runAllTimersAsync();

    expect(onFetchFailure).toHaveBeenCalledTimes(1);
    const args = onFetchFailure.mock.calls[0][0];
    expect(args.logging_message_id).toBe('msg-A');
    expect(args.cost_micro_usd).toBe('50000');

    globalThis.fetch = originalFetch;
  });
});
