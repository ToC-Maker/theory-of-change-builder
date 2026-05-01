// Wave 1 Critical-class behavioral gaps for the cost-cap kill discriminator
// and the empty-content fallback. The discriminator drives
// `logging_messages.was_killed`; misclassifying it would conflate cost-cap
// kills with non-cost-cap terminations (e.g. not_found_error interception)
// and silently corrupt the analytics signal that powers tier tuning.
//
// The empty-content fallback is the assistant-replay edge case where the
// previous turn was killed mid-stream before any text_delta arrived AND no
// replayable blocks survive: the helper must NOT ship a literally empty
// assistant turn (Anthropic 400s on those) — it has to flag and substitute.
import { describe, expect, it, vi } from 'vitest';
import { isCostCapKill, type KillDiagnostic } from '../worker/api/anthropic-stream';
import { buildOutgoingMessages } from '../src/services/outgoingMessages';
import type { ChatMessage } from '../src/services/chatService';

// Minimal fixture: anything KillDiagnostic-shaped works because isCostCapKill
// only inspects null vs non-null. We populate fields realistically so the test
// would still pass if a future refactor narrowed the predicate (e.g. checked
// .source !== undefined).
function mkKillDiagnostic(overrides?: Partial<KillDiagnostic>): KillDiagnostic {
  return {
    source: 'parse_frame',
    cumulative_micro_usd: '1000000',
    threshold_micro_usd: '500000',
    accumulator_at_kill: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
      web_search_requests: 0,
    },
    live_web_search_count: 0,
    fired_at_ms: 1700000000000,
    ...overrides,
  };
}

describe('isCostCapKill', () => {
  it('returns true when killDiagnostic is set by a poll-triggered kill (cost-cap path)', () => {
    // Source 'poll' is the timer-driven kill: the 5s count_tokens estimator
    // crossed the threshold and synthesized a request_cost_ceiling_exceeded
    // frame. This is a cost-cap kill — was_killed should be TRUE.
    const diag = mkKillDiagnostic({
      source: 'poll',
      output_tokens_est: 5000,
      count_tokens_total: 12000,
    });
    expect(isCostCapKill(diag)).toBe(true);
  });

  it('returns true when killDiagnostic is set by a parse_frame threshold-cross (cost-cap path)', () => {
    // Source 'parse_frame' is the in-stream kill: a message_delta carried
    // usage that pushed cumulative cost over the cap. Also a cost-cap kill.
    const diag = mkKillDiagnostic({ source: 'parse_frame' });
    expect(isCostCapKill(diag)).toBe(true);
  });

  it('returns true for the fail-closed compute_error variant (still a cost-cap kill)', () => {
    // computeCostMicroUsd throws (cost-table bug) → fail-closed: kill the
    // stream rather than silently disable the cap. The reason field flags
    // it for diagnostics, but for `was_killed` accounting it still counts as
    // a cost-cap kill — the kill switch fired, just with no cumulative figure.
    const diag = mkKillDiagnostic({
      source: 'parse_frame',
      reason: 'kill_compute_error',
      cumulative_micro_usd: '0',
      compute_error_message: 'unknown model',
    });
    expect(isCostCapKill(diag)).toBe(true);
  });

  it('returns FALSE when killDiagnostic is null even if killed.v was flipped (e.g. not_found_error)', () => {
    // The not_found_error interception path sets teeCtx.killed.v = true for
    // flow control (chart deleted mid-stream → tear the connection down) but
    // deliberately leaves killDiagnostic = null. was_killed must be FALSE
    // for that path: the column means "cost-cap kill specifically", not
    // "any termination". Conflating the two would over-count was_killed and
    // confound the cap-tuning analytics.
    expect(isCostCapKill(null)).toBe(false);
  });

  it('returns FALSE for a stream that completed cleanly (killDiagnostic stays null)', () => {
    // Natural end-of-stream: message_stop arrives, accumulator settles, no
    // kill site ever ran. killDiagnostic is null and was_killed defaults to
    // FALSE in the schema; the discriminator agrees.
    expect(isCostCapKill(null)).toBe(false);
  });

  it('semantic: ignores killed-flag-true-but-no-diagnostic shape (the load-bearing case)', () => {
    // The bug-prevention case spelled out: even if a future refactor passes
    // teeCtx.killed.v = true alongside killDiagnostic = null (e.g. a new
    // user-abort interception), this helper must still report FALSE. The
    // function signature only takes the diagnostic, so structurally there's
    // no way to be wrong — this test locks that fact in.
    expect(isCostCapKill(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Empty-content fallback: when content === '' AND content_blocks is missing
// or fully filtered, we must NOT ship `{ role: 'assistant', content: '' }` —
// Anthropic 400s on empty assistant turns. The helper substitutes a "."
// placeholder and warns. Skipping isn't safe (alternation invariant) so the
// only viable approach is flag + substitute.
// ---------------------------------------------------------------------------

const mkUser = (content: string): ChatMessage => ({
  id: 'u',
  role: 'user',
  content,
  timestamp: new Date(),
});

const mkAssistant = (overrides: Partial<ChatMessage>): ChatMessage => ({
  id: 'a',
  role: 'assistant',
  content: '',
  timestamp: new Date(),
  ...overrides,
});

describe('buildOutgoingMessages: empty-content fallback edge case', () => {
  it('refuses to emit a literally empty assistant turn when content === "" and content_blocks is absent', () => {
    // Trigger: a kill landed before any text_delta arrived AND the recorded
    // turn never carried content_blocks (e.g. older rows pre-blocks rollout,
    // or a renderer path that strips them). The naive fallback to
    // msg.content would hand Anthropic `content: ''` and 400.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages: ChatMessage[] = [
      mkUser('hi'),
      mkAssistant({ content: '' /* no content_blocks */ }),
      mkUser('next'),
    ];
    const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
    // The substitution is the load-bearing assertion: out[1] must NOT be the
    // empty-content shape Anthropic rejects.
    expect(out[1]).not.toEqual({ role: 'assistant', content: '' });
    expect(out[1]).toEqual({ role: 'assistant', content: '.' });
    // The warn is the second half of "flag" — devtools must surface this so
    // we can find lossy turns in the wild.
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toContain('empty content');
    warn.mockRestore();
  });

  it('refuses to emit a literally empty assistant turn when content_blocks filter wiped everything AND content === ""', () => {
    // Reproduces the precise Critical-class gap: a tool-only turn (no thinking
    // signature, no text yet) was killed mid-stream; content_blocks captured
    // [server_tool_use, code_execution_tool_result] which the replay filter
    // drops entirely; content stayed empty because no text_delta arrived.
    // Without the fallback substitute, out[1].content would be '' and the
    // next API call 400s.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages: ChatMessage[] = [
      mkUser('hi'),
      mkAssistant({
        content: '',
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
    expect(out[1]).not.toEqual({ role: 'assistant', content: '' });
    expect(out[1]).toEqual({ role: 'assistant', content: '.' });
    // The warn message identifies the lossy turn so we can correlate to the
    // logging_messages row by id.
    expect(warn).toHaveBeenCalled();
    const lastCall = warn.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('empty content with no replayable blocks'),
    );
    expect(lastCall).toBeDefined();
    warn.mockRestore();
  });

  it('does NOT substitute placeholder when content has text — even with empty content_blocks', () => {
    // Existing fallback for "blocks were captured but filter dropped them" +
    // visible text content keeps shipping the text. Substitution only fires
    // when there's literally nothing to send, so this regression test guards
    // against the new placeholder eating real content.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const messages: ChatMessage[] = [
      mkUser('hi'),
      mkAssistant({ content: 'visible text', content_blocks: [] }),
      mkUser('next'),
    ];
    const out = buildOutgoingMessages(messages, { attachedFileIds: [], lastIndex: 2 });
    // Still ships the user-visible text — must not be replaced by the "."
    // placeholder just because content_blocks happens to be empty.
    expect(out[1]).toEqual({ role: 'assistant', content: 'visible text' });
    warn.mockRestore();
  });
});
