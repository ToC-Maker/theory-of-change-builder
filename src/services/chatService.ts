import { type EditInstruction, parseEditInstructions, cleanResponseContent } from '../utils/graphEdits';

// Import the system prompt from external file
import systemPromptContent from '../prompts/chatSystemPrompt.md?raw';
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

export interface ChatResponse {
  message: string;
  error?: string;
  editInstructions?: EditInstruction[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface StreamingChatResponse {
  onContent?: (chunk: string, fullContent: string) => void;
  onComplete?: (message: string, editInstructions?: EditInstruction[], usage?: any) => void;
  onError?: (error: string) => void;
}

// Use the imported system prompt content
const SYSTEM_PROMPT = systemPromptContent;

export { SYSTEM_PROMPT };



class ChatService {
  private getAnthropicClient(apiKey: string): Anthropic {
    return new Anthropic({ 
      apiKey,
      dangerouslyAllowBrowser: true // Required for browser usage
    });
  }

  async sendMessage(messages: ChatMessage[], currentGraphData?: any, apiKey?: string): Promise<ChatResponse> {
    if (!apiKey || !apiKey.trim()) {
      return {
        message: "Please configure your Anthropic API key to use the chat feature.",
        error: "NO_API_KEY"
      };
    }
    try {
      // Prepare messages with full graph JSON for the last user message
      const processedMessages = messages.map((msg, index) => {
        let content = msg.content;
        
        // Append current graph JSON with node paths to user messages
        if (msg.role === 'user' && currentGraphData && index === messages.length - 1) {
          console.log('=== GRAPH JSON SENT TO AI ===');
          console.log('Graph data size:', JSON.stringify(currentGraphData).length, 'characters');
          console.log('=== END GRAPH JSON ===');
          
          const dataWithPaths = addNodePaths(currentGraphData);
          content += `\n\n[CURRENT_GRAPH_DATA]\n${JSON.stringify(dataWithPaths, null, 2)}\n[/CURRENT_GRAPH_DATA]`;
        }
        
        return {
          role: msg.role as 'user' | 'assistant',
          content: content
        };
      });

      console.log(`Sending ${processedMessages.length} messages to Anthropic API`);

      const client = this.getAnthropicClient(apiKey);
      
      const response = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 20000,
        system: SYSTEM_PROMPT,
        messages: processedMessages
      });

      // Extract the text content from the response
      const content = response.content[0];
      if (content.type === 'text') {
        console.log('=== COMPLETE AI RESPONSE ===');
        console.log(content.text);
        console.log('=== END AI RESPONSE ===');
        
        // Parse edit instructions from the AI response
        const editInstructions = parseEditInstructions(content.text);
        
        // Clean the response content to remove edit instructions for display
        const displayMessage = cleanResponseContent(content.text);
        
        return {
          message: displayMessage,
          editInstructions: editInstructions,
          usage: {
            input_tokens: response.usage?.input_tokens ?? 0,
            output_tokens: response.usage?.output_tokens ?? 0,
            total_tokens: (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0)
          }
        };
      } else {
        return {
          message: "Received non-text response",
          error: "INVALID_RESPONSE_TYPE"
        };
      }
    } catch (error) {
      console.error('Error calling Anthropic API:', error);
      
      // Handle Anthropic API errors
      if (error instanceof Error) {
        if (error.message.includes('rate_limit') || error.message.includes('429')) {
          return {
            message: "Rate limit exceeded. Please wait a moment and try again.",
            error: "RATE_LIMIT"
          };
        }
        if (error.message.includes('invalid_api_key') || error.message.includes('401')) {
          return {
            message: "API key is invalid. Please check your API key in settings.",
            error: "INVALID_API_KEY"
          };
        }
        if (error.message.includes('insufficient_quota') || error.message.includes('402')) {
          return {
            message: "Insufficient API quota. Please check your Anthropic account.",
            error: "INSUFFICIENT_QUOTA"
          };
        }
        if (error.message.includes('network') || error.message.includes('fetch')) {
          return {
            message: "Network error. Please check your internet connection and try again.",
            error: "NETWORK_ERROR"
          };
        }
      }
      
      return {
        message: "Sorry, I encountered an error while processing your request.",
        error: "API_ERROR"
      };
    }
  }

  async sendStreamingMessage(
    messages: ChatMessage[], 
    currentGraphData: any, 
    callbacks: StreamingChatResponse,
    apiKey?: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (!apiKey || !apiKey.trim()) {
      callbacks.onError?.("Please configure your Anthropic API key to use the chat feature.");
      return;
    }
    try {
      // Prepare messages with full graph JSON for the last user message
      const processedMessages = messages.map((msg, index) => {
        let content = msg.content;
        
        // Append current graph JSON with node paths to user messages
        if (msg.role === 'user' && currentGraphData && index === messages.length - 1) {
          console.log('=== GRAPH JSON SENT TO AI ===');
          console.log('Graph data size:', JSON.stringify(currentGraphData).length, 'characters');
          console.log('=== END GRAPH JSON ===');
          
          const dataWithPaths = addNodePaths(currentGraphData);
          content += `\n\n[CURRENT_GRAPH_DATA]\n${JSON.stringify(dataWithPaths, null, 2)}\n[/CURRENT_GRAPH_DATA]`;
        }
        
        return {
          role: msg.role as 'user' | 'assistant',
          content: content
        };
      });

      console.log(`Sending ${processedMessages.length} messages to Anthropic API (streaming)`);

      const client = this.getAnthropicClient(apiKey);
      let fullContent = '';
      let usage = null;

      const stream = await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 20000,
        system: SYSTEM_PROMPT,
        messages: processedMessages,
        stream: true
      });

      for await (const messageStreamEvent of stream) {
        // Check for abort signal
        if (signal?.aborted) {
          throw new DOMException('Request was aborted', 'AbortError');
        }

        if (messageStreamEvent.type === 'message_start') {
          // Capture usage from the initial message
          if (messageStreamEvent.message.usage) {
            usage = messageStreamEvent.message.usage;
            console.log(`Usage captured from message_start:`, usage);
          }
        } else if (messageStreamEvent.type === 'content_block_delta') {
          if (messageStreamEvent.delta.type === 'text_delta') {
            const chunk = messageStreamEvent.delta.text;
            fullContent += chunk;
            
            // Clean the streaming content to hide edit instructions during typing
            const cleanStreamingContent = cleanResponseContent(fullContent);
            callbacks.onContent?.(chunk, cleanStreamingContent);
          }
        } else if (messageStreamEvent.type === 'message_delta') {
          // Update usage if provided in delta (for final token counts)
          if (messageStreamEvent.delta.usage) {
            usage = { ...usage, ...messageStreamEvent.delta.usage };
            console.log(`Usage updated from message_delta:`, usage);
          }
        } else if (messageStreamEvent.type === 'message_stop') {
          console.log(`message_stop event, final usage:`, usage);
          
          // Parse edit instructions from the AI response
          const editInstructions = parseEditInstructions(fullContent);
          
          // Clean the response content to remove edit instructions for display
          const cleanContent = cleanResponseContent(fullContent);
          
          callbacks.onComplete?.(cleanContent, editInstructions, usage);
          
          console.log(`Streaming complete`);
          console.log(`Usage: ${usage?.input_tokens} input tokens, ${usage?.output_tokens} output tokens`);
          return;
        }
      }
    } catch (error) {
      console.error('Error in streaming chat:', error);
      
      // Handle different error types
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          console.log('Streaming was aborted by user');
          return; // Don't call onError for user-initiated cancellations
        }
        if (error.message.includes('rate_limit') || error.message.includes('429')) {
          callbacks.onError?.("Rate limit exceeded. Please wait a moment and try again.");
          return;
        }
        if (error.message.includes('invalid_api_key') || error.message.includes('401')) {
          callbacks.onError?.("API key is invalid. Please check your API key in settings.");
          return;
        }
        if (error.message.includes('insufficient_quota') || error.message.includes('402')) {
          callbacks.onError?.("Insufficient API quota. Please check your Anthropic account.");
          return;
        }
        if (error.message.includes('network') || error.message.includes('fetch')) {
          callbacks.onError?.("Network error. Please check your internet connection and try again.");
          return;
        }
      }
      
      callbacks.onError?.("Sorry, I encountered an error while processing your request.");
    }
  }

  async checkHealth(apiKey?: string): Promise<boolean> {
    if (!apiKey || !apiKey.trim()) {
      return false;
    }
    
    try {
      const client = this.getAnthropicClient(apiKey);
      // Make a minimal API call to test the key
      await client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }]
      });
      return true;
    } catch {
      return false;
    }
  }

  isConfigured(apiKey?: string): boolean {
    return !!(apiKey && apiKey.trim() && apiKey.startsWith('sk-'));
  }
}

export const chatService = new ChatService();