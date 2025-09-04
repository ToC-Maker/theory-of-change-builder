import { type EditInstruction, parseEditInstructions, cleanResponseContent } from '../utils/graphEdits';

// Import the system prompt from external file
import systemPromptContent from '../prompts/chatSystemPrompt.md?raw';

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
  private baseURL = '/api'; // Vite will proxy this to backend

  async sendMessage(messages: ChatMessage[], currentGraphData?: any): Promise<ChatResponse> {
    try {
      // Prepare messages with full graph JSON for the last user message
      const processedMessages = messages.map((msg, index) => {
        let content = msg.content;
        
        // Append current graph JSON to user messages
        if (msg.role === 'user' && currentGraphData && index === messages.length - 1) {
          console.log('=== GRAPH JSON SENT TO AI ===');
          console.log('Graph data size:', JSON.stringify(currentGraphData).length, 'characters');
          console.log('=== END GRAPH JSON ===');
          content += `\n\n[CURRENT_GRAPH_DATA]\n${JSON.stringify(currentGraphData, null, 2)}\n[/CURRENT_GRAPH_DATA]`;
        }
        
        return {
          role: msg.role as 'user' | 'assistant',
          content: content
        };
      });

      console.log(`Sending ${processedMessages.length} messages to backend API`);

      const response = await fetch(`${this.baseURL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: processedMessages,
          currentGraphData,
          systemPrompt: SYSTEM_PROMPT
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      // Extract the text content from the response
      const content = data.content[0];
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
            input_tokens: data.usage?.input_tokens ?? 0,
            output_tokens: data.usage?.output_tokens ?? 0,
            total_tokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0)
          }
        };
      } else {
        return {
          message: "Received non-text response",
          error: "INVALID_RESPONSE_TYPE"
        };
      }
    } catch (error) {
      console.error('Error calling backend API:', error);
      
      // Handle different error types
      if (error instanceof Error) {
        if (error.message.includes('Rate limit')) {
          return {
            message: "Rate limit exceeded. Please wait a moment and try again.",
            error: "RATE_LIMIT"
          };
        }
        if (error.message.includes('Invalid API key')) {
          return {
            message: "API key is invalid. Please check your configuration.",
            error: "INVALID_API_KEY"
          };
        }
        if (error.message.includes('fetch')) {
          return {
            message: "Unable to connect to the backend server. Please ensure the server is running.",
            error: "BACKEND_UNAVAILABLE"
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
    signal?: AbortSignal
  ): Promise<void> {
    try {
      // Prepare messages with full graph JSON for the last user message
      const processedMessages = messages.map((msg, index) => {
        let content = msg.content;
        
        // Append current graph JSON to user messages
        if (msg.role === 'user' && currentGraphData && index === messages.length - 1) {
          console.log('=== GRAPH JSON SENT TO AI ===');
          console.log('Graph data size:', JSON.stringify(currentGraphData).length, 'characters');
          console.log('=== END GRAPH JSON ===');
          content += `\n\n[CURRENT_GRAPH_DATA]\n${JSON.stringify(currentGraphData, null, 2)}\n[/CURRENT_GRAPH_DATA]`;
        }
        
        return {
          role: msg.role as 'user' | 'assistant',
          content: content
        };
      });

      console.log(`Sending ${processedMessages.length} messages to backend API (streaming)`);

      const response = await fetch(`${this.baseURL}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: processedMessages,
          currentGraphData,
          systemPrompt: SYSTEM_PROMPT,
          stream: true
        }),
        signal: signal
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error('No response body for streaming');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';

      try {
        while (true) {
          const { value, done } = await reader.read();
          
          if (done) break;
          
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                
                if (data.type === 'content') {
                  fullContent = data.content;
                  // Clean the streaming content to hide edit instructions during typing
                  const cleanStreamingContent = cleanResponseContent(fullContent);
                  callbacks.onContent?.(data.chunk, cleanStreamingContent);
                } else if (data.type === 'done') {
                  console.log('=== STREAMING DONE EVENT ===');
                  console.log('Usage data received:', data.usage);
                  console.log('=== END STREAMING DONE ===');
                  
                  // Parse edit instructions from the AI response
                  const editInstructions = parseEditInstructions(fullContent);
                  
                  // Clean the response content to remove edit instructions for display
                  const cleanContent = cleanResponseContent(fullContent);
                  
                  callbacks.onComplete?.(cleanContent, editInstructions, data.usage);
                  return;
                } else if (data.type === 'error') {
                  callbacks.onError?.(data.error);
                  return;
                }
              } catch (parseError) {
                console.error('Error parsing SSE data:', parseError, line);
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      console.error('Error in streaming chat:', error);
      
      // Handle different error types
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          console.log('Streaming was aborted by user');
          return; // Don't call onError for user-initiated cancellations
        }
        if (error.message.includes('Rate limit')) {
          callbacks.onError?.("Rate limit exceeded. Please wait a moment and try again.");
          return;
        }
        if (error.message.includes('Invalid API key')) {
          callbacks.onError?.("API key is invalid. Please check your configuration.");
          return;
        }
        if (error.message.includes('fetch')) {
          callbacks.onError?.("Unable to connect to the backend server. Please ensure the server is running.");
          return;
        }
      }
      
      callbacks.onError?.("Sorry, I encountered an error while processing your request.");
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseURL}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  isConfigured(): boolean {
    // Always return true since backend handles the API key
    return true;
  }
}

export const chatService = new ChatService();