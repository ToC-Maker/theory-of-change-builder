import { describe, it, expect, vi } from 'vitest';
import { buildOutgoingMessages } from '../src/services/outgoingMessages';
import type { ChatMessage } from '../src/services/chatService';

const mkUser = (content: string, attachedFileIds?: string[]): ChatMessage => ({
  id: 'u',
  role: 'user',
  content,
  timestamp: new Date(),
  attachedFileIds,
});

const mkAssistant = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'a',
  role: 'assistant',
  content: '',
  timestamp: new Date(),
  ...overrides,
});

describe('buildOutgoingMessages', () => {
  describe('user turns', () => {
    it('passes through user text content unchanged when no files attached', () => {
      const out = buildOutgoingMessages([mkUser('hello')], { attachedFileIds: [], lastIndex: 0 });
      expect(out).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('emits document blocks before text for the last user turn (current send)', () => {
      const out = buildOutgoingMessages([mkUser('what is in this pdf?')], {
        attachedFileIds: ['file_abc'],
        lastIndex: 0,
      });
      expect(out).toEqual([
        {
          role: 'user',
          content: [
            { type: 'document', source: { type: 'file', file_id: 'file_abc' } },
            { type: 'text', text: 'what is in this pdf?' },
          ],
        },
      ]);
    });

    it('re-emits document blocks for prior user turns from their attachedFileIds', () => {
      // PDFs uploaded turn 1 must still ride along on turn 2+ so Anthropic
      // sees the document context across the whole history.
      const messages: ChatMessage[] = [
        mkUser('first turn', ['file_one']),
        mkAssistant({ content: 'reply' }),
        mkUser('follow up'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[0]).toEqual({
        role: 'user',
        content: [
          { type: 'document', source: { type: 'file', file_id: 'file_one' } },
          { type: 'text', text: 'first turn' },
        ],
      });
    });
  });

  describe('assistant turns', () => {
    it('legacy assistant message (no content_blocks) ships text-content for backward compat', () => {
      const messages: ChatMessage[] = [
        mkUser('hi'),
        mkAssistant({ content: 'hello there' }),
        mkUser('next'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({ role: 'assistant', content: 'hello there' });
    });

    it('ships content_blocks array when present (signed thinking + text)', () => {
      const messages: ChatMessage[] = [
        mkUser('hi'),
        mkAssistant({
          content: 'hello there',
          content_blocks: [
            { type: 'thinking', thinking: 'reasoning', signature: 'sig123==' },
            { type: 'text', text: 'hello there' },
          ],
        }),
        mkUser('next'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning', signature: 'sig123==' },
          { type: 'text', text: 'hello there' },
        ],
      });
    });

    it('preserves byte-identical signature through buildOutgoingMessages', () => {
      const sig = 'EuYBCkYIBxgC+/Wo3D==';
      const messages: ChatMessage[] = [
        mkUser('hi'),
        mkAssistant({
          content: 'reply',
          content_blocks: [
            { type: 'thinking', thinking: 't', signature: sig },
            { type: 'text', text: 'reply' },
          ],
        }),
        mkUser('next'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      const json = JSON.stringify(out);
      const reparsed = JSON.parse(json);
      // Signature survives serialization byte-identical.
      expect(reparsed[1].content[0].signature).toBe(sig);
    });

    it('strips server_tool_use + tool_result blocks (Anthropic strips them server-side anyway)', () => {
      // When `web_search_20260209` is enabled, Anthropic auto-injects a
      // `code_execution` orchestrator and emits nested web_searches with a
      // `caller` field. Our accumulator drops `caller`, so on round-trip the
      // structure looks like {code_exec, web_search, web_result, ...,
      // code_exec_result} flat — and Anthropic 400s on the apparent
      // unpaired code_execution. Strip server-tool blocks at the send
      // boundary so the outgoing payload is always structurally valid.
      const messages: ChatMessage[] = [
        mkUser('search for cats'),
        mkAssistant({
          content: 'found them',
          content_blocks: [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_1',
              name: 'web_search',
              input: { query: 'cats' },
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_1',
              content: [{ url: 'https://x.example' }],
            },
            { type: 'text', text: 'found them' },
          ],
        }),
        mkUser('next'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'found them' }],
      });
    });

    it('strips code_execution wrapper + nested web_searches + results, keeps thinking + text', () => {
      // Reproduces the actual production crash: killed mid-stream after a
      // code_execution batch search. The flat block sequence (code_exec,
      // web_search×N, web_result×N, code_exec_result) round-trips as an
      // apparent unpaired code_execution because we strip `caller`. After
      // filtering, only the model's visible thinking + text survives.
      const messages: ChatMessage[] = [
        mkUser('compare these studies'),
        mkAssistant({
          content: "I'll search for sources first.",
          content_blocks: [
            { type: 'thinking', thinking: 'plan the search', signature: 'sig_a==' },
            { type: 'text', text: "I'll search for sources first." },
            {
              type: 'server_tool_use',
              id: 'srvtoolu_codeexec',
              name: 'code_execution',
              input: { code: 'queries = [...]' },
            },
            {
              type: 'server_tool_use',
              id: 'srvtoolu_web1',
              name: 'web_search',
              input: { query: 'study one' },
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srvtoolu_web1',
              content: [{ url: 'https://x' }],
            },
            {
              type: 'code_execution_tool_result',
              tool_use_id: 'srvtoolu_codeexec',
              content: { type: 'code_execution_tool_result_error', error_code: 'unavailable' },
            },
          ],
        }),
        mkUser('continue'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan the search', signature: 'sig_a==' },
          { type: 'text', text: "I'll search for sources first." },
        ],
      });
    });

    it('strips thinking blocks with empty signature (partial from mid-stream kill)', () => {
      // When a kill lands inside a thinking block before any signature_delta
      // arrives, the accumulator emits {thinking: "...", signature: ""}.
      // Anthropic 400s on missing signature during replay. Drop these.
      const messages: ChatMessage[] = [
        mkUser('hi'),
        mkAssistant({
          content: 'partial reply',
          content_blocks: [
            { type: 'thinking', thinking: 'first thought', signature: 'sig_complete==' },
            { type: 'text', text: 'partial reply' },
            // Killed mid-thinking; signature never arrived.
            { type: 'thinking', thinking: 'started reasoning when', signature: '' },
          ],
        }),
        mkUser('next'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first thought', signature: 'sig_complete==' },
          { type: 'text', text: 'partial reply' },
        ],
      });
    });

    it('falls back to text content when all blocks get filtered (tool-only turn killed early)', () => {
      // Edge case: kill landed before any thinking signature, and the only
      // captured blocks were a code_execution + result pair. After filtering,
      // nothing replayable remains — fall back to the visible text content.
      const messages: ChatMessage[] = [
        mkUser('hi'),
        mkAssistant({
          content: 'visible text',
          content_blocks: [
            {
              type: 'server_tool_use',
              id: 'srvtoolu_x',
              name: 'code_execution',
              input: { code: 'x' },
            },
            {
              type: 'code_execution_tool_result',
              tool_use_id: 'srvtoolu_x',
              content: { type: 'code_execution_tool_result_error', error_code: 'unavailable' },
            },
          ],
        }),
        mkUser('next'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({ role: 'assistant', content: 'visible text' });
    });

    it('treats empty content_blocks array as legacy fallback (uses string content)', () => {
      // Defensive: a recorded turn with content_blocks=[] (e.g. all blocks
      // dropped as orphans) shouldn't ship an empty array — Anthropic 400s
      // on empty assistant content. Fall back to text.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const messages: ChatMessage[] = [
        mkUser('hi'),
        mkAssistant({ content: 'reply text', content_blocks: [] }),
        mkUser('next'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({ role: 'assistant', content: 'reply text' });
      // Empty content_blocks is distinct from missing — the latter is a legacy
      // turn, the former means the accumulator dropped everything. Warn so
      // we hear about the lossy case in devtools.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('empty content_blocks');
      warn.mockRestore();
    });

    it('does not warn when content_blocks field is absent (legacy turn)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const messages: ChatMessage[] = [
        mkUser('hi'),
        mkAssistant({ content: 'reply text' }),
        mkUser('next'),
      ];
      buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('appends "." after trailing thinking exposed by stripped server_tool_use', () => {
      // Production repro: a kill drops a trailing server_tool_use after a
      // signed thinking block. After isReplayableAssistantBlock filters the
      // tool block, thinking is the new last block — Anthropic 400s with
      // "final assistant content cannot be `thinking`". The fixup must
      // append a minimal text block so the shape stays valid on replay.
      const messages: ChatMessage[] = [
        mkUser('research this'),
        mkAssistant({
          content: '',
          content_blocks: [
            { type: 'thinking', thinking: 'plan the search', signature: 'sig_a==' },
            {
              type: 'server_tool_use',
              id: 'srvtoolu_1',
              name: 'web_search',
              input: { query: 'x' },
            },
          ],
        }),
        mkUser('continue'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'plan the search', signature: 'sig_a==' },
          { type: 'text', text: '.' },
        ],
      });
    });

    it('inserts "." between adjacent thinking blocks orphaned by stripped server_tool_use', () => {
      // Two signed thinkings with a server_tool_use between them: filtering
      // the tool block makes the thinkings adjacent, which Anthropic rejects
      // ("thinking blocks must remain as they were in the original response").
      // Intersperse a minimal text block to keep the shape valid.
      const messages: ChatMessage[] = [
        mkUser('hi'),
        mkAssistant({
          content: 'final answer',
          content_blocks: [
            { type: 'thinking', thinking: 'first', signature: 'sig_1==' },
            {
              type: 'server_tool_use',
              id: 'srvtoolu_1',
              name: 'web_search',
              input: { query: 'x' },
            },
            { type: 'thinking', thinking: 'second', signature: 'sig_2==' },
            { type: 'text', text: 'final answer' },
          ],
        }),
        mkUser('next'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'first', signature: 'sig_1==' },
          { type: 'text', text: '.' },
          { type: 'thinking', thinking: 'second', signature: 'sig_2==' },
          { type: 'text', text: 'final answer' },
        ],
      });
    });

    it('trims trailing whitespace from the last text block', () => {
      // A half-streamed text block ending at a word boundary often has a
      // trailing space/newline. Anthropic rejects "final text block ends
      // with whitespace" on the assistant turn going IN.
      const messages: ChatMessage[] = [
        mkUser('hi'),
        mkAssistant({
          content: 'reply  ',
          content_blocks: [
            { type: 'thinking', thinking: 't', signature: 'sig==' },
            { type: 'text', text: 'reply  \n' },
          ],
        }),
        mkUser('next'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 't', signature: 'sig==' },
          { type: 'text', text: 'reply' },
        ],
      });
    });

    it('drops whitespace-only text blocks during fixup', () => {
      // Empty/whitespace-only text blocks fail Anthropic's non-empty
      // validation. Drop them entirely; the surrounding blocks stand.
      const messages: ChatMessage[] = [
        mkUser('hi'),
        mkAssistant({
          content: 'real answer',
          content_blocks: [
            { type: 'text', text: '   ' },
            { type: 'text', text: 'real answer' },
          ],
        }),
        mkUser('next'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'real answer' }],
      });
    });
  });
});
