// Tests for the CostTracker helper used by chatService for per-delta cost
// estimation. The original chatService inline state machine was too tightly
// coupled to fetch/sendBeacon/AbortController and ?raw prompt imports to
// unit-test directly in workerd; the cost-tracking surface lives in its own
// module so it can be exercised with simple object inputs.
//
// Coverage focuses on:
//   - On a `content_block_delta` text event, the running estimate
//     increments to computeCostMicroUsd(model, {output_tokens: chars/4 ceiled}).
//   - `onCostUpdate` fires with the new USD value each delta.
//   - `lastCostMicroUsd` is monotone-non-decreasing across deltas.
//   - Output-only fallback when no `running_cost` SSE frame has arrived:
//     input contribution is 0 (running input/cache locals stay at 0).
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CostTracker } from '../../src/services/chatCostTracker';
import { computeCostMicroUsd } from '../../shared/cost';

const MODEL = 'claude-opus-4-7';

describe('CostTracker.recordOutputChars (per-content_block_delta estimation)', () => {
  beforeEach(() => {
    // Pin Date.now so the maybePostReconcile clock-debouncer is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('estimates output cost from characters (chars/4 → tokens) on each delta', () => {
    const onCostUpdate = vi.fn<(usd: number) => void>();
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate,
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    tracker.recordOutputChars(100);

    // 100 chars / 4 = 25 output tokens.
    const expectedMicro = computeCostMicroUsd(MODEL, { output_tokens: 25 });
    expect(tracker.lastCostMicroUsd).toBe(expectedMicro);
    expect(onCostUpdate).toHaveBeenCalledTimes(1);
    expect(onCostUpdate).toHaveBeenLastCalledWith(Number(expectedMicro) / 1_000_000);
  });

  it('uses ceil() rounding so partial tokens always count up', () => {
    const onCostUpdate = vi.fn<(usd: number) => void>();
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate,
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    // 1 char would be 0.25 tokens — must round up to 1.
    tracker.recordOutputChars(1);
    expect(tracker.lastCostMicroUsd).toBe(computeCostMicroUsd(MODEL, { output_tokens: 1 }));

    // Adding a few more chars: 1+5 = 6 chars → ceil(6/4) = 2 tokens.
    tracker.recordOutputChars(5);
    expect(tracker.lastCostMicroUsd).toBe(computeCostMicroUsd(MODEL, { output_tokens: 2 }));
  });

  it('lastCostMicroUsd is monotone-non-decreasing across deltas', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    const seen: bigint[] = [];
    for (const charDelta of [50, 30, 200, 1, 1, 100]) {
      tracker.recordOutputChars(charDelta);
      seen.push(tracker.lastCostMicroUsd);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
    // Total: 50+30+200+1+1+100 = 382 chars → 96 tokens.
    expect(tracker.lastCostMicroUsd).toBe(computeCostMicroUsd(MODEL, { output_tokens: 96 }));
  });

  it('output-only fallback: with no running_cost frame, only output cost is contributed', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    tracker.recordOutputChars(800); // 200 output tokens.

    const onlyOutput = computeCostMicroUsd(MODEL, { output_tokens: 200 });
    expect(tracker.lastCostMicroUsd).toBe(onlyOutput);
    // Sanity-check: input would otherwise add a sizeable chunk; we should
    // be paying exactly the output-only rate ($25/MTok for opus-4.7).
    // 200 tokens × $25/MTok = 5_000 µUSD.
    expect(tracker.lastCostMicroUsd).toBe(5_000n);
  });

  it('does NOT regress when usage updates carry lower MAX-per-field values', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    // First usage event sets a sizeable input+output baseline.
    tracker.recordUsage({
      input_tokens: 10_000,
      output_tokens: 500,
      cache_creation_input_tokens: 2_000,
      cache_read_input_tokens: 5_000,
      server_tool_use: { web_search_requests: 3 },
    });
    const baseline = tracker.lastCostMicroUsd;

    // A later out-of-order usage event lists smaller values — must be MAX-merged
    // (the running locals stay at the high-water mark, not the new low).
    tracker.recordUsage({
      input_tokens: 5_000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    });
    expect(tracker.lastCostMicroUsd).toBeGreaterThanOrEqual(baseline);
    expect(tracker.lastCostMicroUsd).toBe(baseline); // exactly preserved
  });

  it('combines running input from usage with running output chars from deltas', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    // First a message_start usage with input baseline.
    tracker.recordUsage({ input_tokens: 4_000, output_tokens: 8 });
    // Then content_block_delta-driven chars: 1000 chars → 250 output tokens (> 8).
    tracker.recordOutputChars(1000);

    // Expected: input=4000, output=max(8, 250)=250.
    const expected = computeCostMicroUsd(MODEL, {
      input_tokens: 4_000,
      output_tokens: 250,
    });
    expect(tracker.lastCostMicroUsd).toBe(expected);
  });

  it('uses MAX(usage.output_tokens, char-estimate) so server-reported output also stays MAX-monotone', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    tracker.recordOutputChars(40); // 10 tokens char-estimate.
    // Later, a message_delta lands an authoritative output_tokens=200 (server count).
    tracker.recordUsage({ input_tokens: 0, output_tokens: 200 });
    expect(tracker.lastCostMicroUsd).toBe(computeCostMicroUsd(MODEL, { output_tokens: 200 }));

    // After that, a very small char-delta should NOT regress.
    tracker.recordOutputChars(2);
    expect(tracker.lastCostMicroUsd).toBe(computeCostMicroUsd(MODEL, { output_tokens: 200 }));
  });

  it('integrates server running_cost — bigint cost_micro_usd dominates if higher', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    tracker.recordOutputChars(40); // 10 tokens × $25/MTok = 250 µUSD.
    expect(tracker.lastCostMicroUsd).toBe(250n);

    // A running_cost SSE frame lands with a precise server-side value:
    tracker.recordServerCostMicroUsd(1_234_567n);
    expect(tracker.lastCostMicroUsd).toBe(1_234_567n);
  });

  it('integrates server running_cost — ignores stale (lower) cost_micro_usd', () => {
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate: vi.fn(),
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    tracker.recordServerCostMicroUsd(2_000_000n);
    tracker.recordServerCostMicroUsd(1_000_000n); // out-of-order frame; ignore.
    expect(tracker.lastCostMicroUsd).toBe(2_000_000n);
  });

  it('throws on unknown model rather than silently zeroing', () => {
    // Sanity: the underlying computeCostMicroUsd throws on unknown model;
    // CostTracker must surface that rather than swallow.
    expect(() =>
      new CostTracker({
        model: 'unknown-model',
        onCostUpdate: vi.fn(),
        loggingMessageId: 'msg-1',
        authToken: null,
        postReconcile: vi.fn(),
      }).recordOutputChars(100),
    ).toThrow();
  });

  it('does not fire onCostUpdate if cost does not strictly increase', () => {
    const onCostUpdate = vi.fn<(usd: number) => void>();
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate,
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    tracker.recordOutputChars(40); // 10 tokens.
    expect(onCostUpdate).toHaveBeenCalledTimes(1);

    // Sub-token char delta (1 char) bumps ceiled token count from 10 -> 11
    // → strictly higher cost → fires.
    tracker.recordOutputChars(1);
    expect(onCostUpdate).toHaveBeenCalledTimes(2);

    // recordOutputChars(0) should not change anything.
    tracker.recordOutputChars(0);
    expect(onCostUpdate).toHaveBeenCalledTimes(2);

    // A redundant usage event with smaller values shouldn't fire.
    tracker.recordUsage({ output_tokens: 5 });
    expect(onCostUpdate).toHaveBeenCalledTimes(2);
  });
});

describe('CostTracker — onCostUpdate callback isolation', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-16T12:00:00.000Z'));
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  // Asymmetry-fix: chatService.ts wraps onComplete/onContentBlocks in try/catch
  // so a React-side throw doesn't kill the stream. onCostUpdate was the
  // exception — a throw from the BYOK pill setter would bubble up through
  // recomputeAndPropagate -> recordOutputChars -> the SSE-event try/catch in
  // chatService.ts, get tagged as `isSSEProcessingError`, and tear down the
  // whole stream. The fix wraps each onCostUpdate invocation in try/catch
  // and routes the error through console.error without rethrowing.
  it('stream survives an onCostUpdate that throws on the per-delta path (recomputeAndPropagate)', () => {
    const onCostUpdate = vi.fn<(usd: number) => void>().mockImplementation(() => {
      throw new Error('react setState on unmounted component');
    });
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate,
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    // recordOutputChars must NOT throw even though the callback does.
    expect(() => tracker.recordOutputChars(40)).not.toThrow();
    // The cost was still updated (callback failure does not regress state).
    expect(tracker.lastCostMicroUsd).toBeGreaterThan(0n);
    // console.error was called with a recognizable tag so on-call can spot it.
    expect(consoleErrorSpy).toHaveBeenCalled();
    const calledMessage = String(consoleErrorSpy.mock.calls[0]?.[0] ?? '');
    expect(calledMessage).toMatch(/cost-tracker.*onCostUpdate/i);

    // A second delta still fires the callback (and survives the second throw).
    expect(() => tracker.recordOutputChars(40)).not.toThrow();
    expect(onCostUpdate).toHaveBeenCalledTimes(2);
  });

  it('stream survives an onCostUpdate that throws on the server-frame path (recordServerCostMicroUsd)', () => {
    const onCostUpdate = vi.fn<(usd: number) => void>().mockImplementation(() => {
      throw new Error('cost pill renderer exploded');
    });
    const tracker = new CostTracker({
      model: MODEL,
      onCostUpdate,
      loggingMessageId: 'msg-1',
      authToken: null,
      postReconcile: vi.fn(),
    });

    // Server running_cost frame path: separate invocation site.
    expect(() => tracker.recordServerCostMicroUsd(1_234_567n)).not.toThrow();
    expect(tracker.lastCostMicroUsd).toBe(1_234_567n);
    expect(consoleErrorSpy).toHaveBeenCalled();
    // A second strictly-higher frame still routes through and still survives.
    expect(() => tracker.recordServerCostMicroUsd(2_000_000n)).not.toThrow();
    expect(tracker.lastCostMicroUsd).toBe(2_000_000n);
    expect(onCostUpdate).toHaveBeenCalledTimes(2);
  });
});
