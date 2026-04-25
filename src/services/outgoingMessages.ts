// Assemble the `messages[]` array shipped to /api/anthropic-stream from the
// in-memory ChatMessage[] state. Separate from chatService.ts so it stays
// unit-testable without faking SSE/fetch.
import type { ChatMessage } from './chatService';

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
    // signed thinking + tool-use round-trip back to Anthropic. Fall back to
    // string content for legacy entries (no content_blocks field, or empty
    // array if all blocks were dropped as orphans).
    const blocks = msg.content_blocks;
    if (blocks && blocks.length > 0) {
      return { role: 'assistant', content: blocks };
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
