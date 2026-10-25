// Pure-function tests for the refusal rollback updaters used by ChatInterface.
//
// The identity of the returned arrays is part of the contract: the history
// save effect purges localStorage only when `messages` is exactly the
// `emptied` sentinel, and returning the input unchanged is what lets React
// skip a no-op update.
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../src/services/chatService';
import {
  rollbackRefusedMessage,
  restoreChatAfterRefusedGeneration,
} from '../../src/utils/refusalRollback';

const msg = (id: string, role: ChatMessage['role'] = 'user'): ChatMessage => ({
  id,
  role,
  content: `content of ${id}`,
  timestamp: new Date('2026-10-25T12:00:00Z'),
});

describe('rollbackRefusedMessage (chat mode)', () => {
  it('returns the filtered list when the refused message is present and others remain', () => {
    const earlier = [msg('u1'), msg('a1', 'assistant')];
    const prev = [...earlier, msg('refused')];
    const emptied: ChatMessage[] = [];

    const next = rollbackRefusedMessage(prev, 'refused', emptied);

    expect(next).toEqual(earlier);
    expect(next).not.toBe(emptied);
    // The input is not mutated.
    expect(prev).toHaveLength(3);
  });

  it('returns the emptied sentinel, by identity, when the refused message was the only one', () => {
    const emptied: ChatMessage[] = [];

    const next = rollbackRefusedMessage([msg('refused')], 'refused', emptied);

    expect(next).toBe(emptied);
  });

  it('returns prev, by identity, when the refused message is absent (user moved to another chart)', () => {
    const prev = [msg('other-chart-1'), msg('other-chart-2', 'assistant')];
    const emptied: ChatMessage[] = [];

    expect(rollbackRefusedMessage(prev, 'refused', emptied)).toBe(prev);
  });

  it('returns prev, not the sentinel, when another chart has an empty chat', () => {
    const prev: ChatMessage[] = [];
    const emptied: ChatMessage[] = [];

    expect(rollbackRefusedMessage(prev, 'refused', emptied)).toBe(prev);
  });
});

describe('restoreChatAfterRefusedGeneration (Generate mode)', () => {
  const restored = [msg('prior-1'), msg('prior-2', 'assistant')];

  it('returns the restored snapshot while the chat is exactly the refused generation message', () => {
    expect(restoreChatAfterRefusedGeneration([msg('gen')], 'gen', restored)).toBe(restored);
  });

  it('matches by id, not identity: a prompt reloaded from storage as a new object still matches', () => {
    const original = msg('gen');
    const reloaded = JSON.parse(JSON.stringify(original)) as ChatMessage;
    expect(reloaded).not.toBe(original);

    expect(restoreChatAfterRefusedGeneration([reloaded], 'gen', restored)).toBe(restored);
  });

  it('returns current, by identity, when the single message is a different one', () => {
    const current = [msg('other-chart')];
    expect(restoreChatAfterRefusedGeneration(current, 'gen', restored)).toBe(current);
  });

  it('returns current, by identity, when the chat has more than the generation message', () => {
    const current = [msg('gen'), msg('a1', 'assistant')];
    expect(restoreChatAfterRefusedGeneration(current, 'gen', restored)).toBe(current);
  });

  it('returns current, by identity, when the chat is empty', () => {
    const current: ChatMessage[] = [];
    expect(restoreChatAfterRefusedGeneration(current, 'gen', restored)).toBe(current);
  });
});
