// Assemble the `messages[]` array shipped to /api/anthropic-stream from the
// in-memory ChatMessage[] state. Lives separately from chatService.ts so the
// shape rule (assistant turns ship content_blocks; user turns ship text +
// optional document blocks) is unit-testable without faking SSE/fetch.
//
// The contract enforced here:
//   - User turns with attachedFileIds emit `[document..., text]` content
//     arrays on every replay (not just the turn the file was uploaded);
//     otherwise Anthropic only sees the PDF on turn 1.
//   - Assistant turns with content_blocks ship `[blocks...]`. Without
//     content_blocks (legacy localStorage entries), fall back to plain
//     string content so old chats keep working through reload.
//   - Empty content_blocks arrays are treated as legacy fallback because
//     Anthropic 400s on empty assistant content.
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
  // Either a plain string (legacy, pre-content-blocks turns) or the typed
  // AssistantBlock[] array (signed thinking + text + paired tool blocks).
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
