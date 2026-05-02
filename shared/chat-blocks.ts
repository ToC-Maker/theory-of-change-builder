// Discriminated union for chat content blocks. Mirrors Anthropic's wire
// shape; the thinking `signature` must round-trip byte-identical for replay
// verification or Anthropic 400s.

/** Plain visible text emitted by the model or supplied by the user. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * Finalized extended-thinking block. `signature` is non-empty here — callers
 * can rely on that post-stream. The mid-stream variant (signature may be `''`
 * until the final `signature_delta` arrives) lives in `shared/streaming-blocks.ts`.
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/**
 * Anthropic-hosted server tool invocation (web_search, code_execution).
 * The matching `*_tool_result` block lives in the SAME assistant turn
 * (Anthropic resolves these server-side, no client tool_result needed).
 * If a kill lands between the server_tool_use and its result, we drop
 * both halves before replay — Anthropic 400s on unpaired blocks.
 */
export interface ServerToolUseBlock {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface WebSearchToolResultBlock {
  type: 'web_search_tool_result';
  // References a prior server_tool_use.id; correlation is not enforced at the type level — Anthropic guarantees it on the wire.
  tool_use_id: string;
  content: unknown;
}

export interface CodeExecutionToolResultBlock {
  type: 'code_execution_tool_result';
  // References a prior server_tool_use.id; correlation is not enforced at the type level — Anthropic guarantees it on the wire.
  tool_use_id: string;
  content: unknown;
}

/**
 * Reference to a file uploaded via Anthropic's Files API. The actual
 * file bytes live at Anthropic; we only carry the id around. Persists
 * across reload because the chart_files row stays as long as the chart.
 */
export interface DocumentBlock {
  type: 'document';
  source: { type: 'file'; file_id: string };
}

export type AssistantBlock =
  | TextBlock
  | ThinkingBlock
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | CodeExecutionToolResultBlock;

export type UserBlock = TextBlock | DocumentBlock;

/**
 * Exhaustiveness guard for discriminated-union switches over chat blocks.
 * Compile-time: residual `never` confirms every variant was handled. Runtime:
 * if Anthropic sends a new block type we haven't modeled, throw rather than
 * silently mis-route it through a fallthrough default.
 */
export function assertNeverBlock(block: never): never {
  throw new Error(`Unhandled chat block variant: ${JSON.stringify(block)}`);
}
