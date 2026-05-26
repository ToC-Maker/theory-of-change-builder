// Tests for the `onAccepted` callback wiring in chatService.
//
// `onAccepted` is the deferred-add-on-preflight signal: it fires after the
// server's `reserveCost` preflight reservation accepts the request
// (`response.ok === true`) and BEFORE the SSE stream starts producing
// content. Callers (ChatInterface) use it to commit the user message to
// chat history, clear the composer, and switch modes — work that today
// happens optimistically before the fetch, leaking orphan user messages
// when the preflight rejects (429 cap, 413 body too large, etc.).
//
// Coverage focuses on two contracts:
//   - On `response.ok` (HTTP 200), `onAccepted` fires exactly once before
//     SSE delivery starts.
//   - When `streamFromApi` is called twice for the same `streamMessage`
//     invocation (the H3-fallback retry path at chatService.ts:1545),
//     the wrapped `onAccepted` only fires ONCE across both attempts.
//     Without the at-most-once guard at the `streamMessage` wrapper layer,
//     a retry whose first attempt's preflight already accepted (and then
//     mid-stream failed) would double-fire and the user would see two
//     copies of the same message in chat.
//   - On error responses (HTTP 4xx/5xx), `onAccepted` does NOT fire.
//
// Test harness mirrors `chatService-unload-wiring.test.ts`: fake DOM
// globals, controlled ReadableStream body, mocked global fetch.
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

import { chatService } from '../../src/services/chatService';

const MODEL = 'claude-opus-4-7';
const LOGGING_MSG_ID = 'msg-on-accepted';

interface ListenerEntry {
  event: string;
  handler: EventListenerOrEventListenerObject;
  options?: AddEventListenerOptions | boolean;
}

interface DomFakes {
  documentListeners: { added: ListenerEntry[]; removed: ListenerEntry[] };
  restore: () => void;
}

function installDomFakes(): DomFakes {
  const documentListeners: { added: ListenerEntry[]; removed: ListenerEntry[] } = {
    added: [],
    removed: [],
  };
  const fakeDocument = {
    visibilityState: 'visible' as DocumentVisibilityState,
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
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'document', {
    value: fakeDocument,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: { sendBeacon: vi.fn(() => true) },
    writable: true,
    configurable: true,
  });
  return {
    documentListeners,
    restore: () => {
      if (originalDocument) {
        Object.defineProperty(globalThis, 'document', originalDocument);
      } else {
        try {
          // @ts-expect-error workerd starts without document
          delete globalThis.document;
        } catch {
          /* ignore */
        }
      }
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      } else {
        try {
          // @ts-expect-error workerd starts without navigator
          delete globalThis.navigator;
        } catch {
          /* ignore */
        }
      }
    },
  };
}

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
    return new Response('', { status: 200 });
  }) as unknown as FetchMock;
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  fakes.restore();
  vi.restoreAllMocks();
});

function startStream(opts: {
  signal?: AbortSignal;
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

describe('chatService.streamMessage onAccepted callback', () => {
  it('fires onAccepted exactly once after a successful (200) preflight, before the stream completes', async () => {
    const onAccepted = vi.fn();
    const onComplete = vi.fn();
    const ac = new AbortController();
    const p = startStream({
      signal: ac.signal,
      callbacks: { onAccepted, onComplete },
    });

    // Let the fetch resolve. After response.ok is checked, onAccepted should
    // fire BEFORE the SSE read loop starts consuming chunks.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(onAccepted).toHaveBeenCalledTimes(1);
    // onComplete should not have fired yet — stream hasn't produced anything.
    expect(onComplete).not.toHaveBeenCalled();

    // Drive stream to completion.
    stream.push(
      sseLine({
        type: 'message_start',
        message: { usage: { input_tokens: 100, output_tokens: 10 } },
      }),
    );
    stream.push(sseLine({ type: 'message_stop' }));
    stream.close();
    await p;

    // onAccepted still exactly once after the stream ends.
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onAccepted when the server rejects the preflight (HTTP 429 lifetime_cap_reached)', async () => {
    const onAccepted = vi.fn();
    const onCostError = vi.fn();

    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/api/anthropic-stream')) {
        return new Response(JSON.stringify({ error: { type: 'lifetime_cap_reached' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('', { status: 200 });
    });

    const ac = new AbortController();
    await startStream({
      signal: ac.signal,
      callbacks: { onAccepted, onCostError },
    });

    expect(onAccepted).not.toHaveBeenCalled();
    // Sanity: the cap error did surface through onCostError.
    expect(onCostError).toHaveBeenCalledTimes(1);
    expect(onCostError.mock.calls[0][0]).toMatchObject({ type: 'lifetime_cap_reached' });
  });

  it('does NOT fire onAccepted when the server rejects with HTTP 413 body_too_large', async () => {
    const onAccepted = vi.fn();
    const onCostError = vi.fn();

    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/api/anthropic-stream')) {
        return new Response(JSON.stringify({ error: { type: 'body_too_large' } }), {
          status: 413,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('', { status: 200 });
    });

    const ac = new AbortController();
    await startStream({
      signal: ac.signal,
      callbacks: { onAccepted, onCostError },
    });

    expect(onAccepted).not.toHaveBeenCalled();
    expect(onCostError).toHaveBeenCalledTimes(1);
  });

  it('fires onAccepted only ONCE across an H3-fallback retry (at-most-once guard)', async () => {
    // Two attempts: first one's response body errors mid-stream with a network-like
    // error AFTER the preflight already accepted; the retry's preflight also accepts.
    // The wrapper's at-most-once guard must prevent onAccepted firing twice.
    const onAccepted = vi.fn();
    const onComplete = vi.fn();

    let attempt = 0;
    let secondStream: ReturnType<typeof makeControlledStream> | null = null;

    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : ((input as Request).url ?? String(input));
      if (url.includes('/api/anthropic-stream')) {
        attempt += 1;
        if (attempt === 1) {
          // First attempt: response.ok, stream will error after onAccepted fires.
          return new Response(stream.body, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        // Second attempt (force-h2 retry): fresh stream, completes normally.
        secondStream = makeControlledStream();
        return new Response(secondStream.body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return new Response('', { status: 200 });
    });

    const ac = new AbortController();
    const p = startStream({
      signal: ac.signal,
      callbacks: { onAccepted, onComplete },
    });

    // Let the first preflight resolve → onAccepted should fire (attempt 1).
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(onAccepted).toHaveBeenCalledTimes(1);

    // Simulate a network failure mid-stream on the first attempt. The catch
    // block in streamMessage detects a network error and retries via
    // streamFromApi a second time (the H3->H2 path).
    stream.error(new TypeError('network changed'));

    // Allow microtasks to drain so the retry's fetch resolves.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // Push a clean stream completion through the retry's body.
    if (secondStream) {
      (secondStream as ReturnType<typeof makeControlledStream>).push(
        sseLine({
          type: 'message_start',
          message: { usage: { input_tokens: 100, output_tokens: 10 } },
        }),
      );
      (secondStream as ReturnType<typeof makeControlledStream>).push(
        sseLine({ type: 'message_stop' }),
      );
      (secondStream as ReturnType<typeof makeControlledStream>).close();
    }
    await p;

    // CRITICAL: at-most-once across both attempts.
    expect(onAccepted).toHaveBeenCalledTimes(1);
    // And both preflights succeeded → both attempts ran.
    expect(attempt).toBe(2);
  });
});
