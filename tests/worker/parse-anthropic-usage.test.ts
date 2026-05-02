import { describe, expect, it } from 'vitest';
import { parseAnthropicUsage } from '../../worker/_shared/cost';

describe('parseAnthropicUsage', () => {
  it('parses a valid usage object with all integer fields', () => {
    const out = parseAnthropicUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
      server_tool_use: { web_search_requests: 2 },
    });
    expect(out).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
      server_tool_use: { web_search_requests: 2 },
    });
  });

  it('leaves missing optional fields undefined (no zero injection)', () => {
    const out = parseAnthropicUsage({ input_tokens: 10 });
    expect(out.input_tokens).toBe(10);
    expect(out.output_tokens).toBeUndefined();
    expect(out.cache_creation_input_tokens).toBeUndefined();
    expect(out.cache_read_input_tokens).toBeUndefined();
    expect(out.server_tool_use).toBeUndefined();
  });

  it('empty object parses to all-undefined (not zeros)', () => {
    const out = parseAnthropicUsage({});
    expect(out.input_tokens).toBeUndefined();
    expect(out.output_tokens).toBeUndefined();
    expect(out.cache_creation_input_tokens).toBeUndefined();
    expect(out.cache_read_input_tokens).toBeUndefined();
    expect(out.server_tool_use).toBeUndefined();
  });

  it('accepts explicit zeros (0 is a valid non-negative integer)', () => {
    const out = parseAnthropicUsage({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    expect(out.input_tokens).toBe(0);
    expect(out.output_tokens).toBe(0);
    expect(out.cache_creation_input_tokens).toBe(0);
    expect(out.cache_read_input_tokens).toBe(0);
  });

  it('throws on non-integer numeric fields (floats)', () => {
    expect(() => parseAnthropicUsage({ input_tokens: 1.5 })).toThrow(/integer/);
  });

  it('throws on negative numeric fields', () => {
    expect(() => parseAnthropicUsage({ output_tokens: -1 })).toThrow(/non-negative/);
  });

  it('throws on string values for numeric fields', () => {
    expect(() => parseAnthropicUsage({ input_tokens: '100' })).toThrow(/finite number/);
  });

  it('throws on NaN / Infinity', () => {
    expect(() => parseAnthropicUsage({ input_tokens: NaN })).toThrow(/finite number/);
    expect(() => parseAnthropicUsage({ input_tokens: Infinity })).toThrow(/finite number/);
  });

  it('null/undefined for optional fields are treated as absent', () => {
    const out = parseAnthropicUsage({
      input_tokens: 7,
      output_tokens: null,
      cache_read_input_tokens: undefined,
    });
    expect(out.input_tokens).toBe(7);
    expect(out.output_tokens).toBeUndefined();
    expect(out.cache_read_input_tokens).toBeUndefined();
  });

  it('ignores extra unknown fields', () => {
    const out = parseAnthropicUsage({ input_tokens: 10, some_unknown_field: 'ignored' });
    expect(out.input_tokens).toBe(10);
    expect((out as Record<string, unknown>).some_unknown_field).toBeUndefined();
  });

  it('validates nested server_tool_use.web_search_requests', () => {
    expect(() => parseAnthropicUsage({ server_tool_use: { web_search_requests: 1.5 } })).toThrow(
      /web_search_requests.*integer/,
    );
    expect(() => parseAnthropicUsage({ server_tool_use: { web_search_requests: -1 } })).toThrow(
      /web_search_requests.*non-negative/,
    );
  });

  it('throws when server_tool_use is non-object', () => {
    expect(() => parseAnthropicUsage({ server_tool_use: 'nope' })).toThrow(
      /server_tool_use must be an object/,
    );
  });

  it('accepts server_tool_use with missing web_search_requests', () => {
    const out = parseAnthropicUsage({ server_tool_use: {} });
    expect(out.server_tool_use).toEqual({ web_search_requests: undefined });
  });

  it('rejects null input entirely', () => {
    expect(() => parseAnthropicUsage(null)).toThrow(/expected object/);
  });

  it('rejects non-object input (string)', () => {
    expect(() => parseAnthropicUsage('not-an-object')).toThrow(/expected object/);
  });

  it('rejects non-object input (number)', () => {
    expect(() => parseAnthropicUsage(42)).toThrow(/expected object/);
  });
});
