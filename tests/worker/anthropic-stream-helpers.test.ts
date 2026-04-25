import { describe, expect, it } from 'vitest';
import {
  stripToCountTokensBody,
  extractDocumentFileIds,
  collectAssistantBlocksForAnalytics,
  buildAssistantBlocksForCountTokens,
} from '../../worker/api/anthropic-stream';

// Minimal helper: the function under test only reads
// `teeCtx.streamingContent.blocks`, so we hand-build that one path and cast
// via `Parameters<typeof ...>[0]`. This keeps the test free of the (unexported)
// full `SseTeeContext` shape without poking holes elsewhere.
type AnyBlock = Record<string, unknown> & { type: string };
function makeTeeCtx(
  blocks: Map<number, AnyBlock>,
): Parameters<typeof buildAssistantBlocksForCountTokens>[0] {
  return { streamingContent: { blocks, webSearchCount: 0 } } as unknown as Parameters<
    typeof buildAssistantBlocksForCountTokens
  >[0];
}

describe('stripToCountTokensBody', () => {
  it('passes through model + messages untouched', () => {
    const body = {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(stripToCountTokensBody(body)).toEqual(body);
  });

  it('strips non-allow-list top-level fields (max_tokens, metadata, stream)', () => {
    const body = {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 1024,
      stream: true,
      metadata: { user_id: 'anon-x' },
    };
    const out = stripToCountTokensBody(body);
    expect(out).toEqual({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(out.max_tokens).toBeUndefined();
    expect(out.stream).toBeUndefined();
    expect(out.metadata).toBeUndefined();
  });

  it('preserves system, tool_choice, thinking, output_config', () => {
    const body = {
      model: 'claude-opus-4-7',
      messages: [],
      system: 'You are a helper.',
      tool_choice: { type: 'auto' },
      thinking: { type: 'enabled', budget_tokens: 1000 },
      output_config: { format: 'json' },
    };
    const out = stripToCountTokensBody(body);
    expect(out.system).toBe('You are a helper.');
    expect(out.tool_choice).toEqual({ type: 'auto' });
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 1000 });
    expect(out.output_config).toEqual({ format: 'json' });
  });

  it('preserves user-defined function tools', () => {
    const body = {
      model: 'claude-opus-4-7',
      messages: [],
      tools: [{ name: 'my_tool', description: 'does a thing', input_schema: {} }],
    };
    const out = stripToCountTokensBody(body);
    expect(out.tools).toEqual([{ name: 'my_tool', description: 'does a thing', input_schema: {} }]);
  });

  it('strips server tools (web_search_* / code_execution_*)', () => {
    const body = {
      model: 'claude-opus-4-7',
      messages: [],
      tools: [
        { type: 'web_search_20250305', name: 'web_search' },
        { type: 'code_execution_20250825', name: 'code_execution' },
        { name: 'keep_me', input_schema: {} },
      ],
    };
    const out = stripToCountTokensBody(body);
    expect(out.tools).toEqual([{ name: 'keep_me', input_schema: {} }]);
  });

  it('deletes tools key entirely when all tools are server tools', () => {
    const body = {
      model: 'claude-opus-4-7',
      messages: [],
      tools: [{ type: 'web_search_20250305' }],
    };
    const out = stripToCountTokensBody(body);
    expect('tools' in out).toBe(false);
  });

  it('deep-strips cache_control from nested content blocks', () => {
    const body = {
      model: 'claude-opus-4-7',
      system: [{ type: 'text', text: 'ctx', cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: 'no marker' },
          ],
        },
      ],
    };
    const out = stripToCountTokensBody(body);
    const sys = out.system as Array<Record<string, unknown>>;
    expect(sys[0].cache_control).toBeUndefined();
    expect(sys[0].text).toBe('ctx');
    const msgs = out.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs[0].content[0].cache_control).toBeUndefined();
    expect(msgs[0].content[0].text).toBe('hi');
    expect(msgs[0].content[1].cache_control).toBeUndefined();
  });

  it('strips document blocks with source.type = file but keeps base64 document blocks', () => {
    const body = {
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see attached' },
            { type: 'document', source: { type: 'file', file_id: 'file_abc123' } },
            {
              type: 'document',
              source: { type: 'base64', data: 'AAAA', media_type: 'application/pdf' },
            },
          ],
        },
      ],
    };
    const out = stripToCountTokensBody(body);
    const msgs = out.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs[0].content).toHaveLength(2);
    expect(msgs[0].content[0]).toEqual({ type: 'text', text: 'see attached' });
    expect(msgs[0].content[1]).toMatchObject({ type: 'document' });
    expect((msgs[0].content[1].source as Record<string, unknown>).type).toBe('base64');
  });

  it('leaves messages with non-array content untouched', () => {
    const body = {
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'string not array' }],
    };
    const out = stripToCountTokensBody(body);
    expect(out.messages).toEqual([{ role: 'user', content: 'string not array' }]);
  });
});

describe('extractDocumentFileIds', () => {
  it('returns [] when messages is absent', () => {
    expect(extractDocumentFileIds({})).toEqual([]);
  });

  it('returns [] when messages is not an array', () => {
    expect(extractDocumentFileIds({ messages: 'nope' })).toEqual([]);
  });

  it('returns [] when there are no document blocks', () => {
    expect(
      extractDocumentFileIds({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      }),
    ).toEqual([]);
  });

  it('extracts a single file_id from a document/file source', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'document', source: { type: 'file', file_id: 'file_abc123' } }],
        },
      ],
    };
    expect(extractDocumentFileIds(body)).toEqual(['file_abc123']);
  });

  it('extracts multiple file_ids preserving order', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'document', source: { type: 'file', file_id: 'file_1' } },
            { type: 'document', source: { type: 'file', file_id: 'file_2' } },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'document', source: { type: 'file', file_id: 'file_3' } }],
        },
      ],
    };
    expect(extractDocumentFileIds(body)).toEqual(['file_1', 'file_2', 'file_3']);
  });

  it('does NOT include base64 document sources', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', data: 'AAAA' } },
            { type: 'document', source: { type: 'file', file_id: 'file_only' } },
          ],
        },
      ],
    };
    expect(extractDocumentFileIds(body)).toEqual(['file_only']);
  });

  it('ignores non-document blocks (text, tool_use, tool_result, image)', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image', source: { type: 'base64', data: 'AAAA' } },
            { type: 'tool_use', id: 'tu_1', name: 'x', input: {} },
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
            { type: 'document', source: { type: 'file', file_id: 'file_mixed' } },
          ],
        },
      ],
    };
    expect(extractDocumentFileIds(body)).toEqual(['file_mixed']);
  });

  it('silently skips malformed document blocks (missing source, missing file_id)', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'document' }, // no source
            { type: 'document', source: { type: 'file' } }, // no file_id
            { type: 'document', source: { type: 'file', file_id: 42 } }, // non-string file_id
            { type: 'document', source: { type: 'file', file_id: 'file_good' } },
          ],
        },
      ],
    };
    expect(extractDocumentFileIds(body)).toEqual(['file_good']);
  });

  it('skips messages with non-array content', () => {
    const body = {
      messages: [
        { role: 'user', content: 'just a string' },
        {
          role: 'user',
          content: [{ type: 'document', source: { type: 'file', file_id: 'file_x' } }],
        },
      ],
    };
    expect(extractDocumentFileIds(body)).toEqual(['file_x']);
  });
});

describe('collectAssistantBlocksForAnalytics', () => {
  it('returns [] for an empty blocks map', () => {
    expect(collectAssistantBlocksForAnalytics(new Map())).toEqual([]);
  });

  it('emits text blocks verbatim with no trimming or padding', () => {
    const blocks = new Map();
    // Trailing whitespace and leading whitespace must be preserved — the
    // analytics path stores raw bytes, unlike the count_tokens path which
    // strips trailing whitespace to satisfy Anthropic validation.
    blocks.set(0, { type: 'text', text: '  hello world\n' });
    expect(collectAssistantBlocksForAnalytics(blocks)).toEqual([
      { type: 'text', text: '  hello world\n' },
    ]);
  });

  it('preserves whitespace-only text blocks (no smoothing)', () => {
    const blocks = new Map();
    blocks.set(0, { type: 'text', text: '   ' });
    expect(collectAssistantBlocksForAnalytics(blocks)).toEqual([{ type: 'text', text: '   ' }]);
  });

  it('emits thinking blocks with their signature byte-identical', () => {
    const blocks = new Map();
    blocks.set(0, {
      type: 'thinking',
      text: 'let me reason about this',
      signature: 'sig-abc-DEF/123+xyz==',
    });
    expect(collectAssistantBlocksForAnalytics(blocks)).toEqual([
      {
        type: 'thinking',
        thinking: 'let me reason about this',
        signature: 'sig-abc-DEF/123+xyz==',
      },
    ]);
  });

  it('preserves block ordering by SSE index', () => {
    const blocks = new Map();
    // Insert out-of-order to verify sort by numeric index.
    blocks.set(2, { type: 'text', text: 'third' });
    blocks.set(0, { type: 'thinking', text: 'first', signature: 'sig0' });
    blocks.set(1, { type: 'text', text: 'second' });
    const out = collectAssistantBlocksForAnalytics(blocks);
    expect(out).toEqual([
      { type: 'thinking', thinking: 'first', signature: 'sig0' },
      { type: 'text', text: 'second' },
      { type: 'text', text: 'third' },
    ]);
  });

  it('emits server_tool_use with parsed input when input is non-null', () => {
    const blocks = new Map();
    blocks.set(0, {
      type: 'server_tool_use',
      id: 'srvtoolu_1',
      name: 'web_search',
      input_json_raw: '{"query":"hello"}',
      input: { query: 'hello' },
    });
    expect(collectAssistantBlocksForAnalytics(blocks)).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'web_search',
        input: { query: 'hello' },
      },
    ]);
  });

  it('emits server_tool_use with empty input object when input is null (graceful)', () => {
    // If parsing failed mid-stream the input field stays null. For analytics
    // we still want the block visible (so the assistant turn shape round-
    // trips for replay) — emit with an empty input object rather than
    // dropping the block entirely.
    const blocks = new Map();
    blocks.set(0, {
      type: 'server_tool_use',
      id: 'srvtoolu_1',
      name: 'web_search',
      input_json_raw: '',
      input: null,
    });
    expect(collectAssistantBlocksForAnalytics(blocks)).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'web_search',
        input: {},
      },
    ]);
  });

  it('emits web_search_tool_result blocks with content unchanged', () => {
    const blocks = new Map();
    blocks.set(0, {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [
        {
          type: 'web_search_result',
          url: 'https://example.com',
          title: 'Example',
          page_age: '2 days ago',
        },
      ],
    });
    expect(collectAssistantBlocksForAnalytics(blocks)).toEqual([
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: [
          {
            type: 'web_search_result',
            url: 'https://example.com',
            title: 'Example',
            page_age: '2 days ago',
          },
        ],
      },
    ]);
  });

  it('emits code_execution_tool_result blocks with content unchanged', () => {
    const blocks = new Map();
    blocks.set(0, {
      type: 'code_execution_tool_result',
      tool_use_id: 'srvtoolu_2',
      content: { type: 'code_execution_result', stdout: 'hello\n', stderr: '', return_code: 0 },
    });
    expect(collectAssistantBlocksForAnalytics(blocks)).toEqual([
      {
        type: 'code_execution_tool_result',
        tool_use_id: 'srvtoolu_2',
        content: { type: 'code_execution_result', stdout: 'hello\n', stderr: '', return_code: 0 },
      },
    ]);
  });

  it('drops empty text and unsigned thinking blocks (no analytics value, signature-required for replay)', () => {
    // An empty text block (zero-length) means the SSE block_start fired but
    // no text_delta arrived before the kill / abort — nothing useful to
    // store. An unsigned thinking block (no signature_delta seen) cannot
    // be replayed via the Anthropic API so it's a dead artifact too.
    const blocks = new Map();
    blocks.set(0, { type: 'text', text: '' });
    blocks.set(1, { type: 'thinking', text: 'partial', signature: '' });
    blocks.set(2, { type: 'text', text: 'real text' });
    expect(collectAssistantBlocksForAnalytics(blocks)).toEqual([
      { type: 'text', text: 'real text' },
    ]);
  });

  it('returns full discriminated union shape mixed in one turn', () => {
    const blocks = new Map();
    blocks.set(0, { type: 'thinking', text: 'thinking out loud', signature: 'sig-x' });
    blocks.set(1, {
      type: 'server_tool_use',
      id: 'srvtoolu_1',
      name: 'web_search',
      input_json_raw: '{"query":"q"}',
      input: { query: 'q' },
    });
    blocks.set(2, {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [{ type: 'web_search_result', url: 'https://a', title: 'A' }],
    });
    blocks.set(3, { type: 'text', text: 'final answer' });
    const out = collectAssistantBlocksForAnalytics(blocks);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ type: 'thinking', thinking: 'thinking out loud', signature: 'sig-x' });
    expect(out[1]).toEqual({
      type: 'server_tool_use',
      id: 'srvtoolu_1',
      name: 'web_search',
      input: { query: 'q' },
    });
    expect(out[2]).toEqual({
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [{ type: 'web_search_result', url: 'https://a', title: 'A' }],
    });
    expect(out[3]).toEqual({ type: 'text', text: 'final answer' });
  });
});

describe('buildAssistantBlocksForCountTokens', () => {
  it('returns [] for an empty blocks map', () => {
    const ctx = makeTeeCtx(new Map());
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([]);
  });

  it('passes through a single text block unchanged', () => {
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, { type: 'text', text: 'hello world' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([
      { type: 'text', text: 'hello world' },
    ]);
  });

  it('appends a "." text block after a trailing thinking block (rule 1)', () => {
    // Rule 1 (final block can't be thinking) is satisfied by APPENDING a
    // single-period text block, not by dropping the thinking block — the
    // thinking is the expensive output we want counted.
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, { type: 'thinking', text: 'reasoning', signature: 'sig-1' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([
      { type: 'thinking', thinking: 'reasoning', signature: 'sig-1' },
      { type: 'text', text: '.' },
    ]);
  });

  it('keeps a non-trailing thinking block when followed by a text block', () => {
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, { type: 'thinking', text: 'reasoning', signature: 'sig-1' });
    blocks.set(1, { type: 'text', text: 'final answer' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([
      { type: 'thinking', thinking: 'reasoning', signature: 'sig-1' },
      { type: 'text', text: 'final answer' },
    ]);
  });

  it('right-trims trailing whitespace on the final text block (rule 2)', () => {
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, { type: 'text', text: 'hello world   \n' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([
      { type: 'text', text: 'hello world' },
    ]);
  });

  it('only trims the LAST text block; earlier text blocks keep their trailing whitespace', () => {
    // count_tokens is fine with whitespace in the middle of an assistant
    // turn — the validation it 400s on is "final block ends in whitespace".
    // Trimming everywhere would also be wrong because it would mutate the
    // exact bytes the analytics path stores (reader: the same blocks map is
    // observed by both paths during reconcile).
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, { type: 'text', text: 'first   \n' });
    blocks.set(1, { type: 'text', text: 'second\t' });
    blocks.set(2, { type: 'text', text: 'last  ' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([
      { type: 'text', text: 'first   \n' },
      { type: 'text', text: 'second\t' },
      { type: 'text', text: 'last' },
    ]);
  });

  it('drops empty text blocks (zero length and whitespace-only) (rule 4)', () => {
    // Both `''` and `'   '` are skipped: count_tokens rejects "must contain
    // non-whitespace" so even a pure-whitespace block is invalid input.
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, { type: 'text', text: '' });
    blocks.set(1, { type: 'text', text: 'real text' });
    blocks.set(2, { type: 'text', text: '   ' });
    blocks.set(3, { type: 'text', text: 'more text' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([
      { type: 'text', text: 'real text' },
      { type: 'text', text: 'more text' },
    ]);
  });

  it('inserts a "." text block between adjacent thinking blocks (rule 3)', () => {
    // The model never emits two thinking blocks back-to-back natively, but if
    // an intermediate text block was empty (and therefore dropped above) we'd
    // produce an invalid shape. Splice rather than drop so the cost of the
    // second thinking turn is still counted.
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, { type: 'thinking', text: 'first thought', signature: 'sig-a' });
    blocks.set(1, { type: 'text', text: '' }); // dropped, leaving adjacent thinkings
    blocks.set(2, { type: 'thinking', text: 'second thought', signature: 'sig-b' });
    blocks.set(3, { type: 'text', text: 'final' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([
      { type: 'thinking', thinking: 'first thought', signature: 'sig-a' },
      { type: 'text', text: '.' },
      { type: 'thinking', thinking: 'second thought', signature: 'sig-b' },
      { type: 'text', text: 'final' },
    ]);
  });

  it('drops thinking with empty text', () => {
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, { type: 'thinking', text: '', signature: 'sig-only' });
    blocks.set(1, { type: 'text', text: 'real' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([{ type: 'text', text: 'real' }]);
  });

  it('drops incomplete thinking with no signature (kill mid-thinking)', () => {
    // When the kill fires before signature_delta arrives, the thinking block
    // is unsigned. Anthropic 400s on submitting such a block, so it must be
    // dropped — silently disabling the poll otherwise.
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, { type: 'thinking', text: 'partial reasoning', signature: '' });
    blocks.set(1, { type: 'text', text: 'final' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([{ type: 'text', text: 'final' }]);
  });

  it('drops server_tool_use with unparsed input (input === null)', () => {
    // Mid-stream kill or malformed partial JSON leaves `input` null. We can't
    // serialize a tool_use block with `input: null` to count_tokens, so drop.
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, {
      type: 'server_tool_use',
      id: 'srvtoolu_1',
      name: 'web_search',
      input_json_raw: '{"que',
      input: null,
    });
    blocks.set(1, { type: 'text', text: 'fallback text' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([
      { type: 'text', text: 'fallback text' },
    ]);
  });

  it('keeps server_tool_use with parsed input', () => {
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, {
      type: 'server_tool_use',
      id: 'srvtoolu_1',
      name: 'web_search',
      input_json_raw: '{"query":"hi"}',
      input: { query: 'hi' },
    });
    const ctx = makeTeeCtx(blocks);
    // server_tool_use is allowed at the tail (verified via count_tokens probe
    // 2026-04-24) so no terminator is appended.
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'web_search',
        input: { query: 'hi' },
      },
    ]);
  });

  it('skips web_search_tool_result and code_execution_tool_result entirely', () => {
    // count_tokens rejects tool result blocks on the assistant turn going IN
    // (they're a response artifact). Analytics keeps them; this path drops.
    const blocks = new Map<number, AnyBlock>();
    blocks.set(0, {
      type: 'server_tool_use',
      id: 'srvtoolu_1',
      name: 'web_search',
      input_json_raw: '{"query":"q"}',
      input: { query: 'q' },
    });
    blocks.set(1, {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [{ type: 'web_search_result', url: 'https://a', title: 'A' }],
    });
    blocks.set(2, {
      type: 'code_execution_tool_result',
      tool_use_id: 'srvtoolu_2',
      content: { type: 'code_execution_result', stdout: 'ok\n', stderr: '', return_code: 0 },
    });
    blocks.set(3, { type: 'text', text: 'after' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'web_search',
        input: { query: 'q' },
      },
      { type: 'text', text: 'after' },
    ]);
  });

  it('preserves block ordering by SSE index when entries arrive out-of-order', () => {
    const blocks = new Map<number, AnyBlock>();
    blocks.set(2, { type: 'text', text: 'third' });
    blocks.set(0, { type: 'thinking', text: 'first', signature: 'sig0' });
    blocks.set(1, { type: 'text', text: 'second' });
    const ctx = makeTeeCtx(blocks);
    expect(buildAssistantBlocksForCountTokens(ctx)).toEqual([
      { type: 'thinking', thinking: 'first', signature: 'sig0' },
      { type: 'text', text: 'second' },
      { type: 'text', text: 'third' },
    ]);
  });
});
