#!/usr/bin/env -S npx tsx
/**
 * Manual probe: end-to-end signed-thinking resume round-trip.
 *
 * Streams a real /v1/messages turn, JSON.stringify → JSON.parse the captured
 * AssistantBlock[] (mirrors the client's localStorage hop between turns),
 * then POSTs a follow-up shaped as
 *   [user_first, assistant_with_signed_thinking, user_followup]
 * and asserts Anthropic returns 200. Touches the same code paths as
 * src/services/streamBlockAccumulator.ts (client) and
 * collectAssistantBlocksForAnalytics in worker/api/anthropic-stream.ts (which
 * writes the TEXT `content_blocks` column on logging_messages).
 *
 * Run before merging changes to any of those files, or to the chat-history
 * localStorage layer.
 *
 * Why not in CI:
 *   - Real Anthropic call (~$0.02-0.05 of Opus 4.7 per run); CI secrets
 *     shouldn't fund every PR.
 *   - Stochastic: the model may elide thinking. Exit code 2 means "rerun";
 *     not a real failure.
 *
 * Usage:
 *   source .dev.vars && ./scripts/test-resume-roundtrip.ts
 *   ANTHROPIC_API_KEY=sk-ant-... ./scripts/test-resume-roundtrip.ts
 *
 * Exit codes:
 *   0  — round-trip succeeded
 *   1  — ANTHROPIC_API_KEY not set
 *   2  — first turn produced no thinking blocks (rerun)
 *   3  — block type changed during JSON round-trip
 *   4  — thinking signature differed after round-trip (replay would 400)
 *   5  — Anthropic rejected the replay (4xx)
 *  99  — uncaught throw
 */

import type { AssistantBlock } from '../shared/chat-blocks';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error(
    'ANTHROPIC_API_KEY not set. Run: source .dev.vars && ./scripts/test-resume-roundtrip.ts',
  );
  process.exit(1);
}

const MODEL = 'claude-opus-4-7';
const ANTHROPIC_VERSION = '2023-06-01';
// Mirror worker/api/anthropic-stream.ts: only files-api beta is sent. Adaptive
// thinking on Opus 4.7 doesn't require a separate beta header.
const ANTHROPIC_BETA = 'files-api-2025-04-14';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

// Thinking-eliciting prompt: a logic puzzle with multiple constraints that
// resists pattern-matching, so adaptive thinking reliably engages. If the
// model elides thinking on a given run, exit with code 2 and rerun (stochastic
// miss, not a real failure).
const FIRST_USER_PROMPT =
  'Five people (A, B, C, D, E) sit in a row. A is not at either end. B is two seats to the left of E. C is somewhere to the right of B. D is adjacent to A. Where does each person sit? Show your reasoning.';
const FOLLOWUP_USER_PROMPT = 'Now swap the positions of A and B. What is the new seating order?';

// --- Internal accumulator (mirrors src/services/streamBlockAccumulator.ts) ---
//
// Duplicated here rather than imported because the client accumulator lives
// under src/, which is browser-targeted (DOM lib, no @types/node). Pulling it
// into a Node tsx script would require a third tsconfig include path. The
// shape is small enough that re-implementing inline is cheaper than that
// plumbing, and we cross-check against the real type via the AssistantBlock
// import below.

interface RawSseEvent {
  type: string;
  index?: number;
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
}

type InternalBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | {
      type: 'server_tool_use';
      id: string;
      name: string;
      input_json_raw: string;
      input: Record<string, unknown> | null;
    }
  | {
      type: 'web_search_tool_result';
      tool_use_id: string;
      content: unknown;
    }
  | {
      type: 'code_execution_tool_result';
      tool_use_id: string;
      content: unknown;
    };

class StreamBlockAccumulator {
  private readonly blocks = new Map<number, InternalBlock>();

  handleEvent(event: RawSseEvent): void {
    const idx = typeof event.index === 'number' ? event.index : -1;
    if (event.type === 'content_block_start') {
      const cb = event.content_block;
      if (idx < 0 || !cb || typeof cb !== 'object') return;
      const cbType = cb.type;
      if (cbType === 'text') {
        this.blocks.set(idx, { type: 'text', text: '' });
      } else if (cbType === 'thinking') {
        this.blocks.set(idx, { type: 'thinking', thinking: '', signature: '' });
      } else if (cbType === 'server_tool_use') {
        const id = typeof cb.id === 'string' ? cb.id : '';
        const name = typeof cb.name === 'string' ? cb.name : '';
        this.blocks.set(idx, {
          type: 'server_tool_use',
          id,
          name,
          input_json_raw: '',
          input: null,
        });
      } else if (cbType === 'web_search_tool_result') {
        const tool_use_id = typeof cb.tool_use_id === 'string' ? cb.tool_use_id : '';
        this.blocks.set(idx, {
          type: 'web_search_tool_result',
          tool_use_id,
          content: cb.content,
        });
      } else if (cbType === 'code_execution_tool_result') {
        const tool_use_id = typeof cb.tool_use_id === 'string' ? cb.tool_use_id : '';
        this.blocks.set(idx, {
          type: 'code_execution_tool_result',
          tool_use_id,
          content: cb.content,
        });
      }
      return;
    }

    if (event.type === 'content_block_delta') {
      const d = event.delta;
      if (idx < 0 || !d || typeof d !== 'object') return;
      const existing = this.blocks.get(idx);
      if (!existing) return;
      const dtype = d.type;
      if (dtype === 'text_delta' && existing.type === 'text' && typeof d.text === 'string') {
        existing.text += d.text;
      } else if (
        dtype === 'thinking_delta' &&
        existing.type === 'thinking' &&
        typeof d.thinking === 'string'
      ) {
        existing.thinking += d.thinking;
      } else if (
        dtype === 'signature_delta' &&
        existing.type === 'thinking' &&
        typeof d.signature === 'string'
      ) {
        // Concatenate raw — Anthropic signatures are base64-ASCII and must
        // round-trip byte-identical for replay verification.
        existing.signature += d.signature;
      } else if (
        dtype === 'input_json_delta' &&
        existing.type === 'server_tool_use' &&
        typeof d.partial_json === 'string'
      ) {
        existing.input_json_raw += d.partial_json;
      }
      return;
    }

    if (event.type === 'content_block_stop') {
      if (idx < 0) return;
      const existing = this.blocks.get(idx);
      if (!existing) return;
      if (existing.type === 'server_tool_use' && existing.input === null) {
        const raw = existing.input_json_raw;
        try {
          const parsed = JSON.parse(raw.length === 0 ? '{}' : raw) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            existing.input = parsed as Record<string, unknown>;
          }
        } catch {
          // Malformed JSON: input stays null; emit-time drop.
        }
      }
      return;
    }
  }

  toAssistantBlocks(): AssistantBlock[] {
    const sorted = Array.from(this.blocks.entries()).sort(([a], [b]) => a - b);

    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const [, block] of sorted) {
      if (block.type === 'server_tool_use' && block.input !== null) {
        toolUseIds.add(block.id);
      } else if (
        block.type === 'web_search_tool_result' ||
        block.type === 'code_execution_tool_result'
      ) {
        toolResultIds.add(block.tool_use_id);
      }
    }

    const out: AssistantBlock[] = [];
    for (const [, block] of sorted) {
      if (block.type === 'text') {
        if (block.text.length > 0) {
          out.push({ type: 'text', text: block.text });
        }
      } else if (block.type === 'thinking') {
        if (block.thinking.length > 0 || block.signature.length > 0) {
          out.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
        }
      } else if (block.type === 'server_tool_use') {
        if (block.input === null) continue;
        if (!toolResultIds.has(block.id)) continue;
        out.push({
          type: 'server_tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });
      } else if (block.type === 'web_search_tool_result') {
        if (!toolUseIds.has(block.tool_use_id)) continue;
        out.push({
          type: 'web_search_tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
        });
      } else if (block.type === 'code_execution_tool_result') {
        if (!toolUseIds.has(block.tool_use_id)) continue;
        out.push({
          type: 'code_execution_tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
        });
      }
    }
    return out;
  }
}

// --- Step 1: stream the first turn and capture blocks --------------------

async function streamFirstTurn(): Promise<AssistantBlock[]> {
  const body = {
    model: MODEL,
    max_tokens: 4096,
    // Match production: adaptive thinking with summarized display + xhigh
    // effort so the model actually engages thinking on the probe's prompt
    // (adaptive without effort is conservative and frequently no-ops).
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'xhigh' },
    messages: [{ role: 'user', content: FIRST_USER_PROMPT }],
    stream: true,
  };

  const resp = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY!,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorBody = await resp.text().catch(() => '');
    throw new Error(`first-turn stream failed: ${resp.status} ${resp.statusText}\n${errorBody}`);
  }

  if (!resp.body) {
    throw new Error('first-turn stream had no body');
  }

  const accumulator = new StreamBlockAccumulator();
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim() || line.startsWith(':')) continue;
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      let event: RawSseEvent;
      try {
        event = JSON.parse(data) as RawSseEvent;
      } catch {
        continue;
      }
      if (
        event.type === 'content_block_start' ||
        event.type === 'content_block_delta' ||
        event.type === 'content_block_stop'
      ) {
        accumulator.handleEvent(event);
      }
    }
  }

  return accumulator.toAssistantBlocks();
}

// --- Step 3: JSON round-trip --------------------------------------------

function jsonRoundTrip(blocks: AssistantBlock[]): AssistantBlock[] {
  return JSON.parse(JSON.stringify(blocks)) as AssistantBlock[];
}

// --- Step 5: replay turn (non-streaming) --------------------------------

async function postReplayTurn(priorBlocks: AssistantBlock[]): Promise<Response> {
  const body = {
    model: MODEL,
    max_tokens: 1024,
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: 'xhigh' },
    messages: [
      { role: 'user', content: FIRST_USER_PROMPT },
      { role: 'assistant', content: priorBlocks },
      { role: 'user', content: FOLLOWUP_USER_PROMPT },
    ],
    // Non-streaming: simpler to inspect status + body. The bug we're hunting
    // surfaces at request-validation time (Anthropic 400 on signature
    // mismatch), not in the streaming response shape.
    stream: false,
  };

  return fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY!,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-beta': ANTHROPIC_BETA,
    },
    body: JSON.stringify(body),
  });
}

// --- Main ----------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Model: ${MODEL}\n`);

  console.log('1/3 Streaming first turn with adaptive thinking enabled...');
  const blocks = await streamFirstTurn();
  console.log(`  Captured ${blocks.length} block(s): ${blocks.map((b) => b.type).join(', ')}`);

  const thinkingBlocks = blocks.filter((b) => b.type === 'thinking');
  if (thinkingBlocks.length === 0) {
    console.error(
      "  No thinking blocks captured. The model didn't engage thinking on this run.\n" +
        '  This is a stochastic miss, not a round-trip failure. Rerun the probe.',
    );
    process.exit(2);
  }
  const signedCount = thinkingBlocks.filter((b) => b.signature.length > 0).length;
  console.log(`  Of which ${thinkingBlocks.length} are thinking, ${signedCount} carry a signature`);
  if (signedCount === 0) {
    console.error('  No SIGNED thinking blocks captured — adaptive may have gone unsigned.');
    process.exit(2);
  }

  console.log('\n2/3 JSON round-tripping blocks (simulates localStorage)...');
  const roundTripped = jsonRoundTrip(blocks);

  for (const [i, block] of blocks.entries()) {
    const rt = roundTripped[i];
    if (rt.type !== block.type) {
      console.error(`  Block ${i} type changed during round-trip: ${block.type} → ${rt.type}`);
      process.exit(3);
    }
    if (block.type === 'thinking' && rt.type === 'thinking') {
      if (rt.signature !== block.signature) {
        console.error(`  Block ${i} signature differs after round-trip`);
        console.error(`    original len:    ${block.signature.length}`);
        console.error(`    round-trip len:  ${rt.signature.length}`);
        console.error(`    original head:   ${block.signature.slice(0, 60)}...`);
        console.error(`    round-trip head: ${rt.signature.slice(0, 60)}...`);
        process.exit(4);
      }
      if (rt.thinking !== block.thinking) {
        console.error(`  Block ${i} thinking text differs after round-trip`);
        process.exit(4);
      }
    }
  }
  console.log(`  All ${signedCount} thinking signature(s) byte-identical after round-trip`);

  console.log('\n3/3 Replaying via Anthropic API...');
  const replayResp = await postReplayTurn(roundTripped);
  if (!replayResp.ok) {
    const body = await replayResp.text();
    console.error(`  Replay failed: ${replayResp.status} ${replayResp.statusText}`);
    console.error(`  Body: ${body.slice(0, 500)}`);
    process.exit(5);
  }
  const json = (await replayResp.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const firstText = (json.content ?? []).find((c) => c.type === 'text' && c.text)?.text ?? '';
  console.log(`  Replay accepted (${replayResp.status}).`);
  console.log(`  First text: ${JSON.stringify(firstText.slice(0, 100))}...`);
  if (json.usage) {
    console.log(
      `  Usage: input=${json.usage.input_tokens ?? '?'} output=${json.usage.output_tokens ?? '?'}`,
    );
  }

  console.log('\nPASS');
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(99);
});
