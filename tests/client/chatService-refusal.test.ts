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
//   - Streams that end normally are unaffected.
//
// Harness mirrors `chatService-onAccepted.test.ts`: fake DOM globals, a
// controlled ReadableStream body and a mocked global fetch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { chatService, type StreamCallbacks } from '../../src/services/chatService';

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

/** Resolves once `streamMessage` has consumed a full SSE script. */
async function runStream(
  events: object[],
  callbacks: StreamCallbacks,
  opts: { loggingMessageId?: string } = {},
): Promise<void> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(sseLine(event));
      controller.close();
    },
  });
  globalThis.fetch = vi.fn(
    async () =>
      new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  ) as unknown as typeof fetch;

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

beforeEach(() => {
  fakes = installDomFakes();
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

  it('does not hand partial output (text, content blocks, edit instructions) to the caller on a mid-stream refusal', async () => {
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

  it('reports null category and explanation when stop_details is null or its fields are null', async () => {
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

    expect(onRefusal).toHaveBeenCalledTimes(2);
    expect(onRefusal).toHaveBeenNthCalledWith(1, { category: null, explanation: null });
    expect(onRefusal).toHaveBeenNthCalledWith(2, { category: null, explanation: null });
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
    // 412 input tokens priced at the model's input rate: a refusal is billed
    // from its usage like any other stream.
    expect(onCostUpdate).toHaveBeenCalled();
    expect(onCostUpdate.mock.calls.at(-1)![0]).toBeGreaterThan(0);
    // The stream-end reconcile POST still fires from the `finally` block.
    expect(fakes.beaconUrls).toContain('/api/reconcile-cost');
  });

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
  });
});
