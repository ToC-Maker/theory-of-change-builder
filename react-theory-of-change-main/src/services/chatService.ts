import { type EditInstruction, parseEditInstructions, cleanResponseContent } from '../utils/graphEdits';
import systemPromptContent from '../prompts/systemPrompt.md?raw';
import chatModePromptContent from '../prompts/chatModePrompt.md?raw';
import generateModePromptContent from '../prompts/generateModePrompt.md?raw';
import { addNodePaths } from '../utils/addNodePaths';
import { tavilyService } from './tavilyService';
import Anthropic from '@anthropic-ai/sdk';

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

class ChatService {
  private getClient(apiKey: string): Anthropic {
    return new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true
    });
  }

  private async enhanceWithSearch(
    message: string,
    callbacks?: {
      onSearchStart?: () => void;
      onSearchComplete?: (results?: any[]) => void;
    },
    webSearchEnabled: boolean = false
  ): Promise<string> {
    // Only search if explicitly enabled
    if (!webSearchEnabled || !tavilyService.isConfigured()) {
      return message;
    }

    console.log('🔍 Fetching web context...');
    callbacks?.onSearchStart?.();

    try {
      // Get both context and full search results
      const searchResult = await tavilyService.search(message, {
        max_results: 5,
        search_depth: 'advanced',
        include_answer: true,
        time_range: 'week'
      });

      callbacks?.onSearchComplete?.(searchResult.data?.results);

      if (searchResult.data?.results) {
        // Format search results for context
        const context = searchResult.data.results
          .map(result => `**${result.title}**\n${result.content}\nSource: ${result.url}`)
          .join('\n\n---\n\n');

        return `${message}\n\n[WEB_SEARCH_CONTEXT]\n${context}\n[/WEB_SEARCH_CONTEXT]`;
      }
    } catch (error) {
      console.error('Search failed:', error);
      callbacks?.onSearchComplete?.();
    }

    return message;
  }

  async streamMessage(
    messages: ChatMessage[],
    currentGraphData: any,
    mode: 'chat' | 'generate',
    apiKey: string,
    callbacks: {
      onContent?: (chunk: string, fullContent: string) => void;
      onComplete?: (message: string, editInstructions?: EditInstruction[], usage?: any) => void;
      onError?: (error: string) => void;
      onSearchStart?: () => void;
      onSearchComplete?: () => void;
    },
    signal?: AbortSignal,
    model: string = "claude-sonnet-4-20250514",
    webSearchEnabled: boolean = false,
    customSystemPrompt?: string
  ): Promise<void> {
    if (!apiKey?.trim()) {
      callbacks.onError?.("Please configure your Anthropic API key.");
      return;
    }

    try {
      // Process the last user message
      const processedMessages = [...messages];
      const lastIndex = messages.length - 1;

      if (processedMessages[lastIndex].role === 'user') {
        // Add search context if needed
        processedMessages[lastIndex] = {
          ...processedMessages[lastIndex],
          content: await this.enhanceWithSearch(processedMessages[lastIndex].content, {
            onSearchStart: callbacks.onSearchStart,
            onSearchComplete: callbacks.onSearchComplete
          }, webSearchEnabled)
        };

        // Add graph data
        if (currentGraphData) {
          const dataWithPaths = addNodePaths(currentGraphData);
          processedMessages[lastIndex].content += `\n\n[CURRENT_GRAPH_DATA]\n${JSON.stringify(dataWithPaths, null, 2)}\n[/CURRENT_GRAPH_DATA]`;
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

      // Create the stream
      const client = this.getClient(apiKey);
      const stream = await client.messages.create({
        model,
        max_tokens: 20000,
        system: systemPrompt,
        messages: processedMessages.map(msg => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        })),
        stream: true
      });

      let fullContent = '';
      let usage = null;

      for await (const event of stream) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          const chunk = event.delta.text;
          fullContent += chunk;
          const cleanContent = cleanResponseContent(fullContent);
          callbacks.onContent?.(chunk, cleanContent);
        } else if (event.type === 'message_start' && event.message.usage) {
          usage = event.message.usage;
        } else if (event.type === 'message_delta' && event.delta.usage) {
          usage = { ...usage, ...event.delta.usage };
        } else if (event.type === 'message_stop') {
          const editInstructions = parseEditInstructions(fullContent);
          const cleanContent = cleanResponseContent(fullContent);
          callbacks.onComplete?.(cleanContent, editInstructions, usage);
          return;
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') return;

        const errorMessage = error.message.includes('rate_limit') ? "Rate limit exceeded. Please wait and try again." :
                           error.message.includes('invalid_api_key') ? "Invalid API key. Please check your settings." :
                           error.message.includes('insufficient_quota') ? "Insufficient API quota." :
                           error.message.includes('network') ? "Network error. Please check your connection." :
                           "An error occurred. Please try again.";

        callbacks.onError?.(errorMessage);
      }
    }
  }

  async checkApiKey(apiKey: string): Promise<boolean> {
    if (!apiKey?.trim()) return false;

    try {
      const client = this.getClient(apiKey);
      await client.messages.create({
        model: "claude-opus-4-20250514",
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }]
      });
      return true;
    } catch {
      return false;
    }
  }
}

export const chatService = new ChatService();