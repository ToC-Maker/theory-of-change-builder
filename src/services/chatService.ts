import { type EditInstruction, parseEditInstructions, cleanResponseContent } from '../utils/graphEdits';
import systemPromptContent from '../prompts/systemPrompt.md?raw';
import chatModePromptContent from '../prompts/chatModePrompt.md?raw';
import generateModePromptContent from '../prompts/generateModePrompt.md?raw';
import { addNodePaths } from '../utils/addNodePaths';
import { loggingService } from './loggingService';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
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
}

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
  private readonly EDGE_FUNCTION_URL = '/api/anthropic-stream';
  private authToken: string | null = null;

  private static isNetworkError(error: Error): boolean {
    return error.name === 'TypeError' ||
           error.message.includes('network') ||
           error.message.includes('Failed to fetch');
  }

  setAuthToken(token: string | null) {
    this.authToken = token;
  }

  private async streamFromEdgeFunction(
    url: string,
    requestBody: any,
    callbacks: {
      onContent?: (chunk: string, fullContent: string) => void;
      onComplete?: (message: string, editInstructions?: EditInstruction[], usage?: any) => void;
      onError?: (error: string) => void;
      onSearchStart?: () => void;
      onSearchComplete?: (results?: any[]) => void;
    },
    signal?: AbortSignal,
    ctx?: StreamingContext
  ): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error('[ChatService] API Error Response:', {
        status: response.status,
        statusText: response.statusText,
        errorData
      });
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
    let usage: any = null;
    let hasSearched = false;

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
              } else if (event.type === 'message_start' && event.message?.usage) {
                usage = event.message.usage;
              } else if (event.type === 'message_delta' && event.usage) {
                usage = { ...usage, ...event.usage };
              } else if (event.type === 'message_stop') {
                ctx?.markComplete();
                const editInstructions = parseEditInstructions(fullContent);
                const cleanContent = cleanResponseContent(fullContent);
                // Separate try so callback bugs aren't reported as streaming failures
                try {
                  callbacks.onComplete?.(cleanContent, editInstructions, usage);
                } catch (callbackErr) {
                  console.error('[ChatService] onComplete callback error:', callbackErr);
                }
                return;
              }
            } catch (e) {
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

  async streamMessage(
    messages: ChatMessage[],
    currentGraphData: any,
    mode: 'chat' | 'generate',
    apiKey: string = '', // API key parameter kept for backward compatibility but not used
    callbacks: {
      onContent?: (chunk: string, fullContent: string) => void;
      onComplete?: (message: string, editInstructions?: EditInstruction[], usage?: any) => void;
      onError?: (error: string) => void;
      onSearchStart?: () => void;
      onSearchComplete?: (results?: any[]) => void;
    } = {},
    signal?: AbortSignal,
    model: string = "claude-opus-4-6",
    webSearchEnabled: boolean = false,
    customSystemPrompt?: string,
    highlightedNodes?: Set<string>,
    extendedThinkingEnabled: boolean = false
  ): Promise<void> {
    let ctx: StreamingContext | undefined;
    let requestBody: any;
    let serializedBody: string;
    let retriedWithH2 = false;
    try {
      // Process the last user message
      const processedMessages = [...messages];
      const lastIndex = messages.length - 1;

      if (processedMessages[lastIndex].role === 'user') {
        // Add graph data - create a copy to avoid modifying the original message
        if (currentGraphData) {
          const dataWithPaths = addNodePaths(currentGraphData);
          processedMessages[lastIndex] = {
            ...processedMessages[lastIndex],
            content: processedMessages[lastIndex].content + `\n\n[CURRENT_GRAPH_DATA]\n${JSON.stringify(dataWithPaths, null, 2)}\n[/CURRENT_GRAPH_DATA]`
          };
        }

        // Add selected nodes data after graph data
        if (highlightedNodes && highlightedNodes.size > 0 && currentGraphData) {
          const selectedNodesJson: any[] = []

          currentGraphData.sections?.forEach((section: any, sectionIndex: number) => {
            section.columns?.forEach((column: any, columnIndex: number) => {
              column.nodes?.forEach((node: any, nodeIndex: number) => {
                if (highlightedNodes.has(node.id)) {
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

      // Create request body for edge function
      requestBody = {
        model,
        max_tokens: 64000,
        system: [{
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" }
        }],
        messages: processedMessages.map(msg => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        })),
        stream: true
      };

      // Add web search with dynamic filtering (auto-injects code_execution)
      if (webSearchEnabled) {
        requestBody.tools = [{
          type: "web_search_20260209",
          name: "web_search"
        }];
      }

      // Add adaptive thinking if enabled (Claude decides how much to think)
      if (extendedThinkingEnabled) {
        requestBody.thinking = {
          type: "adaptive"
        };
      }

      serializedBody = JSON.stringify(requestBody);
      ctx = new StreamingContext(serializedBody.length, this.EDGE_FUNCTION_URL);

      await this.streamFromEdgeFunction(this.EDGE_FUNCTION_URL, requestBody, callbacks, signal, ctx);
    } catch (caughtError) {
      let error = caughtError;
      ctx?.markError();
      let streamingMeta: Record<string, unknown> = {};
      try {
        if (ctx) streamingMeta = ctx.toMetadata();
      } catch (metaErr) {
        console.warn('[ChatService] Failed to collect streaming metadata:', metaErr);
      }

      if (error instanceof Error) {
        if (error.name === 'AbortError') return;

        const httpStatus = (error as any).httpStatus as number | undefined;
        const isSSEProcessingError = (error as any).isSSEProcessingError === true;

        const isNetworkErr = ChatService.isNetworkError(error);

        // Attempt H2 fallback retry on network errors (QUIC failures, etc.)
        if (isNetworkErr && !retriedWithH2 && !signal?.aborted) {
          retriedWithH2 = true;

          // Log the first failure for observability
          loggingService.reportError({
            error_name: 'NetworkErrorRetrying',
            error_message: error.message,
            http_status: httpStatus,
            stack_trace: error.stack,
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
            this.EDGE_FUNCTION_URL + '?force-h2=1'
          );
          retryCtx.retryAttempt = 1;

          try {
            await this.streamFromEdgeFunction(
              this.EDGE_FUNCTION_URL + '?force-h2=1',
              requestBody,
              callbacks,
              signal,
              retryCtx
            );
            return; // Retry succeeded, callbacks already fired
          } catch (retryError) {
            // Retry also failed — update context for error reporting below
            retryCtx.markError();
            try { streamingMeta = retryCtx.toMetadata(); } catch { /* ignore */ }
            // Re-assign error for the reporting below
            error = retryError instanceof Error ? retryError : new Error(String(retryError));
            // Fall through to normal error handling
          }
        }

        const errorMessage = error.message.includes('rate_limit') ? "Rate limit exceeded. Please wait and try again." :
                           error.message.includes('invalid_api_key') ? "Invalid API key. Please check your settings." :
                           error.message.includes('insufficient_quota') ? "Insufficient API quota." :
                           isSSEProcessingError ? "Failed to process the AI response. Please try again." :
                           isNetworkErr ? "Network error. Please check your connection." :
                           "An error occurred. Please try again.";

        console.error('[ChatService] Request failed:', {
          errorName: error.name,
          originalMessage: error.message,
          httpStatus: (error as any).httpStatus ?? httpStatus,
          userFacingMessage: errorMessage,
          stack: error.stack,
        });

        loggingService.reportError({
          error_name: error.name,
          error_message: error.message,
          http_status: (error as any).httpStatus ?? httpStatus,
          stack_trace: error.stack,
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
        console.error('[ChatService] Non-Error thrown:', error);
        loggingService.reportError({
          error_name: 'NonErrorThrown',
          error_message: String(error),
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

  async checkApiKey(apiKey: string = ''): Promise<boolean> {
    // API key is now managed on the backend via edge function
    // This method is kept for backward compatibility but always returns true
    // The actual API key validation will happen on the server side
    return true;
  }
}

export const chatService = new ChatService();