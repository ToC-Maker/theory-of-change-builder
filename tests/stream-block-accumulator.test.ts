import { describe, it, expect, vi } from 'vitest';
import {
  StreamBlockAccumulator,
  toAssistantContentBlocks,
} from '../src/services/streamBlockAccumulator';

describe('StreamBlockAccumulator', () => {
  describe('text blocks', () => {
    it('builds a single text block from start + text_deltas + stop', () => {
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello ' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'world' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      expect(toAssistantContentBlocks(acc)).toEqual([{ type: 'text', text: 'Hello world' }]);
    });
  });

  describe('thinking blocks', () => {
    it('captures signature_delta concatenation across multiple deltas', () => {
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me think...' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'abc' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'def==' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      expect(toAssistantContentBlocks(acc)).toEqual([
        { type: 'thinking', thinking: 'Let me think...', signature: 'abcdef==' },
      ]);
    });

    it('preserves base64 signature byte-identical (no normalization)', () => {
      // Anthropic signatures are base64-ASCII. The accumulator must not mutate
      // them — they verify byte-identical on replay or count_tokens 400s.
      const acc = new StreamBlockAccumulator();
      const sig = 'EuYBCkYIBxgCKkAW3+kY...3D=='; // realistic base64-with-padding shape
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 't' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: sig },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      const blocks = toAssistantContentBlocks(acc);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({ type: 'thinking', thinking: 't', signature: sig });
    });

    it('round-trips through JSON.stringify/parse byte-identical', () => {
      const acc = new StreamBlockAccumulator();
      const sig = 'EuYBCkYIBxgC+/=='; // base64 chars including +, /, =
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'reasoning' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: sig },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      const blocks = toAssistantContentBlocks(acc);
      const roundTripped = JSON.parse(JSON.stringify(blocks));
      expect(roundTripped).toEqual(blocks);
      expect(roundTripped[0].signature).toBe(sig);
    });
  });

  describe('server_tool_use + tool_result pairs', () => {
    it('accumulates input_json_delta and parses into input on stop', () => {
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'cats"}' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      // Anthropic always pairs each server_tool_use with its tool_result —
      // unpaired blocks 400 on replay, so the accumulator drops them. Include
      // the matching result to verify capture.
      acc.handleEvent({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [],
        },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 1 });
      expect(toAssistantContentBlocks(acc)).toEqual([
        {
          type: 'server_tool_use',
          id: 'srvtoolu_1',
          name: 'web_search',
          input: { query: 'cats' },
        },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [],
        },
      ]);
    });

    it('uses empty object input when partial_json is empty', () => {
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_x', name: 'code_execution' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      acc.handleEvent({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'code_execution_tool_result',
          tool_use_id: 'srvtoolu_x',
          content: { stdout: '' },
        },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 1 });
      const blocks = toAssistantContentBlocks(acc);
      expect(blocks).toContainEqual({
        type: 'server_tool_use',
        id: 'srvtoolu_x',
        name: 'code_execution',
        input: {},
      });
    });

    it('drops the block on malformed input_json (graceful degradation)', () => {
      // Malformed JSON would 400 if shipped back to Anthropic. We drop the
      // block rather than disable the entire turn — better to be missing
      // one tool_use than to fail the whole replay.
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_b', name: 'web_search' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{not json' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      acc.handleEvent({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_b',
          content: [],
        },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 1 });
      // server_tool_use is dropped (malformed JSON); the now-orphan
      // tool_result is dropped too because its pair vanished.
      expect(toAssistantContentBlocks(acc)).toEqual([]);
    });

    it('captures web_search_tool_result content on content_block_start (whole-block payload)', () => {
      const acc = new StreamBlockAccumulator();
      const resultContent = [
        { type: 'web_search_result', url: 'https://example.com', title: 'Ex' },
      ];
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      acc.handleEvent({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: resultContent,
        },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 1 });
      const blocks = toAssistantContentBlocks(acc);
      expect(blocks).toContainEqual({
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: resultContent,
      });
    });

    it('captures code_execution_tool_result analogously', () => {
      const acc = new StreamBlockAccumulator();
      const resultContent = { type: 'code_execution_result', stdout: 'hi\n' };
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_x', name: 'code_execution' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      acc.handleEvent({
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'code_execution_tool_result',
          tool_use_id: 'srvtoolu_x',
          content: resultContent,
        },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 1 });
      const blocks = toAssistantContentBlocks(acc);
      expect(blocks).toContainEqual({
        type: 'code_execution_tool_result',
        tool_use_id: 'srvtoolu_x',
        content: resultContent,
      });
    });
  });

  describe('ordering', () => {
    it('emits blocks ordered by SSE index, not by start order', () => {
      // Anthropic's index field defines ordering; we should rely on it.
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text' } });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'second' },
      });
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'first' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      acc.handleEvent({ type: 'content_block_stop', index: 1 });
      expect(toAssistantContentBlocks(acc)).toEqual([
        { type: 'thinking', thinking: 'first', signature: 'sig' },
        { type: 'text', text: 'second' },
      ]);
    });
  });

  describe('partial / killed streams', () => {
    it('drops orphaned server_tool_use when its result never arrived (kill mid-tool)', () => {
      // Anthropic 400s on unpaired server_tool_use blocks. A stream killed
      // between server_tool_use and its tool_result must drop the orphan
      // before replay.
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"x"}' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      // No matching web_search_tool_result; kill happens here.
      const blocks = toAssistantContentBlocks(acc);
      expect(blocks).toEqual([]);
    });

    it('drops orphaned tool_result with no preceding server_tool_use (defensive)', () => {
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_unknown',
          content: [],
        },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      expect(toAssistantContentBlocks(acc)).toEqual([]);
    });

    it('keeps text/thinking blocks even when an unmatched tool_use is dropped', () => {
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'partial' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      acc.handleEvent({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 1 });
      // No matching result: tool_use dropped, text kept.
      expect(toAssistantContentBlocks(acc)).toEqual([{ type: 'text', text: 'partial' }]);
    });

    it('surfaces a still-streaming text block that never received block_stop', () => {
      // When the stream is killed mid-text-block, content_block_stop never
      // arrives but we still want the partial text on disk.
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'half' },
      });
      // No block_stop.
      expect(toAssistantContentBlocks(acc)).toEqual([{ type: 'text', text: 'half' }]);
    });
  });

  describe('robustness', () => {
    it('ignores unknown delta types without crashing', () => {
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'unknown_delta', foo: 1 },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ok' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      expect(toAssistantContentBlocks(acc)).toEqual([{ type: 'text', text: 'ok' }]);
    });

    it('ignores unknown block types', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'futuristic_block_we_dont_know_about' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      expect(toAssistantContentBlocks(acc)).toEqual([]);
      // Surfaces the unknown type so a future Anthropic block we don't model
      // doesn't disappear silently.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][1]).toEqual({ type: 'futuristic_block_we_dont_know_about' });
      warn.mockRestore();
    });

    it('only warns once per unknown block type per accumulator', () => {
      // Streams sometimes contain dozens of the same novel block kind in a
      // burst; we don't want to fill devtools with the same line.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const acc = new StreamBlockAccumulator();
      for (let i = 0; i < 5; i++) {
        acc.handleEvent({
          type: 'content_block_start',
          index: i,
          content_block: { type: 'novel_block' },
        });
      }
      // Different unknown type should warn separately.
      acc.handleEvent({
        type: 'content_block_start',
        index: 99,
        content_block: { type: 'another_novel_block' },
      });
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('warns when server_tool_use input_json fails to parse', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srvtoolu_b', name: 'web_search' },
      });
      acc.handleEvent({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{not json' },
      });
      acc.handleEvent({ type: 'content_block_stop', index: 0 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('failed to parse server_tool_use input_json');
      warn.mockRestore();
    });

    it('ignores deltas for indices we never opened', () => {
      const acc = new StreamBlockAccumulator();
      acc.handleEvent({
        type: 'content_block_delta',
        index: 99,
        delta: { type: 'text_delta', text: 'orphan' },
      });
      expect(toAssistantContentBlocks(acc)).toEqual([]);
    });
  });
});
