// Tests for `stop_reason: "refusal"` handling in chatService.
//
// A classifier refusal is an ordinary HTTP 200 SSE stream: the message_delta
// carries `delta.stop_reason: "refusal"` plus `delta.stop_details`, followed by
// message_stop. Anthropic's guidance is to treat whatever streamed before it as
// incomplete and to reset the conversation context before continuing.
//
// Contracts pinned here:
//   - A refused stream calls `onRefusal` (with the stop_details) and NOT
//     `onComplete`, so partial text, [EDIT_INSTRUCTIONS] and content blocks of
//     the refused turn never reach the caller.
//   - The refused stream's usage is still costed and reconciled.
//   - Each refusal is reported once as `ModelRefusal` (category, model, stage;
//     never the explanation or any content).
//   - A refusal is acted on even when the stream drops or ends after its
//     message_delta, and a drop never triggers the network retry (that would
//     re-send a prompt that is refused again).
//   - A throwing onRefusal is contained like a throwing onComplete; without an
//     onRefusal the refusal falls back to onError (guarded the same way).
//   - A refusal already seen takes precedence over a cost-error event that
//     follows it (e.g. the worker's end-of-stream kill).
//   - Streams that end normally are unaffected.
//
// Harness mirrors `chatService-onAccepted.test.ts`: fake DOM globals, a
// controlled ReadableStream body and a mocked global fetch.
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

import { chatService, type StreamCallbacks } from '../../src/services/chatService';
import { loggingService } from '../../src/services/loggingService';

const MODEL = 'claude-opus-4-7';

interface Fakes {
  beaconUrls: string[];
  restore: () => void;
}

function installDomFakes(): Fakes {
  const beaconUrls: string[] = [];
  const fakeDocument = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'document', {
    value: fakeDocument,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      sendBeacon: (url: string) => {
        beaconUrls.push(url);
        return true;
      },
    },
    writable: true,
    configurable: true,
  });
  return {
    beaconUrls,
    restore: () => {
      for (const [key, original] of [
        ['document', originalDocument],
        ['navigator', originalNavigator],
      ] as const) {
        if (original) {
          Object.defineProperty(globalThis, key, original);
        } else {
          try {
            // @ts-expect-error workerd starts without document/navigator
            delete globalThis[key];
          } catch {
            /* ignore */
          }
        }
      }
    },
  };
}

function sseLine(event: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

let fetchMock: MockInstance;

/** Number of requests sent to the stream endpoint (more than 1 means a retry). */
const streamRequests = () =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes('/api/anthropic-stream')).length;

/**
 * Resolves once `streamMessage` has consumed a full SSE script. The script is
 * delivered one event per read; `end` is how the body finishes afterwards:
 * closed cleanly (default) or errored, as on a dropped connection.
 */
async function runStream(
  events: object[],
  callbacks: StreamCallbacks,
  opts: { loggingMessageId?: string; end?: Error } = {},
): Promise<void> {
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < events.length) controller.enqueue(sseLine(events[next++]));
      else if (opts.end) controller.error(opts.end);
      else controller.close();
    },
  });
  fetchMock = vi.fn(
    async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  await chatService.streamMessage({
    messages: [{ id: 'u1', role: 'user', content: 'hello', timestamp: new Date() }],
    currentGraphData: { sections: [] },
    mode: 'chat',
    model: MODEL,
    loggingMessageId: opts.loggingMessageId,
    callbacks,
  });
}

const messageStart = {
  type: 'message_start',
  message: { usage: { input_tokens: 412, output_tokens: 1 } },
};

const refusalDelta = (stopDetails: unknown) => ({
  type: 'message_delta',
  delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: stopDetails },
  usage: { output_tokens: 0 },
});

const textBlock = (text: string) => [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  { type: 'content_block_stop', index: 0 },
];

let fakes: Fakes;
let reportError: MockInstance<typeof loggingService.reportError>;

beforeEach(() => {
  fakes = installDomFakes();
  reportError = vi.spyOn(loggingService, 'reportError').mockImplementation(() => {});
});

afterEach(() => {
  fakes.restore();
  vi.restoreAllMocks();
});

describe('chatService refusal handling', () => {
  it('calls onRefusal with stop_details and not onComplete when a stream is refused before any output', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onRefusal = vi.fn();
    const onComplete = vi.fn();
    const onError = vi.fn();

    await runStream(
      [
        messageStart,
        refusalDelta({
          type: 'refusal',
          category: 'cyber',
          explanation: 'This request was declined because it could enable cyber harm.',
        }),
        { type: 'message_stop' },
      ],
      { onRefusal, onComplete, onError },
    );

    expect(onRefusal).toHaveBeenCalledTimes(1);
    expect(onRefusal).toHaveBeenCalledWith({
      category: 'cyber',
      explanation: 'This request was declined because it could enable cyber harm.',
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not call onComplete, so no edit instructions or content blocks are handed over, when a refusal follows a complete edit block', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onRefusal = vi.fn();
    const onComplete = vi.fn();
    const complete =
      'Sure. [EDIT_INSTRUCTIONS][{"type":"update","path":"sections.0.title","value":"X"}][/EDIT_INSTRUCTIONS]';

    await runStream(
      [
        messageStart,
        ...textBlock(complete),
        refusalDelta({ type: 'refusal', category: 'bio', explanation: 'Declined.' }),
        { type: 'message_stop' },
      ],
      { onRefusal, onComplete },
    );

    expect(onRefusal).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('reports null category and explanation when stop_details is null, its fields are null, or the explanation is blank', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onRefusal = vi.fn();

    await runStream([messageStart, refusalDelta(null), { type: 'message_stop' }], { onRefusal });
    await runStream(
      [
        messageStart,
        refusalDelta({ type: 'refusal', category: null, explanation: null }),
        { type: 'message_stop' },
      ],
      { onRefusal },
    );

    await runStream(
      [
        messageStart,
        refusalDelta({ type: 'refusal', category: null, explanation: '   ' }),
        { type: 'message_stop' },
      ],
      { onRefusal },
    );

    expect(onRefusal).toHaveBeenCalledTimes(3);
    expect(onRefusal).toHaveBeenNthCalledWith(1, { category: null, explanation: null });
    expect(onRefusal).toHaveBeenNthCalledWith(2, { category: null, explanation: null });
    expect(onRefusal).toHaveBeenNthCalledWith(3, { category: null, explanation: null });
  });

  it('still costs and reconciles the usage of a refused stream', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onRefusal = vi.fn();
    const onCostUpdate = vi.fn();

    await runStream(
      [
        messageStart,
        refusalDelta({ type: 'refusal', category: 'bio', explanation: null }),
        { type: 'message_stop' },
      ],
      { onRefusal, onCostUpdate },
      { loggingMessageId: '00000000-0000-4000-8000-000000000001' },
    );

    expect(onRefusal).toHaveBeenCalledTimes(1);
    // 412 input tokens priced at the model's input rate: a refused stream's
    // usage is costed like any other stream's.
    expect(onCostUpdate).toHaveBeenCalled();
    expect(onCostUpdate.mock.calls.at(-1)![0]).toBeGreaterThan(0);
    // The stream-end reconcile POST still fires from the `finally` block.
    expect(fakes.beaconUrls).toContain('/api/reconcile-cost');
  });

  it('reports a refusal before any output as ModelRefusal with category, model and stage only', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const explanation = 'This request was declined because it could enable cyber harm.';

    await runStream(
      [
        messageStart,
        refusalDelta({ type: 'refusal', category: 'cyber', explanation }),
        { type: 'message_stop' },
      ],
      { onRefusal: vi.fn() },
    );

    expect(reportError).toHaveBeenCalledTimes(1);
    const report = reportError.mock.calls[0][0];
    expect(report.error_name).toBe('ModelRefusal');
    expect(report.request_metadata).toEqual({
      category: 'cyber',
      model: MODEL,
      stage: 'before_output',
    });
    expect(JSON.stringify(report)).not.toContain(explanation);
  });

  it('reports a mid-stream refusal with stage mid_stream and never the streamed text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runStream(
      [
        messageStart,
        ...textBlock('a secret draft answer'),
        refusalDelta({ type: 'refusal', category: null, explanation: 'Some explanation.' }),
        { type: 'message_stop' },
      ],
      { onRefusal: vi.fn() },
    );

    expect(reportError).toHaveBeenCalledTimes(1);
    const report = reportError.mock.calls[0][0];
    expect(report.request_metadata).toEqual({ category: null, model: MODEL, stage: 'mid_stream' });
    expect(report.error_message).toContain('category=none');
    expect(JSON.stringify(report)).not.toContain('a secret draft answer');
    expect(JSON.stringify(report)).not.toContain('Some explanation.');
  });

  it('ends the turn as a refusal when the connection drops after the refusal message_delta, without retrying', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onRefusal = vi.fn();
    const onError = vi.fn();
    const onComplete = vi.fn();

    await runStream(
      [messageStart, refusalDelta({ type: 'refusal', category: 'bio', explanation: null })],
      { onRefusal, onError, onComplete },
      { end: new TypeError('network error') },
    );

    expect(onRefusal).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    // A retry would re-send a prompt that is refused again.
    expect(streamRequests()).toBe(1);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0].error_name).toBe('ModelRefusal');
  });

  it('ends the turn as a refusal when the stream closes after the refusal message_delta without message_stop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onRefusal = vi.fn();
    const onError = vi.fn();

    await runStream(
      [
        messageStart,
        refusalDelta({ type: 'refusal', category: 'cyber', explanation: 'Declined.' }),
      ],
      { onRefusal, onError },
    );

    expect(onRefusal).toHaveBeenCalledTimes(1);
    expect(onRefusal).toHaveBeenCalledWith({ category: 'cyber', explanation: 'Declined.' });
    expect(onError).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][0].error_name).toBe('ModelRefusal');
  });

  it('still reports a stream that closes early without any refusal as an error', async () => {
    const onRefusal = vi.fn();
    const onError = vi.fn();

    await runStream([messageStart], { onRefusal, onError });

    expect(onRefusal).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('contains a throwing onRefusal: no onError, no retry, the failure is reported', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn();
    // A TypeError would be classified as a network error and retried if it
    // escaped into the generic error path.
    const onRefusal = vi.fn(() => {
      throw new TypeError('handler failed');
    });

    await runStream(
      [
        messageStart,
        refusalDelta({ type: 'refusal', category: 'cyber', explanation: null }),
        { type: 'message_stop' },
      ],
      { onRefusal, onError },
    );

    expect(onRefusal).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(streamRequests()).toBe(1);
    expect(reportError.mock.calls.map(([report]) => report.error_name)).toEqual([
      'ModelRefusal',
      'onRefusalCallback:TypeError',
    ]);
    expect(reportError.mock.calls[1][0].error_message).toBe('handler failed');
  });

  it('falls back to onError when the caller passes no onRefusal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onError = vi.fn();
    const onComplete = vi.fn();

    await runStream(
      [
        messageStart,
        refusalDelta({ type: 'refusal', category: 'cyber', explanation: null }),
        { type: 'message_stop' },
      ],
      { onError, onComplete },
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toContain('safety filter');
    expect(onComplete).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('contains a throwing onError fallback when the caller passes no onRefusal', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onError = vi.fn(() => {
      throw new Error('onError failed');
    });

    await runStream(
      [
        messageStart,
        refusalDelta({ type: 'refusal', category: 'cyber', explanation: null }),
        { type: 'message_stop' },
      ],
      { onError },
    );

    // Not rethrown into the generic error path, which would call onError again.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls.map(([report]) => report.error_name)).toEqual([
      'ModelRefusal',
      'onRefusalCallback:Error',
    ]);
  });

  it('delivers a refusal, not a cost error, when a cost-error event follows the refusal message_delta', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onRefusal = vi.fn();
    const onCostError = vi.fn();
    const onError = vi.fn();

    await runStream(
      [
        messageStart,
        ...textBlock('partial'),
        refusalDelta({ type: 'refusal', category: 'bio', explanation: null }),
        { type: 'request_cost_ceiling_exceeded' },
      ],
      { onRefusal, onCostError, onError },
    );

    expect(onRefusal).toHaveBeenCalledTimes(1);
    // The caller would stamp the refused partial as a cut-off turn and keep
    // the user message that the refusal removes.
    expect(onCostError).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('still routes a cost-error event to onCostError when no refusal was seen', async () => {
    const onRefusal = vi.fn();
    const onCostError = vi.fn();

    await runStream([messageStart, { type: 'request_cost_ceiling_exceeded' }], {
      onRefusal,
      onCostError,
    });

    expect(onCostError).toHaveBeenCalledTimes(1);
    expect(onCostError.mock.calls[0][0]).toMatchObject({ type: 'request_cost_ceiling_exceeded' });
    expect(onRefusal).not.toHaveBeenCalled();
  });

  it.each(['max_tokens', 'tool_use', 'pause_turn'])(
    'does not treat a %s stop as a refusal: onComplete fires, no onRefusal, no ModelRefusal',
    async (stopReason) => {
      const onRefusal = vi.fn();
      const onComplete = vi.fn();

      await runStream(
        [
          messageStart,
          ...textBlock('A real answer.'),
          {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null },
            usage: { output_tokens: 5 },
          },
          { type: 'message_stop' },
        ],
        { onRefusal, onComplete },
      );

      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete.mock.calls[0][0]).toBe('A real answer.');
      expect(onRefusal).not.toHaveBeenCalled();
      expect(reportError).not.toHaveBeenCalled();
    },
  );

  it('leaves a normally ended stream alone: onComplete fires, onRefusal does not', async () => {
    const onRefusal = vi.fn();
    const onComplete = vi.fn();

    await runStream(
      [
        messageStart,
        ...textBlock('All good.'),
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ],
      { onRefusal, onComplete },
    );

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toBe('All good.');
    expect(onRefusal).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
});
