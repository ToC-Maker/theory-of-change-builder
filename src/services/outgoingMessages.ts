// Assemble the `messages[]` array shipped to /api/anthropic-stream from the
// in-memory ChatMessage[] state. Separate from chatService.ts so it stays
// unit-testable without faking SSE/fetch.
import type { ChatMessage } from './chatService';
import type { AssistantBlock } from '../../shared/chat-blocks';

// When `web_search_20260209` is enabled, Anthropic auto-injects a
// `code_execution` orchestrator that batches web_searches under it.
// The SSE stream emits these as flat top-level blocks with a `caller`
// field linking nested web_searches and their results back to the
// outer code_execution. Our accumulator drops `caller` (it's not in
// AssistantBlock), so on round-trip Anthropic sees a code_execution
// tool_use, then *interleaved* web_search tool_uses + results, then a
// code_execution_tool_result — and 400s with "code_execution tool use
// was found without a corresponding code_execution_tool_result block".
//
// Server tools are response-side artifacts; Anthropic auto-strips them
// from prior assistant turns on replay anyway. Strip them here so the
// outgoing payload is structurally valid (thinking + text only). Also
// drop thinking blocks with empty signature — those are partial blocks
// from a mid-stream kill (no signature_delta arrived before abort) and
// Anthropic 400s on missing signatures during replay verification.
function isReplayableAssistantBlock(b: AssistantBlock): boolean {
  if (b.type === 'server_tool_use') return false;
  if (b.type === 'web_search_tool_result') return false;
  if (b.type === 'code_execution_tool_result') return false;
  if (b.type === 'thinking' && b.signature.length === 0) return false;
  return true;
}

interface OutgoingUserContent {
  role: 'user';
  content:
    | string
    | Array<
        | { type: 'document'; source: { type: 'file'; file_id: string } }
        | { type: 'text'; text: string }
      >;
}

interface OutgoingAssistantContent {
  role: 'assistant';
  content: string | unknown[];
}

export type OutgoingMessage = OutgoingUserContent | OutgoingAssistantContent;

export interface BuildOutgoingMessagesOptions {
  /**
   * file_ids attached to the in-flight send (the user message at lastIndex
   * of `messages`). Used in addition to that message's own attachedFileIds
   * because the composer hands them to streamMessage separately. For prior
   * user turns we read msg.attachedFileIds.
   */
  attachedFileIds: string[];
  /** Index of the message being sent (always the last index in practice). */
  lastIndex: number;
}

export function buildOutgoingMessages(
  messages: ChatMessage[],
  opts: BuildOutgoingMessagesOptions,
): OutgoingMessage[] {
  return messages.map((msg, i) => {
    if (msg.role === 'user') {
      const fileIds = i === opts.lastIndex ? opts.attachedFileIds : (msg.attachedFileIds ?? []);
      if (fileIds.length > 0) {
        const docBlocks = fileIds.map(
          (file_id) => ({ type: 'document', source: { type: 'file', file_id } }) as const,
        );
        return {
          role: 'user',
          content: [...docBlocks, { type: 'text', text: msg.content }],
        };
      }
      return { role: 'user', content: msg.content };
    }

    // Assistant turn. Prefer content_blocks when present and non-empty so
    // signed thinking round-trips back to Anthropic. Filter server-tool
    // blocks and partial (unsigned) thinking — see isReplayableAssistantBlock
    // doc above. Fall back to string content for legacy entries (no
    // content_blocks field, or filter dropped everything).
    const blocks = msg.content_blocks;
    if (blocks && blocks.length > 0) {
      const replayable = blocks.filter(isReplayableAssistantBlock);
      if (replayable.length > 0) {
        return { role: 'assistant', content: replayable };
      }
      // Filter dropped everything (e.g. turn was tool-only, killed before
      // any thinking signature arrived). Fall through to text content.
    }
    if (blocks && blocks.length === 0) {
      // Distinguishes "blocks were captured but all got dropped" from "legacy
      // turn (no content_blocks field at all)". The text fallback is correct
      // either way (Anthropic 400s on empty assistant arrays), but the empty-
      // array case means we lost signed thinking / tool pairs to the orphan
      // filter and the next turn won't include them. Worth surfacing.
      console.warn(
        '[outgoingMessages] assistant turn has empty content_blocks; falling back to text content',
        { messageId: msg.id, content: msg.content.slice(0, 100) },
      );
    }
    return { role: 'assistant', content: msg.content };
  });
}
