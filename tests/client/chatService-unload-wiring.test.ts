// Pinning the chatService listener wiring that drives the unload-safe
// reconcile path. CostTracker's `maybePostReconcile` is already unit-tested
// against its trigger conditions in `chatService-reconcile-cadence.test.ts`,
// but the wiring inside `streamFromApi` (registers an `abort` listener on the
// caller's signal + a `visibilitychange` listener on document, both calling
// `tracker.maybePostReconcile('force-beacon')`; tears both down in the finally
// block) had zero coverage. A refactor that broke registration discipline —
// forgetting to register a listener, listening on the wrong target, or
// skipping the cleanup — would silently reintroduce the exact bug PR #23
// aims to fix.
//
// Test plan (per finding u3-test from PR #23 review):
//   1. Stub global `document` (workerd has no jsdom). Track add/remove pairs.
//   2. Mock `navigator.sendBeacon`. Observe whether the wiring fires it.
//   3. Run an end-to-end `chatService.streamMessage` driven by a fake
//      ReadableStream Response. The SSE stream includes a `message_start`
//      with usage so the tracker accumulates cost > 0 (otherwise
//      `maybePostReconcile` short-circuits on cost===0 and we can't tell
//      register/fire/cleanup apart).
//   4. While the stream is suspended mid-flight (no message_stop yet),
//      assert listener registration shape. Then trigger
//      `document.visibilityState='hidden'` + dispatch handler → sendBeacon
//      fires. Trigger `signal.abort()` → sendBeacon fires again.
//   5. Drive the rest of the stream to message_stop. The `finally` block
//      should call `removeEventListener` symmetrically with the same handler
//      function reference. Post-cleanup, invoking the captured handler is a
//      noop from document's perspective (it's no longer registered) — we
//      assert the recorded register/unregister calls pair up.
//   6. Run a SECOND stream sequentially in the same test process. Assert no
//      handler leakage: cumulative register count == cumulative unregister
//      count after the second stream completes.
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

import { chatService } from '../../src/services/chatService';

const MODEL = 'claude-opus-4-7';
const LOGGING_MSG_ID = 'msg-unload-wiring';

// ---------------------------------------------------------------------------
// Fake DOM globals: `document` with a writable `visibilityState`, listener
// recorders, and a navigator.sendBeacon spy. workerd doesn't have any of
// these by default, so we install them per-test on `globalThis` and tear
// down in afterEach to keep tests hermetic.
// ---------------------------------------------------------------------------
interface BeaconCall {
  url: string;
  body: BodyInit | null;
}

interface ListenerEntry {
  event: string;
  handler: EventListenerOrEventListenerObject;
  options?: AddEventListenerOptions | boolean;
}

interface DomFakes {
  documentListeners: { added: ListenerEntry[]; removed: ListenerEntry[] };
  beaconCalls: BeaconCall[];
  getVisibilityHandlers: () => EventListenerOrEventListenerObject[];
  setVisibilityState: (state: DocumentVisibilityState) => void;
  restore: () => void;
}

function installDomFakes(): DomFakes {
  const documentListeners: { added: ListenerEntry[]; removed: ListenerEntry[] } = {
    added: [],
    removed: [],
  };
  const beaconCalls: BeaconCall[] = [];

  let visibilityState: DocumentVisibilityState = 'visible';

  const fakeDocument = {
    get visibilityState() {
      return visibilityState;
    },
    addEventListener: (
      event: string,
      handler: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ) => {
      documentListeners.added.push({ event, handler, options });
    },
    removeEventListener: (
      event: string,
      handler: EventListenerOrEventListenerObject,
      options?: AddEventListenerOptions | boolean,
    ) => {
      documentListeners.removed.push({ event, handler, options });
    },
  };

  // Tracks original property descriptors so afterEach can restore exactly
  // what was there before (typically `undefined` in workerd, but be defensive
  // — `chatService.ts` is also used from Vite/browser contexts in dev).
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  Object.defineProperty(globalThis, 'document', {
    value: fakeDocument,
    writable: true,
    configurable: true,
  });

  const sendBeacon = vi.fn((url: string, body?: BodyInit | null) => {
    beaconCalls.push({ url, body: body ?? null });
    return true; // queued
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { sendBeacon },
    writable: true,
    configurable: true,
  });

  return {
    documentListeners,
    beaconCalls,
    getVisibilityHandlers: () =>
      documentListeners.added.filter((l) => l.event === 'visibilitychange').map((l) => l.handler),
    setVisibilityState: (state) => {
      visibilityState = state;
    },
    restore: () => {
      if (originalDocument) {
        Object.defineProperty(globalThis, 'document', originalDocument);
      } else {
        try {
          // @ts-expect-error best-effort: workerd starts without document.
          delete globalThis.document;
        } catch {
          /* ignore */
        }
      }
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      } else {
        try {
          // @ts-expect-error best-effort.
          delete globalThis.navigator;
        } catch {
          /* ignore */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Stream harness: build a ReadableStream we can push SSE events into on
// demand, so the test can suspend the stream mid-flight (between
// `message_start` and `message_stop`) and inspect / trigger the listener
// wiring while the `finally` block has not yet executed.
// ---------------------------------------------------------------------------
function sseLine(event: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

function makeControlledStream(): {
  body: ReadableStream<Uint8Array>;
  push: (chunk: Uint8Array) => void;
  close: () => void;
  error: (e: unknown) => void;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    body,
    push: (chunk) => controller.enqueue(chunk),
    close: () => controller.close(),
    error: (e) => controller.error(e),
  };
}

// ---------------------------------------------------------------------------
// chatService import + fetch mocking. The wiring under test is inside
// `streamFromApi` (private), so we drive it through the public
// `streamMessage`. The `chatService` is a module-singleton; we replace
// `globalThis.fetch` per-test so each call gets a fresh fake.
// ---------------------------------------------------------------------------

interface FetchMock extends MockInstance {
  lastUrl?: string;
}

let fakes: DomFakes;
let stream: ReturnType<typeof makeControlledStream>;
let fetchSpy: FetchMock;

beforeEach(() => {
  fakes = installDomFakes();
  stream = makeControlledStream();

  fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
    fetchSpy.lastUrl = url;
    if (url.includes('/api/anthropic-stream')) {
      return new Response(stream.body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    // /api/reconcile-cost (fetch-fallback path) — return 200 OK quickly.
    return new Response('', { status: 200 });
  }) as unknown as FetchMock;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  fakes.restore();
  vi.restoreAllMocks();
});

// Helper: minimal `streamMessage` invocation that threads a logging message
// id so the tracker actually posts (it short-circuits when missing) and
// uses an empty graph + a single user turn so payload assembly is trivial.
function startStream(opts: {
  signal: AbortSignal;
  loggingMessageId?: string;
  callbacks?: import('../../src/services/chatService').StreamCallbacks;
}): Promise<void> {
  return chatService.streamMessage({
    messages: [{ role: 'user', content: 'hello' }],
    currentGraphData: { sections: [] },
    mode: 'chat',
    model: MODEL,
    signal: opts.signal,
    loggingMessageId: opts.loggingMessageId ?? LOGGING_MSG_ID,
    callbacks: opts.callbacks ?? {},
  });
}

describe('chatService streamFromApi listener wiring (PR #23 u3-test)', () => {
  it('registers visibilitychange + abort listeners after stream start, removes both in finally', async () => {
    const ac = new AbortController();
    const streamPromise = startStream({ signal: ac.signal });

    // Drive the stream up to message_start so the tracker has a non-zero
    // running cost. The wiring lives just before the read loop; once the
    // first chunk lands, listeners are registered.
    await Promise.resolve(); // let fetch resolve
    await Promise.resolve();
    stream.push(
      sseLine({
        type: 'message_start',
        message: { usage: { input_tokens: 1000, output_tokens: 10 } },
      }),
    );
    // Yield enough microtasks for the reader loop to consume message_start.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Registration assertion: visibilitychange on document; abort on signal
    // is harder to spy on directly (AbortSignal is a real EventTarget) so
    // verify via behavior in the next test. Here, focus on document.
    expect(
      fakes.documentListeners.added.filter((l) => l.event === 'visibilitychange'),
    ).toHaveLength(1);
    expect(fakes.documentListeners.removed).toHaveLength(0);

    // Finish the stream — message_stop triggers the finally cleanup.
    stream.push(sseLine({ type: 'message_stop' }));
    stream.close();
    await streamPromise;

    // Symmetric cleanup: same handler reference unregistered.
    expect(
      fakes.documentListeners.removed.filter((l) => l.event === 'visibilitychange'),
    ).toHaveLength(1);
    const addedHandler = fakes.documentListeners.added.find(
      (l) => l.event === 'visibilitychange',
    )!.handler;
    const removedHandler = fakes.documentListeners.removed.find(
      (l) => l.event === 'visibilitychange',
    )!.handler;
    expect(removedHandler).toBe(addedHandler);
  });

  it('fires sendBeacon when document.visibilitychange handler runs with state=hidden', async () => {
    const ac = new AbortController();
    const streamPromise = startStream({ signal: ac.signal });

    await Promise.resolve();
    await Promise.resolve();
    stream.push(
      sseLine({
        type: 'message_start',
        message: { usage: { input_tokens: 1000, output_tokens: 10 } },
      }),
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const [visHandler] = fakes.getVisibilityHandlers();
    expect(visHandler).toBeTypeOf('function');

    // Trigger the wiring: visibility hidden → tracker.maybePostReconcile('force-beacon').
    fakes.setVisibilityState('hidden');
    (visHandler as EventListener)(new Event('visibilitychange'));

    // Tracker uses sendBeacon (preferred) when mode='force-beacon'.
    expect(fakes.beaconCalls.length).toBeGreaterThanOrEqual(1);
    expect(fakes.beaconCalls[0].url).toBe('/api/reconcile-cost');

    // Don't leak the unfinished stream.
    stream.push(sseLine({ type: 'message_stop' }));
    stream.close();
    await streamPromise;
  });

  it('fires sendBeacon when the AbortSignal aborts mid-stream', async () => {
    const ac = new AbortController();
    const streamPromise = startStream({ signal: ac.signal });

    await Promise.resolve();
    await Promise.resolve();
    stream.push(
      sseLine({
        type: 'message_start',
        message: { usage: { input_tokens: 1000, output_tokens: 10 } },
      }),
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const beaconsBefore = fakes.beaconCalls.length;

    // Abort: the synchronous `abort` listener registered on signal fires
    // `tracker.maybePostReconcile('force-beacon')` BEFORE the reader.read()
    // rejection propagates. This is the Stop-button case from PR #23.
    ac.abort();

    // sendBeacon was fired by the abort listener.
    expect(fakes.beaconCalls.length).toBeGreaterThan(beaconsBefore);
    expect(fakes.beaconCalls[fakes.beaconCalls.length - 1].url).toBe('/api/reconcile-cost');

    // Drain: the reader will reject with AbortError, finally runs, listeners
    // are removed, the streamMessage promise resolves (AbortError swallowed
    // by the outer catch — see chatService.ts:1435).
    stream.error(new DOMException('Aborted', 'AbortError'));
    await streamPromise.catch(() => {
      /* expected: abort path may resolve cleanly */
    });

    expect(
      fakes.documentListeners.removed.filter((l) => l.event === 'visibilitychange'),
    ).toHaveLength(1);
  });

  it('after stream end, captured visibilitychange handler is unregistered (no leakage across sequential streams)', async () => {
    // Stream #1: end normally.
    {
      const ac = new AbortController();
      const p = startStream({ signal: ac.signal, loggingMessageId: 'msg-1' });
      await Promise.resolve();
      await Promise.resolve();
      stream.push(
        sseLine({
          type: 'message_start',
          message: { usage: { input_tokens: 1000, output_tokens: 10 } },
        }),
      );
      for (let i = 0; i < 10; i++) await Promise.resolve();
      stream.push(sseLine({ type: 'message_stop' }));
      stream.close();
      await p;
    }

    expect(
      fakes.documentListeners.added.filter((l) => l.event === 'visibilitychange'),
    ).toHaveLength(1);
    expect(
      fakes.documentListeners.removed.filter((l) => l.event === 'visibilitychange'),
    ).toHaveLength(1);

    // Fresh stream body for #2 — the ReadableStream from #1 is closed.
    stream = makeControlledStream();
    // Rewire fetch so the new stream body is returned.
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/api/anthropic-stream')) {
        return new Response(stream.body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return new Response('', { status: 200 });
    });

    // Stream #2: end normally.
    {
      const ac = new AbortController();
      const p = startStream({ signal: ac.signal, loggingMessageId: 'msg-2' });
      await Promise.resolve();
      await Promise.resolve();
      stream.push(
        sseLine({
          type: 'message_start',
          message: { usage: { input_tokens: 1000, output_tokens: 10 } },
        }),
      );
      for (let i = 0; i < 10; i++) await Promise.resolve();
      stream.push(sseLine({ type: 'message_stop' }));
      stream.close();
      await p;
    }

    // Cumulative register/unregister symmetry across both streams.
    const adds = fakes.documentListeners.added.filter((l) => l.event === 'visibilitychange');
    const rems = fakes.documentListeners.removed.filter((l) => l.event === 'visibilitychange');
    expect(adds).toHaveLength(2);
    expect(rems).toHaveLength(2);
    // Each unregister targets a previously-registered handler reference.
    for (const r of rems) {
      expect(adds.some((a) => a.handler === r.handler)).toBe(true);
    }
  });
});
