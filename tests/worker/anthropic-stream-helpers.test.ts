import { describe, expect, it } from 'vitest';
import { stripToCountTokensBody, extractDocumentFileIds } from '../../worker/api/anthropic-stream';

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
