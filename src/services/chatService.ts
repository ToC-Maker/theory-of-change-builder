import { type EditInstruction, parseEditInstructions, cleanResponseContent } from '../utils/graphEdits';
import systemPromptContent from '../prompts/systemPrompt.md?raw';
import chatModePromptContent from '../prompts/chatModePrompt.md?raw';
import generateModePromptContent from '../prompts/generateModePrompt.md?raw';
import { addNodePaths } from '../utils/addNodePaths';
import { loggingService } from './loggingService';
import {
  MODEL_INPUT_RATES_USD_PER_MTOK,
  MODEL_OUTPUT_RATES_USD_PER_MTOK,
  WEB_SEARCH_USD_PER_USE,
} from '../utils/cost';
import { MODEL_CAPABILITIES } from '../../shared/pricing';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  /**
   * Anthropic Files-API `file_id`s attached to this specific turn. Kept on
   * the message (not just in composer state) so follow-up turns re-emit
   * document content blocks for the full history — otherwise Anthropic
   * only sees the PDF on the turn it was uploaded, not subsequent ones.
   */
  attachedFileIds?: string[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    // Cache + tool-use fields are optional so older messages (and messages
    // from streams that didn't report cache hits) still typecheck. They
    // let the per-message display surface the actual billed breakdown,
    // not just the tiny "uncached input" number.
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    web_search_requests?: number;
    cost_usd?: number;
  };
}

interface StreamingMetadata {
  streaming: {
    phase: string;
    durationMs: number;
    ttfbMs: number | null;
    timeSinceLastChunkMs: number;
    chunkCount: number;
    bytesReceived: number;
    payloadSizeBytes: number;
    protocol: string | null;
    network: { effectiveType: string; rtt: number; downlink: number } | null;
    retryAttempt: number;
  };
  // Index signature lets callers spread metadata into a Record<string, unknown>
  // context (loggingService request_metadata) without a cast.
  [key: string]: unknown;
}

/**
 * Cost/policy errors surfaced by the worker (U9). These are hard errors that
 * must NOT be retried; callers render different prompts for each.
 * Also includes mid-stream synthesized error events (request_cost_ceiling_exceeded,
 * chart_deleted, file_unavailable) which arrive as SSE `type` fields rather than
 * HTTP status codes, but share the same callback channel for UI simplicity.
 */
export type CostErrorType =
  | 'lifetime_cap_reached'
  | 'global_budget_exhausted'
  | 'turnstile_required'
  | 'turnstile_failed'
  | 'invalid_token'
  | 'idempotent_replay'
  | 'body_too_large'
  | 'database_unavailable'
  | 'estimation_unavailable'
  | 'authentication_service_unavailable'
  | 'request_cost_ceiling_exceeded'
  | 'chart_deleted'
  | 'file_unavailable';

export interface CostError {
  type: CostErrorType;
  /** Raw error payload (HTTP JSON body, or SSE event object). Shape varies by type. */
  data: unknown;
}

/**
 * Internal marker so the outer catch can distinguish cost errors (which should
 * exit without retry or generic onError) from transport errors. Using a symbol
 * property keeps the tag type-safe without `as any` casts at every site.
 */
const COST_ERROR_TAG: unique symbol = Symbol('chatService.isCostError');
interface TaggedError extends Error {
  [COST_ERROR_TAG]?: true;
}
function markAsCostError(err: Error): TaggedError {
  (err as TaggedError)[COST_ERROR_TAG] = true;
  return err as TaggedError;
}
function isCostError(err: unknown): err is TaggedError {
  return err instanceof Error && (err as TaggedError)[COST_ERROR_TAG] === true;
}

/** Fresh idempotency key; uses crypto.randomUUID when available, else a timestamp+random fallback. */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface StreamCallbacks {
  onContent?: (chunk: string, fullContent: string) => void;
  /**
   * Fires on each `thinking_delta` within a `thinking` content block so the
   * client can show the model's reasoning alongside the streamed reply.
   * Arguments mirror onContent: the incremental chunk plus the running
   * accumulation for convenience.
   */
  onThinking?: (chunk: string, fullThinking: string) => void;
  onComplete?: (
    message: string,
    editInstructions?: EditInstruction[],
    usage?: any,
    /** Raw pre-cleaned reply (before cleanResponseContent strips
     *  [EDIT_INSTRUCTIONS] / [CURRENT_GRAPH_DATA] / [SELECTED_NODES]).
     *  Use this for logging so the audit trail captures exactly what
     *  the model produced, including cases where cleaning empties the
     *  displayed `message`. */
    rawMessage?: string,
  ) => void;
  onError?: (error: string) => void;
  onSearchStart?: () => void;
  onSearchComplete?: (results?: any[]) => void;
  /** Fires on each `message_delta.usage` SSE event with the running USD estimate. */
  onCostUpdate?: (runningCostUsd: number) => void;
  /**
   * Fires for cost/policy errors (HTTP 401/402/409/413/429/503 with known shapes,
   * and mid-stream synthesized error events). Does NOT fall through to the
   * generic `onError` handler or the H3->H2 retry path.
   */
  onCostError?: (error: CostError) => void;
}

/**
 * Options for streamMessage. Single options-object instead of long positional
 * list — simpler to evolve, and callers (ChatInterface) can import and share
 * this type rather than tracking argument order.
 *
 * turnstileToken is NOT listed: Turnstile is cookie-based after the first
 * verification; the browser auto-sends `tocb_anon` and the Worker reads it.
 *
 * userAnthropicKey is kept in the interface for completeness but is normally
 * undefined — the Worker loads stored BYOK keys from `user_byok_keys` server-side.
 */
export type StreamMessageOptions = {
  messages: ChatMessage[];
  currentGraphData: unknown;
  mode: 'chat' | 'generate';
  callbacks?: StreamCallbacks;
  signal?: AbortSignal;
  model?: string;
  webSearchEnabled?: boolean;
  customSystemPrompt?: string;
  highlightedNodes?: Set<string> | string[];
  extendedThinkingEnabled?: boolean;
  attachedFileIds?: string[];
  idempotencyKey?: string;
  userAnthropicKey?: string;
  chartId?: string;
  loggingMessageId?: string;
};

/** HTTP status + error.type combinations that map to a CostError and skip retry/fallthrough. */
const COST_ERROR_MAP: Record<number, CostErrorType[]> = {
  401: ['turnstile_required', 'turnstile_failed', 'invalid_token', 'authentication_service_unavailable'],
  402: ['global_budget_exhausted'],
  409: ['idempotent_replay'],
  413: ['body_too_large'],
  429: ['lifetime_cap_reached'],
  503: ['database_unavailable', 'estimation_unavailable'],
};

/** Mid-stream synthesized error event type -> CostErrorType. */
const MID_STREAM_ERROR_TYPES: Record<string, CostErrorType> = {
  request_cost_ceiling_exceeded: 'request_cost_ceiling_exceeded',
  chart_deleted: 'chart_deleted',
  file_unavailable: 'file_unavailable',
};

/**
 * Captures timing, protocol, and network metadata during an SSE streaming
 * request. On error, toMetadata() is merged into the loggingService error
 * report to diagnose transport-layer failures (e.g., QUIC disconnects,
 * slow TTFB, protocol issues).
 *
 * Lifecycle: constructed before fetch → markHeadersReceived() after response
 * headers → markChunkReceived() per chunk → markComplete() on message_stop.
 */
class StreamingContext {
  phase: 'connecting' | 'headers_received' | 'streaming' | 'complete' | 'error' = 'connecting';
  readonly startTime: number;
  ttfbTime: number | null = null;
  lastChunkTime: number;
  chunkCount = 0;
  bytesReceived = 0;
  retryAttempt = 0;
  readonly payloadSizeBytes: number;
  private requestUrl: string;
  // Network Information API (Chromium-only): captures connection quality
  // to correlate failures with poor connectivity. Returns null in Firefox/Safari.
  readonly networkInfo: { effectiveType: string; rtt: number; downlink: number } | null = null;

  constructor(payloadSizeBytes: number, requestUrl: string) {
    this.payloadSizeBytes = payloadSizeBytes;
    this.requestUrl = requestUrl;
    this.startTime = performance.now();
    this.lastChunkTime = this.startTime;
    try {
      if ('connection' in navigator) {
        const conn = (navigator as any).connection;
        if (conn) {
          this.networkInfo = {
            effectiveType: conn.effectiveType ?? 'unknown',
            rtt: conn.rtt ?? 0,
            downlink: conn.downlink ?? 0,
          };
        }
      }
    } catch { /* network info unavailable */ }
  }

  markHeadersReceived(): void {
    this.phase = 'headers_received';
    this.ttfbTime = performance.now();
  }

  markChunkReceived(bytes: number): void {
    this.phase = 'streaming';
    this.chunkCount++;
    this.bytesReceived += bytes;
    this.lastChunkTime = performance.now();
  }

  markComplete(): void {
    this.phase = 'complete';
  }

  markError(): void {
    this.phase = 'error';
  }

  // Resource Timing API: nextHopProtocol reveals h2/h3/h1.1, useful for
  // diagnosing transport-layer failures. Resolved lazily since the entry
  // may not be finalized until the stream completes.
  private resolveProtocol(): string | null {
    try {
      const resolved = new URL(this.requestUrl, location.origin).href;
      const entries = performance.getEntriesByName(resolved, 'resource') as PerformanceResourceTiming[];
      if (entries.length > 0) {
        const last = entries[entries.length - 1];
        if (last.nextHopProtocol) {
          return last.nextHopProtocol;
        }
      }
    } catch { /* Performance API unavailable */ }
    return null;
  }

  toMetadata(): StreamingMetadata {
    const now = performance.now();
    return {
      streaming: {
        phase: this.phase,
        durationMs: Math.round(now - this.startTime),
        ttfbMs: this.ttfbTime != null ? Math.round(this.ttfbTime - this.startTime) : null,
        timeSinceLastChunkMs: Math.round(now - this.lastChunkTime),
        chunkCount: this.chunkCount,
        bytesReceived: this.bytesReceived,
        payloadSizeBytes: this.payloadSizeBytes,
        protocol: this.resolveProtocol(),
        network: this.networkInfo,
        retryAttempt: this.retryAttempt,
      },
    };
  }
}

class ChatService {
  private readonly STREAM_API_URL = '/api/anthropic-stream';
  private authToken: string | null = null;

  private static isNetworkError(error: Error): boolean {
    return error.name === 'TypeError' ||
           error.message.includes('network') ||
           error.message.includes('Failed to fetch');
  }

  setAuthToken(token: string | null) {
    this.authToken = token;
  }

  private async streamFromApi(
    url: string,
    requestBody: any,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
    ctx?: StreamingContext,
    extraHeaders?: Record<string, string>,
    model: string = 'claude-opus-4-7'
  ): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        headers[k] = v;
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal,
      // Include same-origin cookies so the Turnstile `tocb_anon` cookie
      // reaches the Worker. Same-origin defaults to 'same-origin' already,
      // but being explicit avoids Safari/cross-origin surprises.
      credentials: 'include',
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error('[ChatService] API Error Response:', {
        status: response.status,
        statusText: response.statusText,
        errorData
      });

      // Cost/policy errors: surface via onCostError and do NOT enter the generic
      // error path (no retry, no onError). The worker returns these shapes for
      // predictable status codes — see COST_ERROR_MAP.
      const errorType: string | undefined =
        errorData?.error?.type || errorData?.error || errorData?.type;
      const expectedTypes = COST_ERROR_MAP[response.status];
      if (expectedTypes && typeof errorType === 'string' && expectedTypes.includes(errorType as CostErrorType)) {
        callbacks.onCostError?.({ type: errorType as CostErrorType, data: errorData });
        ctx?.markError();

        // Persist service-class errors to logging_errors so the original
        // upstream cause (count_tokens rate-limit reason, Neon timeout,
        // Auth0 JWKS failure, etc.) makes it into the DB. Cap/quota
        // errors are expected operational states, not diagnostic noise —
        // skip those. We rely on the worker to have put the upstream
        // cause in errorData.upstream_message / upstream_status.
        const SERVICE_ERROR_TYPES = new Set<CostErrorType>([
          'database_unavailable',
          'estimation_unavailable',
          'authentication_service_unavailable',
        ]);
        if (SERVICE_ERROR_TYPES.has(errorType as CostErrorType)) {
          const upstream = errorData as {
            upstream_status?: number;
            upstream_message?: string;
          } | undefined;
          loggingService.reportError({
            error_name: `CostError:${errorType}`,
            error_message: upstream?.upstream_message ?? `HTTP ${response.status} ${errorType}`,
            http_status: response.status,
            request_metadata: {
              error_type: errorType,
              upstream_status: upstream?.upstream_status,
              upstream_message: upstream?.upstream_message,
              model, mode, messageCount: messages.length,
              webSearchEnabled, extendedThinkingEnabled,
              ...(ctx ? ctx.toMetadata().streaming : {}),
            },
          });
        }

        // Signal to the caller that this was a terminal cost error; the outer
        // try/catch should not re-enter retry or fall through to onError.
        const err = new Error(`cost_error:${errorType}`);
        (err as { httpStatus?: number }).httpStatus = response.status;
        throw markAsCostError(err);
      }

      const msg = errorData?.error?.message || errorData?.error?.type || errorData?.details || `HTTP error! status: ${response.status}`;
      const err = new Error(msg);
      (err as any).httpStatus = response.status;
      throw err;
    }

    if (!response.body) {
      throw new Error('No response body');
    }

    ctx?.markHeadersReceived();

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let fullThinking = '';
    let usage: any = null;
    let hasSearched = false;

    // Running cost accumulators for onCostUpdate. Anthropic's message_delta.usage
    // is cumulative (each delta carries the latest totals, not an increment), so
    // Math.max is safe belt-and-suspenders against any out-of-order delivery.
    const inputRate = MODEL_INPUT_RATES_USD_PER_MTOK[model] ?? 5;
    const outputRate = MODEL_OUTPUT_RATES_USD_PER_MTOK[model] ?? 25;
    let runningInput = 0;
    let runningOutput = 0;
    let runningCacheCreate = 0;
    let runningCacheRead = 0;
    let runningWebSearch = 0;
    const computeRunningCost = () =>
      (runningInput / 1_000_000) * inputRate +
      (runningCacheCreate / 1_000_000) * inputRate * 1.25 +
      (runningCacheRead / 1_000_000) * inputRate * 0.1 +
      (runningOutput / 1_000_000) * outputRate +
      runningWebSearch * WEB_SEARCH_USD_PER_USE;
    const updateUsage = (u: any) => {
      runningInput = Math.max(runningInput, u.input_tokens ?? 0);
      runningOutput = Math.max(runningOutput, u.output_tokens ?? 0);
      runningCacheCreate = Math.max(runningCacheCreate, u.cache_creation_input_tokens ?? 0);
      runningCacheRead = Math.max(runningCacheRead, u.cache_read_input_tokens ?? 0);
      runningWebSearch = Math.max(runningWebSearch, u.server_tool_use?.web_search_requests ?? 0);
      callbacks.onCostUpdate?.(computeRunningCost());
    };

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        ctx?.markChunkReceived(value.byteLength);
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.startsWith(':')) continue;

          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            if (data === '[DONE]') {
              // Don't call onComplete here - wait for message_stop event which has complete usage data
              continue;
            }

            let event;
            try {
              event = JSON.parse(data);
            } catch {
              continue; // partial SSE data, wait for more
            }

            try {
              // Mid-stream synthesized error events from the worker (U9). These
              // arrive as SSE events rather than HTTP errors because the failure
              // was detected after streaming began. They terminate the stream
              // via onCostError without invoking onError or the retry path.
              if (typeof event.type === 'string' && event.type in MID_STREAM_ERROR_TYPES) {
                const mappedType = MID_STREAM_ERROR_TYPES[event.type];
                callbacks.onCostError?.({ type: mappedType, data: event });
                ctx?.markError();
                throw markAsCostError(new Error(`cost_error:${mappedType}`));
              }

              // Handle web search events
              if (event.type === 'content_block_start' && event.content_block?.type === 'server_tool_use') {
                if (event.content_block.name === 'web_search' && !hasSearched) {
                  callbacks.onSearchStart?.();
                  hasSearched = true;
                }
              } else if (event.type === 'content_block_start' && event.content_block?.type === 'web_search_tool_result') {
                const searchResults = event.content_block?.content;
                if (searchResults && Array.isArray(searchResults)) {
                  const formattedResults = searchResults
                    .filter(result => result.type === 'web_search_result')
                    .map(result => ({
                      title: result.title || 'No title',
                      content: `Web search result from ${result.page_age || 'recent'} - Content integrated in AI response below.`,
                      url: result.url || '#',
                      score: 0.9
                    }));
                  callbacks.onSearchComplete?.(formattedResults);
                } else {
                  callbacks.onSearchComplete?.();
                }
              } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
                const chunk = event.delta.text;
                fullContent += chunk;
                const cleanContent = cleanResponseContent(fullContent);
                callbacks.onContent?.(chunk, cleanContent);
              } else if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') {
                const chunk = typeof event.delta.thinking === 'string' ? event.delta.thinking : '';
                if (chunk) {
                  fullThinking += chunk;
                  callbacks.onThinking?.(chunk, fullThinking);
                }
              } else if (event.type === 'message_start' && event.message?.usage) {
                usage = event.message.usage;
                updateUsage(event.message.usage);
              } else if (event.type === 'message_delta' && event.usage) {
                usage = { ...usage, ...event.usage };
                updateUsage(event.usage);
              } else if (event.type === 'running_cost' && typeof event.cost_usd === 'number') {
                // Worker-synthesized event: the server-side count_tokens
                // poller has a fresh cumulative-cost estimate. Anthropic's
                // own usage fields only fire at message_start/message_delta,
                // so without this the UI "$X so far" stayed frozen through
                // the whole generation phase. The poller event updates it
                // every ~5 seconds.
                callbacks.onCostUpdate?.(event.cost_usd);
              } else if (event.type === 'message_stop') {
                ctx?.markComplete();
                if (ctx) {
                  const meta = ctx.toMetadata().streaming;
                  console.log(
                    `[ChatService] Stream complete:` +
                    ` duration=${meta.durationMs}ms` +
                    ` ttfb=${meta.ttfbMs}ms` +
                    ` chunks=${meta.chunkCount}` +
                    ` bytes=${meta.bytesReceived}` +
                    ` protocol=${meta.protocol ?? '?'}`
                  );
                }
                const editInstructions = parseEditInstructions(fullContent);
                const cleanContent = cleanResponseContent(fullContent);
                // Pass raw fullContent so loggers capture exactly what
                // Claude produced. Display uses cleanContent; audit uses
                // rawMessage.
                try {
                  callbacks.onComplete?.(cleanContent, editInstructions, usage, fullContent);
                } catch (callbackErr) {
                  console.error('[ChatService] onComplete callback error:', callbackErr);
                }
                return;
              }
            } catch (e) {
              // Cost errors (from HTTP pre-stream or mid-stream synthesized events)
              // have already invoked onCostError and should propagate unchanged so
              // the outer catch skips retry and generic onError.
              if (isCostError(e)) {
                throw e;
              }
              console.error('[ChatService] Error processing SSE event:', e);
              // Re-throw to outer handler so StreamingContext diagnostics are
              // included in the error report. Previously this silently returned
              // after calling onError, losing all transport context.
              const wrapped = e instanceof Error ? e : new Error(String(e));
              (wrapped as any).isSSEProcessingError = true;
              throw wrapped;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Stream ended without message_stop — treat as incomplete
    if (ctx && ctx.phase !== 'complete') {
      throw new Error(
        `Stream ended unexpectedly in phase "${ctx.phase}" after ${ctx.chunkCount} chunks`
      );
    }
  }

  async streamMessage(options: StreamMessageOptions): Promise<void> {
    const {
      messages,
      currentGraphData,
      mode,
      callbacks = {},
      signal,
      model = 'claude-opus-4-7',
      webSearchEnabled = false,
      customSystemPrompt,
      highlightedNodes,
      extendedThinkingEnabled = false,
      attachedFileIds = [],
      idempotencyKey,
      userAnthropicKey,
      chartId,
      loggingMessageId,
    } = options;

    let ctx: StreamingContext | undefined;
    let requestBody: any;
    // Initialize to empty string so TS can prove it's assigned before use in
    // the catch-block retry guard. The real value is set before streamFromApi.
    let serializedBody = '';
    let retriedWithH2 = false;
    // Captured in the try-block so the H3->H2 retry can reuse most headers.
    let capturedExtraHeaders: Record<string, string> | undefined;
    try {
      // Process the last user message
      const processedMessages = [...messages];
      const lastIndex = messages.length - 1;

      // Normalize highlightedNodes (options type accepts Set or string[]) into
      // a Set for O(1) membership checks below.
      const highlightedSet: Set<string> | undefined = highlightedNodes
        ? (highlightedNodes instanceof Set ? highlightedNodes : new Set(highlightedNodes))
        : undefined;

      if (processedMessages[lastIndex].role === 'user') {
        // Add graph data - create a copy to avoid modifying the original message.
        // Shape is intentionally loose here (options.currentGraphData is `unknown`
        // per the public interface); inner access is typed as `any` because the
        // real shape lives in utils/addNodePaths and graph components.
        if (currentGraphData) {
          const dataWithPaths = addNodePaths(currentGraphData as any);
          processedMessages[lastIndex] = {
            ...processedMessages[lastIndex],
            content: processedMessages[lastIndex].content + `\n\n[CURRENT_GRAPH_DATA]\n${JSON.stringify(dataWithPaths, null, 2)}\n[/CURRENT_GRAPH_DATA]`
          };
        }

        // Add selected nodes data after graph data
        if (highlightedSet && highlightedSet.size > 0 && currentGraphData) {
          const selectedNodesJson: any[] = []
          const graph = currentGraphData as any;

          graph.sections?.forEach((section: any, sectionIndex: number) => {
            section.columns?.forEach((column: any, columnIndex: number) => {
              column.nodes?.forEach((node: any, nodeIndex: number) => {
                if (highlightedSet.has(node.id)) {
                  // Create a copy with path added
                  const nodeWithPath = {
                    ...node,
                    path: `sections.${sectionIndex}.columns.${columnIndex}.nodes.${nodeIndex}`
                  }
                  selectedNodesJson.push(nodeWithPath)
                }
              })
            })
          })

          if (selectedNodesJson.length > 0) {
            const selectedNodesContent = `\n\n[SELECTED_NODES]\n${JSON.stringify(selectedNodesJson, null, 2)}\n[/SELECTED_NODES]`;
            processedMessages[lastIndex] = {
              ...processedMessages[lastIndex],
              content: processedMessages[lastIndex].content + selectedNodesContent
            };
          }
        }
      }

      // Use custom system prompt if provided, otherwise use default
      let baseSystemPrompt: string;
      if (customSystemPrompt?.trim()) {
        baseSystemPrompt = customSystemPrompt;
      } else {
        baseSystemPrompt = systemPromptContent;
      }

      // Combine with mode-specific prompt
      const systemPrompt = mode === 'generate'
        ? `${baseSystemPrompt}\n\n${generateModePromptContent}`
        : `${baseSystemPrompt}\n\n${chatModePromptContent}`;

      // Build messages. For every user turn that had files attached —
      // whether it's the message currently being sent (last index) or a
      // prior turn in history — re-emit `document` content blocks ahead of
      // the text so Anthropic sees the PDF context on every follow-up.
      // Without this, PDFs uploaded on turn 1 were invisible to turn 2+:
      // the file blocks only got attached to the latest message, and past
      // messages serialized as plain strings.
      const outgoingMessages = processedMessages.map((msg, i) => {
        const fileIds =
          i === lastIndex ? attachedFileIds : (msg.attachedFileIds ?? []);
        if (msg.role === 'user' && fileIds.length > 0) {
          const docBlocks = fileIds.map(file_id => ({
            type: 'document',
            source: { type: 'file', file_id },
          }));
          return {
            role: msg.role as 'user' | 'assistant',
            content: [
              ...docBlocks,
              { type: 'text', text: msg.content },
            ],
          };
        }
        return {
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        };
      });

      // Create request body for streaming API. max_tokens is per-model
      // (Opus 128K, Sonnet/Haiku 64K) — sourced from shared/pricing.ts so
      // it stays in sync with the models-overview docs.
      const maxOutputTokens = MODEL_CAPABILITIES[model]?.max_output_tokens ?? 64_000;
      requestBody = {
        model,
        max_tokens: maxOutputTokens,
        system: [{
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" }
        }],
        messages: outgoingMessages,
        stream: true
      };

      // Mode-conditional top-level cache_control (per v2 spec, Subtask 5):
      // - Chat: top-level automatic caching of the growing conversation PLUS
      //   the explicit system-block breakpoint above. Uses 2 of 4 breakpoint
      //   slots; history hits at 0.1× input rate after the first turn.
      // - Generate: explicit system-block only. Top-level would write 1.25×
      //   the full mutating payload (PDFs, graph, edit instructions) on every
      //   one-shot call — cost outweighs benefit when there's no repeat turn.
      if (mode === 'chat') {
        requestBody.cache_control = { type: 'ephemeral' };
      }

      // Some models accept an output_config.effort; others reject the field.
      // Capability flag lives in shared/pricing.ts so it stays in sync with
      // the models-overview docs.
      if (MODEL_CAPABILITIES[model]?.supports_output_config_effort) {
        requestBody.output_config = { effort: 'xhigh' };
      }

      // Add web search with dynamic filtering (auto-injects code_execution)
      if (webSearchEnabled) {
        requestBody.tools = [{
          type: "web_search_20260209",
          name: "web_search"
        }];
      }

      // Add adaptive thinking if enabled (Claude decides how much to think).
      // display: 'summarized' requests summarized thinking blocks so the UI
      // can render a compact progress indicator rather than raw reasoning.
      if (extendedThinkingEnabled) {
        requestBody.thinking = {
          type: "adaptive",
          display: "summarized"
        };
      }

      serializedBody = JSON.stringify(requestBody);
      ctx = new StreamingContext(serializedBody.length, this.STREAM_API_URL);

      // Idempotency-Key guards against browser-level double-sends (reload,
      // accidental double-click) within the worker's 60s dedup window. The
      // caller can supply a stable key (e.g. message UUID) for guaranteed
      // replay-safety; otherwise we mint a fresh one per attempt.
      //
      // Turnstile is NOT threaded per-request: after the first successful
      // /api/verify-turnstile call the Worker sets an httpOnly `tocb_anon`
      // cookie, which the browser auto-sends on every subsequent request.
      // This streamMessage call passes `credentials: 'include'` (via
      // streamFromApi) to ensure same-origin cookies ride along (Safari is
      // picky — being explicit avoids surprises).
      const extraHeaders: Record<string, string> = {
        'X-Idempotency-Key': idempotencyKey ?? newIdempotencyKey(),
      };
      if (userAnthropicKey) extraHeaders['X-User-Anthropic-Key'] = userAnthropicKey;
      if (chartId) extraHeaders['X-Chart-Id'] = chartId;
      if (loggingMessageId) extraHeaders['X-Logging-Message-Id'] = loggingMessageId;
      capturedExtraHeaders = extraHeaders;

      await this.streamFromApi(
        this.STREAM_API_URL,
        requestBody,
        callbacks,
        signal,
        ctx,
        extraHeaders,
        model
      );
    } catch (caughtError: unknown) {
      // Narrow caughtError once. Non-Error throws (strings, plain objects) are
      // wrapped so downstream code can rely on .name/.message/.stack. The
      // original value is preserved when it's already an Error.
      let err: Error = caughtError instanceof Error ? caughtError : new Error(String(caughtError));
      const wasNonError = !(caughtError instanceof Error);

      ctx?.markError();
      let streamingMeta: Record<string, unknown> = {};
      try {
        if (ctx) streamingMeta = ctx.toMetadata();
      } catch (metaErr) {
        console.warn('[ChatService] Failed to collect streaming metadata:', metaErr);
      }

      if (!wasNonError) {
        if (err.name === 'AbortError') return;

        // Cost/policy errors were already surfaced via onCostError inside
        // streamFromApi. Do NOT retry and do NOT invoke the generic onError —
        // the caller (ChatInterface) renders a dedicated prompt per type.
        if (isCostError(err)) return;

        let httpStatus = (err as { httpStatus?: number }).httpStatus;
        let isSSEProcessingError = (err as { isSSEProcessingError?: boolean }).isSSEProcessingError === true;

        let isNetworkErr = ChatService.isNetworkError(err);

        // Retry with ?force-h2=1: the server responds with Alt-Svc: clear,
        // telling the browser to stop using H3 for this origin. This retry itself
        // may still use H3 (browser caches connections), but subsequent requests
        // will fall back to H2. The retry also helps with transient QUIC failures
        // that succeed on a fresh connection attempt.
        //
        // Idempotency trade-off: we mint a FRESH X-Idempotency-Key for the retry.
        // Reusing the original key would collide with the worker's 60s dedup
        // window and return 409 idempotent_replay. The downside is that if both
        // the original request AND the retry actually reached Anthropic (rare:
        // would require the failure to occur between Anthropic acknowledging the
        // request and us seeing the SSE stream), both would bill. The 60s window
        // primarily protects against browser-level double-sends; H3->H2 retry
        // is rare enough that occasional double-billing is acceptable.
        if (isNetworkErr && !retriedWithH2 && !signal?.aborted && serializedBody !== '') {
          retriedWithH2 = true;

          // Log the first failure for observability
          loggingService.reportError({
            error_name: 'NetworkErrorRetrying',
            error_message: err.message,
            http_status: httpStatus,
            stack_trace: err.stack,
            request_metadata: {
              model, mode, messageCount: messages.length,
              webSearchEnabled, extendedThinkingEnabled,
              ...streamingMeta,
            },
          });

          console.warn('[ChatService] Network error, retrying with force-h2=1...');

          // Retry with HTTP/2 fallback
          const retryCtx = new StreamingContext(
            serializedBody.length,
            this.STREAM_API_URL + '?force-h2=1'
          );
          retryCtx.retryAttempt = 1;

          // Fresh idempotency key for retry (see comment above).
          const retryHeaders: Record<string, string> = {
            ...(capturedExtraHeaders ?? {}),
            'X-Idempotency-Key': newIdempotencyKey(),
          };

          try {
            await this.streamFromApi(
              this.STREAM_API_URL + '?force-h2=1',
              requestBody,
              callbacks,
              signal,
              retryCtx,
              retryHeaders,
              model
            );
            return; // Retry succeeded, callbacks already fired
          } catch (retryError: unknown) {
            // If user aborted during retry, exit cleanly
            if (retryError instanceof DOMException && retryError.name === 'AbortError') return;
            if (signal?.aborted) return;
            // Cost errors surfaced during retry are also terminal.
            if (isCostError(retryError)) return;

            // Retry also failed — update context for error reporting below
            retryCtx.markError();
            try { streamingMeta = retryCtx.toMetadata(); } catch { /* ignore */ }
            // Re-assign err for the reporting below (narrow unknown → Error).
            err = retryError instanceof Error ? retryError : new Error(String(retryError));
            // Recompute flags for the retry error
            httpStatus = (err as { httpStatus?: number }).httpStatus;
            isSSEProcessingError = (err as { isSSEProcessingError?: boolean }).isSSEProcessingError === true;
            isNetworkErr = ChatService.isNetworkError(err);
            // Fall through to normal error handling
          }
        }

        const errorMessage = err.message.includes('rate_limit') ? "Rate limit exceeded. Please wait and try again." :
                           err.message.includes('invalid_api_key') ? "Invalid API key. Please check your settings." :
                           err.message.includes('insufficient_quota') ? "Insufficient API quota." :
                           isSSEProcessingError ? "Failed to process the AI response. Please try again." :
                           isNetworkErr ? "Network error. Please check your connection." :
                           "An error occurred. Please try again.";

        // One-liner for quick scanning in text logs; structured object below for DevTools drill-down
        const streamMeta = (streamingMeta as { streaming?: Record<string, unknown> }).streaming;
        console.error(
          `[ChatService] Request failed: ${err.name}: ${err.message}` +
          ` | phase=${streamMeta?.phase ?? 'unknown'}` +
          ` protocol=${streamMeta?.protocol ?? 'unknown'}` +
          ` duration=${streamMeta?.durationMs ?? '?'}ms` +
          ` chunks=${streamMeta?.chunkCount ?? '?'}` +
          ` http=${httpStatus ?? 'none'}`
        );
        console.error('[ChatService] Request details:', {
          errorName: err.name,
          originalMessage: err.message,
          httpStatus: (err as { httpStatus?: number }).httpStatus ?? httpStatus,
          userFacingMessage: errorMessage,
          stack: err.stack,
        });

        loggingService.reportError({
          error_name: err.name,
          error_message: err.message,
          http_status: (err as { httpStatus?: number }).httpStatus ?? httpStatus,
          stack_trace: err.stack,
          request_metadata: {
            model,
            mode,
            messageCount: messages.length,
            webSearchEnabled,
            extendedThinkingEnabled,
            ...streamingMeta,
          },
        });

        callbacks.onError?.(errorMessage);
      } else {
        // Non-Error was thrown (string, plain object, etc.). We wrapped it
        // above for type safety, but report the raw form for observability.
        console.error('[ChatService] Non-Error thrown:', caughtError);
        loggingService.reportError({
          error_name: 'NonErrorThrown',
          error_message: String(caughtError),
          request_metadata: {
            model,
            mode,
            messageCount: messages.length,
            webSearchEnabled,
            extendedThinkingEnabled,
            ...streamingMeta,
          },
        });
        callbacks.onError?.("An error occurred. Please try again.");
      }
    }
  }

  async checkApiKey(): Promise<boolean> {
    // API key is managed server-side. This method is kept for backward
    // compatibility but always returns true; the actual key validation
    // happens in the Worker on each /api/anthropic-stream request.
    return true;
  }
}

export const chatService = new ChatService();