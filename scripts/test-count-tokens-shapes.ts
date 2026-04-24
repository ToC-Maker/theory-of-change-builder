#!/usr/bin/env -S npx tsx
/**
 * Probe Anthropic's count_tokens API with a matrix of assistant-message
 * shapes to discover which trailing-block patterns are accepted/rejected.
 * Informs the buildAssistantBlocksForCountTokens trailing fix.
 *
 * Usage: source .dev.vars && ./scripts/test-count-tokens-shapes.ts
 */

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error(
    'ANTHROPIC_API_KEY not set. Run: source .dev.vars && ./scripts/test-count-tokens-shapes.ts',
  );
  process.exit(1);
}

const MODEL = 'claude-opus-4-7';

async function tryCount(
  label: string,
  assistantContent: Array<Record<string, unknown>>,
): Promise<void> {
  const body = {
    model: MODEL,
    messages: [
      { role: 'user', content: 'What is 2+2?' },
      { role: 'assistant', content: assistantContent },
    ],
  };
  const resp = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (resp.ok) {
    const data = JSON.parse(text) as { input_tokens: number };
    console.log(`✅ [${resp.status}] ${label}  tokens=${data.input_tokens}`);
  } else {
    let msg = text.slice(0, 200);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed?.error?.message) msg = parsed.error.message;
    } catch {
      /* non-JSON */
    }
    console.log(`❌ [${resp.status}] ${label}  ${msg}`);
  }
}

async function fetchTwoThinkingBlocks(): Promise<Array<{ thinking: string; signature: string }>> {
  // Web-search prompts reliably produce multiple thinking blocks separated
  // by tool use — mirrors the worker's real stream shape.
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY!,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'code-execution-2025-08-25,web-search-2025-03-05',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8192,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'xhigh' },
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 2 },
        { type: 'code_execution_20250825', name: 'code_execution' },
      ],
      messages: [
        {
          role: 'user',
          content:
            'What is the current population of Iceland? Use web search, then reflect on what you found.',
        },
      ],
    }),
  });
  if (!resp.ok) {
    throw new Error(`multi-thinking probe failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as {
    content: Array<{ type: string; thinking?: string; signature?: string }>;
  };
  const blocks = data.content
    .filter((c) => c.type === 'thinking' && c.thinking && c.signature)
    .map((c) => ({ thinking: c.thinking!, signature: c.signature! }));
  if (blocks.length < 1) {
    throw new Error(`no thinking blocks: ${JSON.stringify(data).slice(0, 400)}`);
  }
  return blocks;
}

async function main() {
  console.log(`Model: ${MODEL}\n`);

  console.log('Capturing real signed thinking blocks via a tool-use turn...');
  const thinkingBlocks = await fetchTwoThinkingBlocks();
  console.log(`  captured ${thinkingBlocks.length} signed thinking blocks\n`);

  const T0 = {
    type: 'thinking',
    thinking: thinkingBlocks[0].thinking,
    signature: thinkingBlocks[0].signature,
  } as const;
  const T1 = thinkingBlocks[1]
    ? ({
        type: 'thinking',
        thinking: thinkingBlocks[1].thinking,
        signature: thinkingBlocks[1].signature,
      } as const)
    : null;

  console.log('--- single-block shapes ---');
  await tryCount('text only, clean', [{ type: 'text', text: 'Four.' }]);
  await tryCount('text only, trailing space', [{ type: 'text', text: 'Four. ' }]);
  await tryCount('text only, trailing newline', [{ type: 'text', text: 'Four.\n' }]);
  await tryCount('text only, leading space', [{ type: 'text', text: ' Four.' }]);
  await tryCount('thinking only', [T0]);
  await tryCount('text = single space', [{ type: 'text', text: ' ' }]);
  await tryCount('text = single dot', [{ type: 'text', text: '.' }]);
  await tryCount('text = empty string', [{ type: 'text', text: '' }]);

  console.log('\n--- thinking then text (our append-dot case) ---');
  await tryCount('thinking, text="."', [T0, { type: 'text', text: '.' }]);
  await tryCount('thinking, text=" "  (trailing ws)', [T0, { type: 'text', text: ' ' }]);
  await tryCount('thinking, text=""', [T0, { type: 'text', text: '' }]);
  await tryCount('thinking, text="Four."', [T0, { type: 'text', text: 'Four.' }]);
  await tryCount('thinking, text="Four. "  (trailing ws)', [T0, { type: 'text', text: 'Four. ' }]);
  await tryCount('thinking, text="Four.\\n"  (trailing newline)', [
    T0,
    { type: 'text', text: 'Four.\n' },
  ]);
  await tryCount('thinking, text = mid-stream word-boundary "I ran a "', [
    T0,
    { type: 'text', text: 'I ran a ' },
  ]);

  console.log('\n--- text ending mid-stream (partial deltas) ---');
  await tryCount('mid-stream text ending in space', [{ type: 'text', text: 'I was thinking ' }]);
  await tryCount('mid-stream text ending in newline', [
    { type: 'text', text: 'Paragraph one.\n\n' },
  ]);
  await tryCount('mid-stream text ending in tab', [{ type: 'text', text: 'Paragraph one.\t' }]);

  console.log('\n--- multiple real thinking blocks then text ---');
  if (T1) {
    await tryCount('T0, T1, text="."', [T0, T1, { type: 'text', text: '.' }]);
    await tryCount('T0, text mid, T1, text="."', [
      T0,
      { type: 'text', text: 'intermediate' },
      T1,
      { type: 'text', text: '.' },
    ]);
  } else {
    console.log('  (only 1 thinking block captured; skipping multi-thinking cases)');
  }

  console.log('\n--- text then thinking (our bad trailing-thinking case) ---');
  await tryCount('text then thinking', [{ type: 'text', text: 'Let me think.' }, T0]);
  await tryCount('text then thinking then text="."', [
    { type: 'text', text: 'Let me think.' },
    T0,
    { type: 'text', text: '.' },
  ]);

  console.log('\n--- non-ascii trailing text ---');
  await tryCount('thinking, text="…"', [T0, { type: 'text', text: '…' }]);
  await tryCount('thinking, text=";"', [T0, { type: 'text', text: ';' }]);
  await tryCount('thinking, text=" ."  (leading ws + dot)', [T0, { type: 'text', text: ' .' }]);
  await tryCount('thinking, text=". "  (dot + trailing ws)', [T0, { type: 'text', text: '. ' }]);

  console.log('\n--- server_tool_use blocks (can we include them?) ---');
  await tryCount('thinking, server_tool_use web_search, text="."', [
    T0,
    {
      type: 'server_tool_use',
      id: 'srvtoolu_test',
      name: 'web_search',
      input: { query: 'Iceland population' },
    },
    { type: 'text', text: '.' },
  ]);
  await tryCount('thinking, server_tool_use code_execution, text="."', [
    T0,
    {
      type: 'server_tool_use',
      id: 'srvtoolu_test2',
      name: 'code_execution',
      input: { code: 'print(2+2)' },
    },
    { type: 'text', text: '.' },
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
