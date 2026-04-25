import { describe, it, expect } from 'vitest';
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

    it('keeps server_tool_use + tool_result pair intact', () => {
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
        content: [
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
      });
    });

    it('treats empty content_blocks array as legacy fallback (uses string content)', () => {
      // Defensive: a recorded turn with content_blocks=[] (e.g. all blocks
      // dropped as orphans) shouldn't ship an empty array — Anthropic 400s
      // on empty assistant content. Fall back to text.
      const messages: ChatMessage[] = [
        mkUser('hi'),
        mkAssistant({ content: 'reply text', content_blocks: [] }),
        mkUser('next'),
      ];
      const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
      expect(out[1]).toEqual({ role: 'assistant', content: 'reply text' });
    });
  });
});
