// Tests for the post-stream reconcile-polling machinery.
//
// The streaming worker writes `cost_settled_micro_usd` in a `ctx.waitUntil`
// IIFE that runs AFTER the SSE response closes. The BYOK pill — driven by
// the client's running tracker — therefore lags ~1-2s behind the final
// server figure on every stream. Empirical case before this fix: pill
// $0.49 vs server $0.75 across a 7-stream test session, because the
// client posted /api/reconcile-cost once at stream end and never re-checked.
//
// Three knobs land in `reconcilePolling.ts`:
//
//  1. `postReconcileOnce` — single fire-and-await POST to /api/reconcile-cost.
//     Returns `{ok, status, body}` so callers can branch on the response.
//     Bumps the per-entry queue baseline if `cost_settled > entry.cost_micro_usd`,
//     credits the BYOK pill delta if chartId+keyLast4 are present.
//
//  2. `pollUntilReconciled` — 30s budget, 1s cadence, single just-ended
//     stream. Stops on `reconciled:true` OR 30s wall clock OR 4xx
//     (definitive reject). Each tick re-POSTs the latest queued figure.
//
//  3. `drainPendingReconciles` — one POST per queued entry. Drops on
//     `reconciled:true` or 4xx. Keeps on `reconciled:false` (next page
//     load tries again) or network/5xx. NOT a polling loop — one shot.
//
// All three exercise the same response shape:
//   { applied: bool, delta: string, new_settled: string,
//     cost_settled_micro_usd: string, reconciled: bool }
//
// `cost_settled_micro_usd` is the authoritative server value; `reconciled`
// flips true only after the post-stream IIFE has stamped `reconciled_at`.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  enqueuePendingReconcile,
  drainPendingReconciles,
  postReconcileOnce,
  pollUntilReconciled,
  getActivePollIds,
  __test_clearQueue,
  __test_readQueue,
  PENDING_RECONCILE_KEY,
} from '../../src/services/reconcilePolling';

const MSG_ID_A = '11111111-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const MSG_ID_B = '22222222-bbbb-4bbb-bbbb-bbbbbbbbbbbb';

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

interface ReconcileResponseShape {
  applied: boolean;
  delta: string;
  new_settled: string;
  cost_settled_micro_usd: string;
  reconciled: boolean;
}

function fakeReconcileResponse(overrides: Partial<ReconcileResponseShape> = {}): Response {
  const body: ReconcileResponseShape = {
    applied: true,
    delta: '0',
    new_settled: '0',
    cost_settled_micro_usd: '0',
    reconciled: false,
    ...overrides,
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function setupFakeFetch(responder: (call: FetchCall) => Response | Promise<Response>): {
  fetchCalls: FetchCall[];
  restore: () => void;
} {
  const fetchCalls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: typeof input === 'string' ? input : ((input as Request).url ?? String(input)),
      init,
    };
    fetchCalls.push(call);
    return responder(call);
  }) as typeof fetch;

  return {
    fetchCalls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

// In-memory localStorage shim. workerd doesn't ship one; tests need a
// hermetic store that doesn't leak across describe blocks.
function installLocalStorageFake(): { restore: () => void } {
  const store: Record<string, string> = {};
  const fake: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    value: fake,
    writable: true,
    configurable: true,
  });
  return {
    restore: () => {
      if (desc) {
        Object.defineProperty(globalThis, 'localStorage', desc);
      } else {
        try {
          // @ts-expect-error best-effort cleanup
          delete globalThis.localStorage;
        } catch {
          /* ignore */
        }
      }
    },
  };
}

describe('postReconcileOnce — response parsing + pill bump + queue update', () => {
  let fakes: ReturnType<typeof setupFakeFetch>;
  let lsFake: ReturnType<typeof installLocalStorageFake>;

  beforeEach(() => {
    lsFake = installLocalStorageFake();
    __test_clearQueue();
  });

  afterEach(() => {
    fakes?.restore();
    lsFake.restore();
  });

  it('returns reconciled=true when server reports reconciled', async () => {
    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({
        cost_settled_micro_usd: '750000',
        reconciled: true,
      }),
    );

    const result = await postReconcileOnce({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reconciled).toBe(true);
      expect(result.cost_settled_micro_usd).toBe(750_000n);
    }
    expect(fakes.fetchCalls.length).toBe(1);
    expect(fakes.fetchCalls[0].url).toBe('/api/reconcile-cost');
  });

  it('fires onCostBump when cost_settled > previously-credited baseline', async () => {
    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({
        cost_settled_micro_usd: '750000',
        reconciled: true,
      }),
    );

    const onCostBump = vi.fn();
    await postReconcileOnce({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
      chartId: 'chart-1',
      keyLast4: 'ab12',
      onCostBump,
    });

    expect(onCostBump).toHaveBeenCalledTimes(1);
    expect(onCostBump).toHaveBeenCalledWith({
      chartId: 'chart-1',
      keyLast4: 'ab12',
      deltaMicroUsd: 260_000n, // 750_000 - 490_000
      newSettledMicroUsd: 750_000n,
    });
  });

  it('does NOT fire onCostBump when cost_settled <= previously-credited baseline', async () => {
    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({
        cost_settled_micro_usd: '490000',
        reconciled: false,
      }),
    );

    const onCostBump = vi.fn();
    await postReconcileOnce({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
      chartId: 'chart-1',
      keyLast4: 'ab12',
      onCostBump,
    });

    expect(onCostBump).not.toHaveBeenCalled();
  });

  it('does NOT fire onCostBump when chartId or keyLast4 missing (non-BYOK)', async () => {
    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({
        cost_settled_micro_usd: '750000',
        reconciled: true,
      }),
    );

    const onCostBump = vi.fn();
    await postReconcileOnce({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
      // no chartId, no keyLast4 → free-tier stream, pill doesn't apply
      onCostBump,
    });

    expect(onCostBump).not.toHaveBeenCalled();
  });

  it('returns ok=false with status when server returns 5xx', async () => {
    fakes = setupFakeFetch(() => new Response('boom', { status: 500 }));

    const result = await postReconcileOnce({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '50000',
      authToken: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
    }
  });

  it('returns ok=false with status when server returns 4xx', async () => {
    fakes = setupFakeFetch(() => new Response('nope', { status: 404 }));

    const result = await postReconcileOnce({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '50000',
      authToken: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
    }
  });

  it('returns ok=false on network error', async () => {
    fakes = setupFakeFetch(() => Promise.reject(new Error('NetworkError')));

    const result = await postReconcileOnce({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '50000',
      authToken: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(0); // 0 = network/fetch threw
    }
  });

  it('sends Authorization header when authToken is set', async () => {
    fakes = setupFakeFetch(() => fakeReconcileResponse({ reconciled: true }));

    await postReconcileOnce({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '50000',
      authToken: 'jwt-xyz',
    });

    const headers = (fakes.fetchCalls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer jwt-xyz');
  });
});

describe('pollUntilReconciled — 30s × 1s cadence with timeout safety bound', () => {
  let fakes: ReturnType<typeof setupFakeFetch>;
  let lsFake: ReturnType<typeof installLocalStorageFake>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T12:00:00.000Z'));
    lsFake = installLocalStorageFake();
    __test_clearQueue();
  });

  afterEach(() => {
    fakes?.restore();
    lsFake.restore();
    vi.useRealTimers();
  });

  it('stops polling immediately when first response says reconciled=true', async () => {
    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({ cost_settled_micro_usd: '750000', reconciled: true }),
    );

    const promise = pollUntilReconciled({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
    });

    // Don't even advance the clock — the first POST gets reconciled=true.
    await vi.runAllTimersAsync();
    await promise;

    expect(fakes.fetchCalls.length).toBe(1);
  });

  it('keeps polling at 1s cadence while reconciled=false, stops when it flips true', async () => {
    let callIdx = 0;
    fakes = setupFakeFetch(() => {
      callIdx += 1;
      // First 2 calls: reconciled=false. Third call: reconciled=true.
      if (callIdx < 3) {
        return fakeReconcileResponse({ cost_settled_micro_usd: '490000', reconciled: false });
      }
      return fakeReconcileResponse({ cost_settled_micro_usd: '750000', reconciled: true });
    });

    const promise = pollUntilReconciled({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
    });

    // Initial POST already happened (call #1, reconciled=false).
    // Each subsequent tick is +1s.
    await vi.advanceTimersByTimeAsync(1_000); // → call #2 (still false)
    await vi.advanceTimersByTimeAsync(1_000); // → call #3 (true, stops)
    await promise;

    expect(fakes.fetchCalls.length).toBe(3);
  });

  it('stops at 30s safety bound even if never reconciled', async () => {
    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({ cost_settled_micro_usd: '500000', reconciled: false }),
    );

    const promise = pollUntilReconciled({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
    });

    // Advance well past 30s.
    await vi.advanceTimersByTimeAsync(35_000);
    await promise;

    // Initial POST + at most 30 follow-ups @ 1s = up to 31 total.
    // Allow some scheduler slop (28-32).
    expect(fakes.fetchCalls.length).toBeGreaterThanOrEqual(28);
    expect(fakes.fetchCalls.length).toBeLessThanOrEqual(32);
  });

  it('drops the entry from the queue when poll completes with reconciled=true', async () => {
    // Pre-populate the queue with the entry (as the stream-end pre-enqueue would).
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
    });
    expect(__test_readQueue().length).toBe(1);

    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({ cost_settled_micro_usd: '750000', reconciled: true }),
    );

    const promise = pollUntilReconciled({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
    });
    await vi.runAllTimersAsync();
    await promise;

    expect(__test_readQueue().length).toBe(0);
  });

  it('leaves the entry in the queue if 30s elapses without reconciled=true', async () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
    });

    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({ cost_settled_micro_usd: '500000', reconciled: false }),
    );

    const promise = pollUntilReconciled({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
    });
    await vi.advanceTimersByTimeAsync(35_000);
    await promise;

    // Entry remains so the next page-load drain attempts another single POST.
    expect(__test_readQueue().length).toBe(1);
    // And its cost_micro_usd was advanced to the server's current figure so
    // the next drain's delta math is correct.
    expect(__test_readQueue()[0].cost_micro_usd).toBe('500000');
  });

  it('credits the BYOK pill bump on each strict-increase response', async () => {
    // Server reports 600k after 1s, 750k after 2s, then reconciled.
    let callIdx = 0;
    fakes = setupFakeFetch(() => {
      callIdx += 1;
      if (callIdx === 1)
        return fakeReconcileResponse({ cost_settled_micro_usd: '600000', reconciled: false });
      if (callIdx === 2)
        return fakeReconcileResponse({ cost_settled_micro_usd: '750000', reconciled: false });
      return fakeReconcileResponse({ cost_settled_micro_usd: '750000', reconciled: true });
    });

    const onCostBump = vi.fn();
    const promise = pollUntilReconciled({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
      chartId: 'chart-1',
      keyLast4: 'ab12',
      onCostBump,
    });

    await vi.advanceTimersByTimeAsync(1_000); // call #2
    await vi.advanceTimersByTimeAsync(1_000); // call #3
    await promise;

    // Two strict-increase frames: 490k→600k (Δ110k) and 600k→750k (Δ150k).
    // Third call (settled stays at 750k) is no bump.
    expect(onCostBump).toHaveBeenCalledTimes(2);
    expect(onCostBump.mock.calls[0][0].deltaMicroUsd).toBe(110_000n);
    expect(onCostBump.mock.calls[1][0].deltaMicroUsd).toBe(150_000n);
  });

  it('stops polling on definitive 4xx response', async () => {
    let callIdx = 0;
    fakes = setupFakeFetch(() => {
      callIdx += 1;
      if (callIdx === 1)
        return fakeReconcileResponse({ cost_settled_micro_usd: '0', reconciled: false });
      return new Response('not found', { status: 404 });
    });

    const promise = pollUntilReconciled({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
    });

    await vi.advanceTimersByTimeAsync(1_000); // call #2 → 404 → stop
    await vi.advanceTimersByTimeAsync(5_000); // should NOT produce more calls
    await promise;

    expect(fakes.fetchCalls.length).toBe(2);
  });

  it('continues polling on transient 5xx (the next tick fires another POST)', async () => {
    let callIdx = 0;
    fakes = setupFakeFetch(() => {
      callIdx += 1;
      if (callIdx === 1) return new Response('boom', { status: 500 });
      return fakeReconcileResponse({ cost_settled_micro_usd: '750000', reconciled: true });
    });

    const promise = pollUntilReconciled({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
    });

    await vi.advanceTimersByTimeAsync(1_000); // tick #2 retries
    await promise;

    expect(fakes.fetchCalls.length).toBe(2);
  });
});

describe('drainPendingReconciles — single POST per stored entry', () => {
  let fakes: ReturnType<typeof setupFakeFetch>;
  let lsFake: ReturnType<typeof installLocalStorageFake>;

  beforeEach(() => {
    lsFake = installLocalStorageFake();
    __test_clearQueue();
  });

  afterEach(() => {
    fakes?.restore();
    lsFake.restore();
  });

  it('drops entries returning reconciled=true', async () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
    });

    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({ cost_settled_micro_usd: '750000', reconciled: true }),
    );

    await drainPendingReconciles(null);

    expect(__test_readQueue().length).toBe(0);
  });

  it('keeps entries returning reconciled=false (for next page load)', async () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
    });

    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({ cost_settled_micro_usd: '600000', reconciled: false }),
    );

    await drainPendingReconciles(null);

    const queue = __test_readQueue();
    expect(queue.length).toBe(1);
    // The queued baseline advances to the latest server figure so the next
    // drain credits incremental, not double-counts.
    expect(queue[0].cost_micro_usd).toBe('600000');
  });

  it('emits ONE POST per stored message_id (no polling loop)', async () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
    });
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_B,
      cost_micro_usd: '120000',
    });

    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({ cost_settled_micro_usd: '600000', reconciled: false }),
    );

    await drainPendingReconciles(null);

    // Exactly 2 fetches: one per entry. No follow-up loop.
    expect(fakes.fetchCalls.length).toBe(2);
  });

  it('drops 4xx responses (definitive reject — row gone or ownership mismatch)', async () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
    });

    fakes = setupFakeFetch(() => new Response('forbidden', { status: 403 }));

    await drainPendingReconciles(null);

    expect(__test_readQueue().length).toBe(0);
  });

  it('keeps entries on 5xx and network errors (retry next time)', async () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
    });
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_B,
      cost_micro_usd: '120000',
    });

    let callIdx = 0;
    fakes = setupFakeFetch(() => {
      callIdx += 1;
      if (callIdx === 1) return new Response('boom', { status: 500 });
      return Promise.reject(new Error('NetworkError'));
    });

    await drainPendingReconciles(null);

    // Both entries still queued.
    expect(__test_readQueue().length).toBe(2);
  });

  it('credits BYOK pill bumps when cost_settled > entry.cost_micro_usd', async () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      chartId: 'chart-1',
      keyLast4: 'ab12',
    });

    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({ cost_settled_micro_usd: '750000', reconciled: true }),
    );

    const onCostBump = vi.fn();
    await drainPendingReconciles(null, onCostBump);

    expect(onCostBump).toHaveBeenCalledTimes(1);
    expect(onCostBump.mock.calls[0][0]).toEqual({
      chartId: 'chart-1',
      keyLast4: 'ab12',
      deltaMicroUsd: 260_000n,
      newSettledMicroUsd: 750_000n,
    });
  });

  it('does NOT credit BYOK pill when cost_settled <= entry.cost_micro_usd (monotone)', async () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      chartId: 'chart-1',
      keyLast4: 'ab12',
    });

    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({ cost_settled_micro_usd: '490000', reconciled: false }),
    );

    const onCostBump = vi.fn();
    await drainPendingReconciles(null, onCostBump);

    expect(onCostBump).not.toHaveBeenCalled();
  });

  it('GCs entries older than 7 days regardless of reconciled state', async () => {
    // Bypass enqueue to plant an old entry directly.
    const ancient = Date.now() - 8 * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      PENDING_RECONCILE_KEY,
      JSON.stringify([
        {
          logging_message_id: MSG_ID_A,
          cost_micro_usd: '490000',
          queued_at: ancient,
          reconciled: false,
        },
      ]),
    );

    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({ cost_settled_micro_usd: '0', reconciled: false }),
    );

    await drainPendingReconciles(null);

    expect(__test_readQueue().length).toBe(0);
    // GC drops *before* fetching — no POST issued for stale entries.
    expect(fakes.fetchCalls.length).toBe(0);
  });
});

describe('drain-vs-poll race — skipMessageIds prevents double-credit', () => {
  let fakes: ReturnType<typeof setupFakeFetch>;
  let lsFake: ReturnType<typeof installLocalStorageFake>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-18T12:00:00.000Z'));
    lsFake = installLocalStorageFake();
    __test_clearQueue();
  });

  afterEach(() => {
    fakes?.restore();
    lsFake.restore();
    vi.useRealTimers();
  });

  it('drain skips entries currently being polled (via getActivePollIds)', async () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      chartId: 'chart-1',
      keyLast4: 'ab12',
    });
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_B,
      cost_micro_usd: '100000',
      chartId: 'chart-2',
      keyLast4: 'ab12',
    });

    // Server always says reconciled=false so the poll keeps looping.
    fakes = setupFakeFetch(() =>
      fakeReconcileResponse({ cost_settled_micro_usd: '600000', reconciled: false }),
    );

    // Start a poll on MSG_ID_A — it adds to activePollIds.
    const onCostBumpPoll = vi.fn();
    const pollPromise = pollUntilReconciled({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      authToken: null,
      chartId: 'chart-1',
      keyLast4: 'ab12',
      onCostBump: onCostBumpPoll,
    });

    // After the very first POST (which fires synchronously inside the
    // poll), MSG_ID_A is in the active set.
    await vi.advanceTimersByTimeAsync(0);
    expect(getActivePollIds().has(MSG_ID_A)).toBe(true);

    // Concurrent drain — should skip MSG_ID_A (covered by the poll) but
    // POST for MSG_ID_B (not in the active set).
    const fetchCountBefore = fakes.fetchCalls.length;
    const onCostBumpDrain = vi.fn();
    await drainPendingReconciles(null, onCostBumpDrain, getActivePollIds());

    // Exactly one new fetch (for MSG_ID_B). MSG_ID_A was skipped.
    expect(fakes.fetchCalls.length).toBe(fetchCountBefore + 1);
    const lastBody = JSON.parse((fakes.fetchCalls.at(-1)?.init?.body as string) ?? '{}');
    expect(lastBody.logging_message_id).toBe(MSG_ID_B);

    // MSG_ID_A entry stays in the queue (poll is still active).
    const q = __test_readQueue();
    expect(q.map((p) => p.logging_message_id).sort()).toEqual([MSG_ID_A, MSG_ID_B].sort());

    // Let the 30s budget run out so the poll exits cleanly.
    await vi.advanceTimersByTimeAsync(35_000);
    await pollPromise;
    expect(getActivePollIds().has(MSG_ID_A)).toBe(false);
  });
});

describe('enqueuePendingReconcile — entry shape', () => {
  let lsFake: ReturnType<typeof installLocalStorageFake>;

  beforeEach(() => {
    lsFake = installLocalStorageFake();
    __test_clearQueue();
  });

  afterEach(() => {
    lsFake.restore();
  });

  it('persists chartId + keyLast4 + reconciled=false initially', () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
      chartId: 'chart-1',
      keyLast4: 'ab12',
    });

    const q = __test_readQueue();
    expect(q.length).toBe(1);
    expect(q[0].chartId).toBe('chart-1');
    expect(q[0].keyLast4).toBe('ab12');
    expect(q[0].reconciled).toBe(false);
  });

  it('dedupes by logging_message_id, latest call wins (cost + chart context)', () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '100000',
      chartId: 'chart-1',
      keyLast4: 'ab12',
    });
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '200000',
      chartId: 'chart-2', // intentionally different (shouldn't happen in practice)
      keyLast4: 'cd34',
    });

    const q = __test_readQueue();
    expect(q.length).toBe(1);
    expect(q[0].cost_micro_usd).toBe('200000');
    expect(q[0].chartId).toBe('chart-2');
    expect(q[0].keyLast4).toBe('cd34');
  });

  it('accepts entries without chartId/keyLast4 (free-tier streams)', () => {
    enqueuePendingReconcile({
      logging_message_id: MSG_ID_A,
      cost_micro_usd: '490000',
    });

    const q = __test_readQueue();
    expect(q.length).toBe(1);
    expect(q[0].chartId ?? null).toBeNull();
    expect(q[0].keyLast4 ?? null).toBeNull();
  });

  it('survives a corrupt localStorage payload (discards rather than throwing)', () => {
    localStorage.setItem(PENDING_RECONCILE_KEY, 'not-valid-json{');
    // Should silently reset to empty, not throw.
    expect(__test_readQueue()).toEqual([]);
  });
});
