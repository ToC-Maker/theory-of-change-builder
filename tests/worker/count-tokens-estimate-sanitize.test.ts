// Tests for the count_tokens payload sanitizer in
// worker/api/count-tokens-estimate.ts (PR #34 feedback #61).
//
// Background: /api/count-tokens-estimate forwards client-assembled messages
// to Anthropic's /v1/messages/count_tokens, whose validator enforces shape
// rules stricter than /v1/messages (see CLAUDE.md § count_tokens
// Assistant-Turn Validation). The handler used to collapse any resulting
// upstream 400 into a 503 ("estimation_unavailable"); the sanitizer makes
// the endpoint total over those shapes. NOTE on reachability: the CURRENT
// first-party UI does not produce these shapes (App gates rendering on
// chart data, and the chat estimate always appends the graph JSON to the
// draft text block — attach-only flows verified 200 end-to-end against the
// pre-sanitizer handler). This is endpoint-contract hardening for
// older/external clients and future UI states, documented in the
// sanitizer's own header.
//
// Empirically confirmed against the live endpoint (2026-06-11), each of
// these payload shapes returned upstream 400 with the quoted message:
//   A. payload ending in an assistant turn whose string content has
//      trailing whitespace
//      → "messages: final assistant content cannot end with trailing
//         whitespace"
//   B. user message whose content array became EMPTY after the handler
//      stripped Files-API document blocks
//      → "messages.N: user messages must have non-empty content"
//   C. document blocks + empty text block → after stripping, an
//      empty text block remains
//      → "messages: text content blocks must be non-empty"
//   D. whitespace-only string content
//      → "messages: text content blocks must contain non-whitespace text"
//   E. messages: [] → "messages: at least one message is required"
//
// Also empirically confirmed NOT to error (so the sanitizer must NOT
// repair them — dropping messages is allowed without alternation fixup):
//   - consecutive same-role messages (API auto-combines)
//   - assistant-first message lists
//   - valid signed thinking blocks under a DIFFERENT model than the one
//     being counted (cross-model estimates pass; signatures are only
//     rejected when malformed)
//
// The sanitizer mirrors the four rules of buildAssistantBlocksForCountTokens
// (worker/api/anthropic-stream.ts) at the payload level, plus the
// empty-message/empty-list rules that only arise on this endpoint.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { handler, sanitizeMessagesForCountTokens } from '../../worker/api/count-tokens-estimate';
import type { Env } from '../../worker/_shared/types';

type Msg = Record<string, unknown>;

describe('sanitizeMessagesForCountTokens', () => {
  describe('rule: final assistant content cannot end with trailing whitespace (case A)', () => {
    it('right-trims a final assistant turn with string content', () => {
      const out = sanitizeMessagesForCountTokens([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello there!\n' },
      ]) as Msg[];
      expect(out).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello there!' },
      ]);
    });

    it('right-trims the trailing text block of a final assistant content array', () => {
      const out = sanitizeMessagesForCountTokens([
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'line one\nline two  \n' }],
        },
      ]) as Msg[];
      expect(out[1].content).toEqual([{ type: 'text', text: 'line one\nline two' }]);
    });

    it('preserves trailing whitespace on NON-final assistant turns (rule is final-turn-only; keeps the count accurate)', () => {
      const out = sanitizeMessagesForCountTokens([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello there!\n' },
        { role: 'user', content: 'follow-up' },
      ]) as Msg[];
      expect(out[1].content).toBe('Hello there!\n');
    });

    it('drops a final assistant turn whose string content is whitespace-only', () => {
      const out = sanitizeMessagesForCountTokens([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '\n  \n' },
      ]) as Msg[];
      expect(out).toEqual([{ role: 'user', content: 'hi' }]);
    });
  });

  describe('rule: final block cannot be `thinking`', () => {
    it('appends a "." text block after a trailing thinking block', () => {
      const thinking = { type: 'thinking', thinking: 'hmm', signature: 'sig' };
      const out = sanitizeMessagesForCountTokens([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [thinking] },
      ]) as Msg[];
      expect(out[1].content).toEqual([thinking, { type: 'text', text: '.' }]);
    });

    it('handles a whitespace-only trailing text block exposing a thinking tail (pop, then pad)', () => {
      const thinking = { type: 'thinking', thinking: 'hmm', signature: 'sig' };
      const out = sanitizeMessagesForCountTokens([
        { role: 'user', content: 'hi' },
        // The per-block filter drops the whitespace-only text block first,
        // which exposes the thinking block as the new tail.
        { role: 'assistant', content: [thinking, { type: 'text', text: '  \n' }] },
      ]) as Msg[];
      expect(out[1].content).toEqual([thinking, { type: 'text', text: '.' }]);
    });
  });

  describe('rule: text blocks must be non-empty / non-whitespace (cases C, D)', () => {
    it('drops empty text blocks from content arrays', () => {
      const out = sanitizeMessagesForCountTokens([
        {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: 'real content' },
          ],
        },
      ]) as Msg[];
      expect(out[0].content).toEqual([{ type: 'text', text: 'real content' }]);
    });

    it('drops whitespace-only string-content messages', () => {
      const out = sanitizeMessagesForCountTokens([
        { role: 'user', content: '   ' },
        { role: 'assistant', content: 'reply' },
      ]) as Msg[];
      expect(out).toEqual([{ role: 'assistant', content: 'reply' }]);
    });

    it('splices a "." text block between thinking blocks made adjacent by the empty-text drop', () => {
      const t1 = { type: 'thinking', thinking: 'a', signature: 's1' };
      const t2 = { type: 'thinking', thinking: 'b', signature: 's2' };
      const out = sanitizeMessagesForCountTokens([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [t1, { type: 'text', text: ' ' }, t2] },
        { role: 'user', content: 'next' },
      ]) as Msg[];
      expect(out[1].content).toEqual([t1, { type: 'text', text: '.' }, t2]);
    });
  });

  describe('rule: messages must have non-empty content (case B)', () => {
    it('drops a message whose content array is empty (files-only turn after document stripping)', () => {
      const out = sanitizeMessagesForCountTokens([
        { role: 'user', content: [] },
        { role: 'assistant', content: 'reply' },
      ]) as Msg[];
      expect(out).toEqual([{ role: 'assistant', content: 'reply' }]);
    });

    it('drops a message whose content array contains only empty text blocks', () => {
      const out = sanitizeMessagesForCountTokens([
        { role: 'user', content: [{ type: 'text', text: '' }] },
        { role: 'assistant', content: 'reply' },
      ]) as Msg[];
      expect(out).toEqual([{ role: 'assistant', content: 'reply' }]);
    });

    it('drops empty-string content messages', () => {
      const out = sanitizeMessagesForCountTokens([
        { role: 'user', content: '' },
        { role: 'assistant', content: 'reply' },
      ]) as Msg[];
      expect(out).toEqual([{ role: 'assistant', content: 'reply' }]);
    });
  });

  describe('rule: at least one message is required (case E)', () => {
    it('substitutes a stub user turn when every message was dropped (system prompt still gets counted)', () => {
      const out = sanitizeMessagesForCountTokens([{ role: 'user', content: [] }]);
      expect(out).toEqual([{ role: 'user', content: '.' }]);
    });

    it('substitutes a stub user turn for an empty input list', () => {
      expect(sanitizeMessagesForCountTokens([])).toEqual([{ role: 'user', content: '.' }]);
    });
  });

  describe('pass-throughs', () => {
    it('leaves a well-formed payload byte-identical', () => {
      const msgs = [
        { role: 'user', content: 'question' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'reasoning', signature: 'sig' },
            { type: 'text', text: 'answer' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
      ];
      expect(sanitizeMessagesForCountTokens(msgs)).toEqual(msgs);
    });

    it('forwards non-array input unchanged (upstream produces the 400, surfaced with detail)', () => {
      expect(sanitizeMessagesForCountTokens('bogus')).toBe('bogus');
      expect(sanitizeMessagesForCountTokens(undefined)).toBe(undefined);
    });

    it('forwards unknown block types untouched', () => {
      const msgs = [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'url', url: 'https://x.test/a.pdf' } },
            { type: 'text', text: 'summarize' },
          ],
        },
      ];
      expect(sanitizeMessagesForCountTokens(msgs)).toEqual(msgs);
    });
  });
});

describe('handler wires the sanitizer in front of the upstream call', () => {
  const env = {
    ANTHROPIC_API_KEY: 'test-key',
    // getDb(env) is constructed (not queried) on the no-files path; any
    // syntactically valid URL satisfies it.
    DATABASE_URL: 'postgresql://user:pass@db.invalid/neondb',
  } as unknown as Env;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubUpstream(capture: { body?: Record<string, unknown> }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('api.anthropic.com/v1/messages/count_tokens')) {
          capture.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({ input_tokens: 42 });
        }
        throw new Error(`unexpected fetch in test: ${url}`);
      }),
    );
  }

  function post(body: unknown): Request {
    return new Request('https://example.test/api/count-tokens-estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 200 (not 503) for the trailing-whitespace final assistant turn, forwarding the sanitized shape', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    stubUpstream(capture);
    const res = await handler(
      post({
        model: 'claude-sonnet-4-6',
        system: [{ type: 'text', text: 'sys' }],
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'Hello!\n' },
        ],
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capture.body?.messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello!' },
    ]);
  });

  it('returns 200 for a files-only draft (document blocks stripped, empty message dropped, stub turn forwarded)', async () => {
    const capture: { body?: Record<string, unknown> } = {};
    stubUpstream(capture);
    const res = await handler(
      post({
        model: 'claude-sonnet-4-6',
        system: [{ type: 'text', text: 'sys' }],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: { type: 'file', file_id: 'file_011AbCdEfGhIjKlMnOpQrStU' },
              },
            ],
          },
        ],
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(capture.body?.messages).toEqual([{ role: 'user', content: '.' }]);
    const json = (await res.json()) as { stripped_file_blocks: number };
    expect(json.stripped_file_blocks).toBe(1);
  });
});
