/**
 * Wire-format shapes for client ↔ Worker contracts.
 *
 * These types pin shapes that cross the network boundary so client and
 * worker can't silently drift. Compile-checked: any field rename here
 * fails type-check on both sides simultaneously, instead of producing a
 * runtime "field undefined" that the loose `any`-typed dispatch path
 * would silently swallow.
 *
 * Conventions:
 *  - All µUSD values are STRINGS on the wire (BigInt preservation;
 *    BigInt cannot be JSON-stringified directly, and Number loses
 *    precision past 2^53). Parse with `BigInt(s)` on receive.
 *  - UUID-shaped IDs are validated at server entry (see
 *    `parseLoggingMessageId` below). Symmetric with the existing
 *    `isUuidish` check on `x-idempotency-key` in
 *    `worker/api/anthropic-stream.ts`.
 *
 * Cross-references:
 *  - `worker/api/anthropic-stream.ts` emits `running_cost` frames at two
 *    sites (kill-switch poll and message_start/message_delta handler).
 *  - `src/services/chatService.ts` consumes them in the SSE dispatch.
 *  - `worker/api/reconcile-cost.ts` parses `ReconcileCostRequest` bodies.
 *  - `src/services/chatCostTracker.ts` builds those bodies.
 */

import type { AnthropicUsage } from './cost';

/**
 * SSE running_cost frame shape. Emitted by `worker/api/anthropic-stream.ts`
 * (search for `event: running_cost`); consumed by `src/services/chatService.ts`
 * (search for `event.type === 'running_cost'`).
 *
 * CAUTION: `web_search_requests` is FLAT at the top level here. The
 * `AnthropicUsage` shape (from `shared/cost.ts`) keeps it NESTED under
 * `server_tool_use` to match Anthropic's wire format. The divergence is
 * deliberate: `running_cost` is OUR wire shape, optimized for the pill
 * display path which needs the count directly without nested access.
 * If you wire `running_cost` through code that expects `AnthropicUsage`,
 * convert via `runningCostFrameToUsage(frame)` below.
 */
export interface ServerRunningCostFrame {
  readonly type: 'running_cost';
  /** Float USD, kept for the legacy fallback log line + UI hint. */
  readonly cost_usd: number;
  /** Authoritative µUSD (BigInt serialized as string for precision). */
  readonly cost_micro_usd: string;
  /** Live output-token count (poll-estimate or message-delta authoritative). */
  readonly output_tokens_est: number;
  /** Origin of the frame: 'poll' | 'message_start' | 'message_delta'. */
  readonly source: 'poll' | 'message_start' | 'message_delta';
  readonly input_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
  /** FLAT — see CAUTION above. Nested under server_tool_use in AnthropicUsage. */
  readonly web_search_requests: number;
}

/**
 * Reverse the FLAT→NESTED conversion for code paths that expect the
 * canonical AnthropicUsage shape (e.g. recordUsage). Defensive against
 * one-side-only renames: if `web_search_requests` ever moves under
 * `server_tool_use` in the frame, this helper is the one-line fix.
 */
export function runningCostFrameToUsage(frame: ServerRunningCostFrame): AnthropicUsage {
  return {
    input_tokens: frame.input_tokens,
    output_tokens: frame.output_tokens_est,
    cache_creation_input_tokens: frame.cache_creation_input_tokens,
    cache_read_input_tokens: frame.cache_read_input_tokens,
    server_tool_use: { web_search_requests: frame.web_search_requests },
  };
}

/**
 * `/api/reconcile-cost` request body. Client sends; worker parses.
 *
 * `cost_micro_usd` is REQUIRED to be a string on the wire. The previous
 * contract accepted `string | number` defensively, but the client always
 * sends string (see `chatCostTracker.ts::maybePostReconcile`), and
 * accepting number masked client-side type drift. Server-side validator
 * (`parseReconcileBody`) now rejects non-string with a 400.
 */
export interface ReconcileCostRequest {
  /** UUID — must match `parseLoggingMessageId` on the server. */
  readonly logging_message_id: string;
  /** µUSD as string (BigInt preservation). */
  readonly cost_micro_usd: string;
}

/**
 * SSE event types emitted by the worker stream, parsed by the client.
 *
 * Approach: tightly narrow the events the worker uniquely controls
 * (`running_cost`, mid-stream synthesized errors). For Anthropic
 * pass-through events (`content_block_start`, `content_block_delta`,
 * `message_start`, etc.), use a permissive shape that carries the
 * required `type` discriminator plus the few fields the dispatch reads.
 * Full enumeration of Anthropic's content-block subtype matrix is out of
 * scope for this wire-shape pinning; the goal is to catch field renames
 * on OUR side of the contract, not to mirror Anthropic's spec verbatim
 * (it already has its own SDK types).
 *
 * The `unknown` index signature on each pass-through variant ensures any
 * unread field a future Anthropic update introduces doesn't fail
 * type-check at the dispatch.
 */
export type StreamEvent =
  /** OUR wire shape — tightly typed so a rename here fails the consumer. */
  | ServerRunningCostFrame
  /** OUR synthesized mid-stream error frames (cost ceiling, chart deleted, etc.). */
  | { readonly type: 'request_cost_ceiling_exceeded'; readonly limit_usd?: number }
  | { readonly type: 'chart_deleted'; readonly chart_id?: string }
  | { readonly type: 'file_unavailable'; readonly file_id?: string }
  /** Anthropic pass-through: message_start carries the initial usage snapshot. */
  | {
      readonly type: 'message_start';
      readonly message?: { readonly usage?: AnthropicUsage; readonly model?: string };
    }
  /** Anthropic pass-through: message_delta carries the final usage on stop. */
  | {
      readonly type: 'message_delta';
      readonly usage?: AnthropicUsage;
      readonly delta?: Record<string, unknown>;
    }
  /** Anthropic pass-through: content_block_start opens a block (text, thinking, tool_use, etc.). */
  | {
      readonly type: 'content_block_start';
      readonly index?: number;
      readonly content_block?: Record<string, unknown>;
    }
  /** Anthropic pass-through: content_block_delta carries text/thinking/json chunks. */
  | {
      readonly type: 'content_block_delta';
      readonly index?: number;
      readonly delta?: Record<string, unknown>;
    }
  /** Anthropic pass-through: content_block_stop closes a block. */
  | { readonly type: 'content_block_stop'; readonly index?: number }
  /** Anthropic pass-through: message_stop signals end-of-turn. */
  | { readonly type: 'message_stop' }
  /** Anthropic pass-through: ping (keepalive). */
  | { readonly type: 'ping' }
  /** Anthropic pass-through: error frames (upstream Anthropic-side errors). */
  | { readonly type: 'error'; readonly error?: Record<string, unknown> };

/**
 * Validate a UUID-shaped string for `logging_message_id`.
 *
 * Accepts the canonical 8-4-4-4-12 hex format, case-insensitive. Does NOT
 * require v4 specifically; the `idempotency_keys` and `logging_messages`
 * schemas both use Postgres UUID columns which accept v1-v5 alike, so
 * staying permissive on version matches what the DB layer will accept.
 *
 * Symmetric with `isUuidish` in `worker/api/anthropic-stream.ts` (used
 * for `x-idempotency-key`); keeping the two validators in lockstep means
 * a future schema tightening (e.g. v4-only) updates one regex.
 *
 * Returns the validated string. Throws on shape mismatch with a message
 * the caller can map to a 400 body.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLoggingMessageId(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('logging_message_id must be a string');
  }
  if (raw.length === 0) {
    throw new Error('logging_message_id must be a non-empty string');
  }
  if (!UUID_RE.test(raw)) {
    throw new Error('logging_message_id must be a UUID (8-4-4-4-12 hex)');
  }
  return raw;
}
