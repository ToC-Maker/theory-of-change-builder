// Discriminated union for chat content blocks. Mirrors Anthropic's wire shape
// for the subset of fields we round-trip:
//
//   - Assistant turns may include text, thinking (with signature), and
//     server-tool blocks (web_search / code_execution and their paired
//     results). Anthropic verifies signed thinking on replay; we preserve
//     the signature byte-identical.
//   - User turns are text plus optional document attachments referenced by
//     Anthropic Files API id.
//
// Lives in shared/ so both the client (localStorage persistence + ship-on-
// send) and worker (analytics capture in logging_messages.content_blocks)
// agree on the shape. No runtime validator: the only sources of these
// blocks are (a) our own SSE accumulator in chatService.ts, fully under
// our control, and (b) localStorage we wrote ourselves on a prior turn —
// also trusted. If we ever introduce an untrusted ingestion path
// (cross-device sync, import from another tool), add a parser then.

/** Plain visible text emitted by the model or supplied by the user. */
export interface TextBlock {
  type: 'text';
  text: string;
}

/**
 * Extended thinking block. Opus 4.5+ keeps prior-turn thinking blocks
 * across non-tool-result follow-ups, so we preserve them in localStorage
 * and ship them back on every send. The `signature` is Anthropic's
 * tamper-detection token over the block — must round-trip byte-identical
 * or replay 400s. Stored as a JSON string field; the client→worker→
 * Anthropic path is JSON.stringify all the way through (no Postgres
 * normalization in the user-facing path), so byte-identity holds.
 */
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/**
 * Client-side tool invocation by the model. We don't currently expose
 * client-side tools in the chat UI, but the type is here so the schema
 * doesn't have to migrate when we do (e.g. user-defined extensions).
 */
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
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
  tool_use_id: string;
  content: unknown;
}

export interface CodeExecutionToolResultBlock {
  type: 'code_execution_tool_result';
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
  | ToolUseBlock
  | ServerToolUseBlock
  | WebSearchToolResultBlock
  | CodeExecutionToolResultBlock;

export type UserBlock = TextBlock | DocumentBlock;
