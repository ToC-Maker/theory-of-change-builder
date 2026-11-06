// Pure `setMessages` updaters for rolling a refused turn out of the chat.
//
// Kept out of ChatInterface so the identity-sensitive branches are unit
// testable: the localStorage purge compares `messages` against the exact
// `emptied` array by reference, and returning `prev` / `current` unchanged is
// what lets React bail out of a no-op update.
import type { ChatMessage } from '../services/chatService';

/**
 * Chat mode: take the refused user message out of `prev`.
 *
 * - message present, others remain: the filtered list
 * - message was the only one: `emptied`, the caller's sentinel for the purge
 * - message absent (the user moved to another chart): `prev`, same reference
 */
export function rollbackRefusedMessage(
  prev: ChatMessage[],
  refusedMessageId: string,
  emptied: ChatMessage[],
): ChatMessage[] {
  const rest = prev.filter((m) => m.id !== refusedMessageId);
  if (rest.length === prev.length) return prev;
  return rest.length === 0 ? emptied : rest;
}

/**
 * Generate mode: bring back the chat the refused generation replaced, but
 * only while `current` is still exactly the refused generation prompt. Matched
 * by id, not identity: leaving the chart and coming back mid-stream reloads
 * the prompt from storage as a new object. Anything else is another chart's
 * chat and is returned untouched.
 */
export function restoreChatAfterRefusedGeneration(
  current: ChatMessage[],
  generationMessageId: string,
  restored: ChatMessage[],
): ChatMessage[] {
  return current.length === 1 && current[0]?.id === generationMessageId ? restored : current;
}
