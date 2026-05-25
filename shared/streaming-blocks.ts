// Discriminated union for blocks accumulated from Anthropic's SSE stream
// mid-flight. Two consumers — the worker's per-block accumulator in
// `worker/api/anthropic-stream.ts` (kill-switch / reconcile / analytics)
// and the client's `StreamBlockAccumulator` in
// `src/services/streamBlockAccumulator.ts` — each previously hand-copied
// this union; consolidating here keeps them in lockstep.
//
// Distinct from `shared/chat-blocks.ts`, which models the *finalized*
// shape that round-trips through localStorage and back to Anthropic. The
// streaming variant carries extra fidelity needed during accumulation:
//   - `server_tool_use.input_json_raw` holds the partial JSON streamed
//     via `input_json_delta` events; the parsed `input` is filled at
//     `content_block_stop` (or stays null on parse failure).
//   - `text` and `thinking` carry partial strings that grow with each
//     delta; `thinking` also concatenates `signature_delta` chunks raw
//     (base64-ASCII, must round-trip byte-identical for replay).
//
// Used by two paths in the worker with different fidelity requirements:
//   - `buildAssistantBlocksForCountTokens` (kill-switch / reconcile):
//     only `text`, `thinking`, and `server_tool_use` are submitted to
//     Anthropic's count_tokens endpoint. The two `*_tool_result` types
//     are captured but skipped on that path (Anthropic doesn't accept
//     them on the assistant turn going IN to count_tokens — they're a
//     response artifact).
//   - `collectAssistantBlocksForAnalytics`: emits all five types verbatim
//     into `logging_messages.content_blocks` so analytics can fork/replay
//     the turn via the Messages API, where these blocks are valid history.

export type StreamingBlock =
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

// Indexed by SSE `index` so out-of-order arrival is preserved by Map's
// insertion order until the consumer re-sorts numerically on flush.
export type StreamingBlocksMap = Map<number, StreamingBlock>;
