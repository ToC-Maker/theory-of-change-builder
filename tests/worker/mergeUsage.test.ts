import { describe, expect, it } from 'vitest';
import { mergeUsage } from '../../worker/api/anthropic-stream';

// Construct a fresh accumulator. Mirrors `UsageAccumulator` in
// `worker/api/anthropic-stream.ts` (flat `web_search_requests`; the
// nested `server_tool_use.web_search_requests` shape is the *wire* form
// that `mergeUsage` flattens into this field).
function newAcc() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    web_search_requests: 0,
  };
}

describe('mergeUsage', () => {
  it('uses MAX-per-field, not last-write-wins (input + output)', () => {
    const acc = newAcc();
    acc.input_tokens = 100;
    acc.output_tokens = 5;

    // First update raises output but does not touch input.
    mergeUsage(acc, { output_tokens: 50 });
    expect(acc.input_tokens).toBe(100);
    expect(acc.output_tokens).toBe(50);

    // Second update tries to lower input — must NOT regress.
    mergeUsage(acc, { input_tokens: 50 });
    expect(acc.input_tokens).toBe(100);

    // And one more lowering output — must NOT regress.
    mergeUsage(acc, { output_tokens: 10 });
    expect(acc.output_tokens).toBe(50);
  });

  it('takes MAX for cache_creation_input_tokens (no regress on lower frame)', () => {
    const acc = newAcc();
    mergeUsage(acc, { cache_creation_input_tokens: 200 });
    expect(acc.cache_creation_input_tokens).toBe(200);

    mergeUsage(acc, { cache_creation_input_tokens: 50 });
    expect(acc.cache_creation_input_tokens).toBe(200);

    mergeUsage(acc, { cache_creation_input_tokens: 250 });
    expect(acc.cache_creation_input_tokens).toBe(250);
  });

  it('takes MAX for cache_read_input_tokens (no regress on lower frame)', () => {
    const acc = newAcc();
    mergeUsage(acc, { cache_read_input_tokens: 300 });
    expect(acc.cache_read_input_tokens).toBe(300);

    mergeUsage(acc, { cache_read_input_tokens: 100 });
    expect(acc.cache_read_input_tokens).toBe(300);
  });

  it('takes MAX for nested server_tool_use.web_search_requests (no regress on lower frame)', () => {
    const acc = newAcc();
    mergeUsage(acc, { server_tool_use: { web_search_requests: 5 } });
    expect(acc.web_search_requests).toBe(5);

    mergeUsage(acc, { server_tool_use: { web_search_requests: 2 } });
    expect(acc.web_search_requests).toBe(5);

    mergeUsage(acc, { server_tool_use: { web_search_requests: 8 } });
    expect(acc.web_search_requests).toBe(8);
  });

  it('ignores non-numeric values (type guard)', () => {
    const acc = newAcc();
    acc.input_tokens = 100;
    mergeUsage(acc, {
      input_tokens: 'oops' as unknown as number,
      output_tokens: null as unknown as number,
      cache_creation_input_tokens: undefined,
      server_tool_use: 'nope' as unknown as Record<string, unknown>,
    });
    expect(acc.input_tokens).toBe(100);
    expect(acc.output_tokens).toBe(0);
    expect(acc.cache_creation_input_tokens).toBe(0);
    expect(acc.web_search_requests).toBe(0);
  });

  it('ignores nested server_tool_use with non-numeric web_search_requests', () => {
    const acc = newAcc();
    acc.web_search_requests = 7;
    mergeUsage(acc, { server_tool_use: { web_search_requests: 'x' as unknown as number } });
    expect(acc.web_search_requests).toBe(7);
  });
});
