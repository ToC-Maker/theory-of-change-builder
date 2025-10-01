import { type EditInstruction, parseEditInstructions, cleanResponseContent } from '../utils/graphEdits';
import systemPromptContent from '../prompts/systemPrompt.md?raw';
import chatModePromptContent from '../prompts/chatModePrompt.md?raw';
import generateModePromptContent from '../prompts/generateModePrompt.md?raw';
import { addNodePaths } from '../utils/addNodePaths';
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
        // Add graph data - create a copy to avoid modifying the original message
        if (currentGraphData) {
          const dataWithPaths = addNodePaths(currentGraphData);
          processedMessages[lastIndex] = {
            ...processedMessages[lastIndex],
            content: processedMessages[lastIndex].content + `\n\n[CURRENT_GRAPH_DATA]\n${JSON.stringify(dataWithPaths, null, 2)}\n[/CURRENT_GRAPH_DATA]`
          };
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
      const createOptions: any = {
        model,
        max_tokens: 20000,
        system: systemPrompt,
        messages: processedMessages.map(msg => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        })),
        stream: true
      };

      // Add web search tool if enabled
      if (webSearchEnabled) {
        createOptions.tools = [{
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5
        }];
      }

      const stream = await client.messages.create(createOptions);

      let fullContent = '';
      let usage = null;
      let hasSearched = false;

      for await (const event of stream) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        // Handle web search events
        if (event.type === 'content_block_start' && event.content_block?.type === 'server_tool_use') {
          if (event.content_block.name === 'web_search') {
            if (!hasSearched) {
              callbacks.onSearchStart?.();
              hasSearched = true;
            }
          }
        } else if (event.type === 'content_block_start' && event.content_block?.type === 'web_search_tool_result') {
          // Extract search results and pass to callback
          const searchResults = (event.content_block as any)?.content;
          if (searchResults && Array.isArray(searchResults)) {
            const formattedResults = searchResults
              .filter(result => result.type === 'web_search_result')
              .map(result => ({
                title: result.title || 'No title',
                content: `Web search result from ${result.page_age || 'recent'} - Content integrated in AI response below.`,
                url: result.url || '#',
                score: 0.9 // Default score since Anthropic doesn't provide relevance scores
              }));
            callbacks.onSearchComplete?.(formattedResults);
          } else {
            callbacks.onSearchComplete?.();
          }
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
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