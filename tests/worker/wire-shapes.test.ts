// Tests for `shared/wire-shapes.ts`.
//
// Two responsibilities in this file:
//  1. Pin `parseLoggingMessageId` shape rules (UUID 8-4-4-4-12). This is
//     the only runtime function in wire-shapes.ts; everything else is
//     compile-time-only types.
//  2. Pin `runningCostFrameToUsage` FLAT→NESTED conversion. The whole
//     point of having two shapes (frame FLAT, AnthropicUsage NESTED) is
//     ergonomics + Anthropic-format parity; the conversion helper is the
//     load-bearing seam between them.
//
// Compile-time checks for the wire shapes themselves don't go here —
// they're enforced via TypeScript at the worker/client emit + dispatch
// sites. A field rename in `ServerRunningCostFrame` produces a
// type-check failure in both `anthropic-stream.ts` (emit) and
// `chatService.ts` (consume) simultaneously, which is the whole purpose
// of the shared types.

import { describe, expect, it } from 'vitest';
import {
  parseLoggingMessageId,
  runningCostFrameToUsage,
  type ServerRunningCostFrame,
} from '../../shared/wire-shapes';

describe('parseLoggingMessageId', () => {
  describe('valid UUIDs', () => {
    it('accepts a lowercase v4 UUID', () => {
      const id = '550e8400-e29b-41d4-a716-446655440000';
      expect(parseLoggingMessageId(id)).toBe(id);
    });

    it('accepts an uppercase v4 UUID', () => {
      const id = '550E8400-E29B-41D4-A716-446655440000';
      expect(parseLoggingMessageId(id)).toBe(id);
    });

    it('accepts a mixed-case UUID (case-insensitive)', () => {
      const id = '550e8400-E29B-41d4-A716-446655440000';
      expect(parseLoggingMessageId(id)).toBe(id);
    });

    it('accepts UUIDs of any version (v1-v5) — schema column is permissive', () => {
      // v1 (time-based)
      expect(parseLoggingMessageId('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBeTruthy();
      // v3 (md5 namespace)
      expect(parseLoggingMessageId('6fa459ea-ee8a-3ca4-894e-db77e160355e')).toBeTruthy();
      // v5 (sha1 namespace)
      expect(parseLoggingMessageId('886313e1-3b8a-5372-9b90-0c9aee199e5d')).toBeTruthy();
    });
  });

  describe('invalid shapes', () => {
    it('throws on non-string input', () => {
      expect(() => parseLoggingMessageId(42)).toThrow(/must be a string/);
      expect(() => parseLoggingMessageId(null)).toThrow(/must be a string/);
      expect(() => parseLoggingMessageId(undefined)).toThrow(/must be a string/);
      expect(() => parseLoggingMessageId({})).toThrow(/must be a string/);
      expect(() => parseLoggingMessageId([])).toThrow(/must be a string/);
    });

    it('throws on empty string', () => {
      expect(() => parseLoggingMessageId('')).toThrow(/non-empty/);
    });

    it('throws on a non-UUID string (e.g. "msg_abc")', () => {
      // Historical body-validation accepted this; tightening to UUID makes
      // it a hard reject so callers can't accidentally pass row-keys that
      // would fail at the Postgres UUID-column layer.
      expect(() => parseLoggingMessageId('msg_abc')).toThrow(/must be a UUID/);
    });

    it('throws on UUID with wrong dash positions (missing dashes)', () => {
      expect(() => parseLoggingMessageId('550e8400e29b41d4a716446655440000')).toThrow(/UUID/);
    });

    it('throws on UUID with wrong segment lengths', () => {
      // 7-4-4-4-12 instead of 8-4-4-4-12
      expect(() => parseLoggingMessageId('550e840-e29b-41d4-a716-446655440000')).toThrow(/UUID/);
    });

    it('throws on UUID with non-hex characters', () => {
      expect(() => parseLoggingMessageId('550e8400-e29b-41d4-a716-44665544000z')).toThrow(/UUID/);
      expect(() => parseLoggingMessageId('550e8400-e29b-41d4-a716-44665544000g')).toThrow(/UUID/);
    });

    it('throws on UUID with leading/trailing whitespace', () => {
      // Strict: a wrapper-strip would mask a client bug that's adding the
      // whitespace; better to fail loudly so the bug surfaces.
      expect(() => parseLoggingMessageId(' 550e8400-e29b-41d4-a716-446655440000')).toThrow(/UUID/);
      expect(() => parseLoggingMessageId('550e8400-e29b-41d4-a716-446655440000 ')).toThrow(/UUID/);
    });
  });
});

describe('runningCostFrameToUsage', () => {
  const baseFrame: ServerRunningCostFrame = {
    type: 'running_cost',
    cost_usd: 0.001234,
    cost_micro_usd: '1234',
    output_tokens_est: 100,
    source: 'poll',
    input_tokens: 500,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 50,
    web_search_requests: 3,
  };

  it('moves web_search_requests from FLAT (frame) to NESTED (usage)', () => {
    // The whole point of this helper. If a future refactor unifies the
    // two shapes, this test pins the divergence we have today so the
    // refactor is an explicit choice rather than an accident.
    const usage = runningCostFrameToUsage(baseFrame);
    expect(usage.server_tool_use?.web_search_requests).toBe(3);
  });

  it('maps output_tokens_est → output_tokens', () => {
    // Frame is wire-shaped (poll-side _est) but the canonical
    // AnthropicUsage type uses plain `output_tokens`. The helper does
    // the rename, callers don't have to.
    const usage = runningCostFrameToUsage(baseFrame);
    expect(usage.output_tokens).toBe(100);
  });

  it('passes input_tokens, cache_creation, cache_read through 1:1', () => {
    const usage = runningCostFrameToUsage(baseFrame);
    expect(usage.input_tokens).toBe(500);
    expect(usage.cache_creation_input_tokens).toBe(200);
    expect(usage.cache_read_input_tokens).toBe(50);
  });

  it('produces a server_tool_use object even when web_search_requests is 0', () => {
    // Anthropic itself omits zero, but the conversion always includes
    // the field. Pinning this so downstream cost-compute sees 0 not
    // undefined — the cost path treats them equivalently (`?? 0`), but
    // consistent shape simplifies tests upstream.
    const zero = { ...baseFrame, web_search_requests: 0 };
    const usage = runningCostFrameToUsage(zero);
    expect(usage.server_tool_use).toEqual({ web_search_requests: 0 });
  });
});
