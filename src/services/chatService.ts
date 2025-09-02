import { generateGraphSummary, type EditInstruction } from '../utils/graphEdits';
import { generateGraphEdits, requiresGraphModification } from './mcpGraphEditTool';

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

const SYSTEM_PROMPT = `You are an AI assistant specialized in helping users build and modify Theory of Change (ToC) graphs. Your role is to provide expert guidance on graph development and analysis.

## Core Responsibilities:
1. **Theory of Change Development**: Help users create logical, evidence-based pathways from activities to long-term outcomes
2. **Graph Structure Analysis**: Analyze existing ToC graphs for logical flow, completeness, and clarity
3. **Node and Connection Suggestions**: Recommend new nodes, connections, or modifications to improve the theory
4. **Strategic Guidance**: Provide insights on intervention strategies, assumptions, and potential risks

## Graph Data Structure:
You will receive a SUMMARY of the current graph (not the full JSON to save tokens). The structure includes:
- sections: Array of sections (typically Activities, Outputs, Outcomes, Impacts)
- Each section has columns containing nodes
- Nodes have: id, title, text, connections, yPosition, width, color
- connections: Array of full connection objects with: targetId, confidence (0-100), evidence, assumptions

## Communication Style:
- Be concise but thorough in explanations
- Explain why you recommend specific modifications
- Ask clarifying questions when user intent is unclear
- Provide actionable suggestions with reasoning
- Focus on the strategic and theoretical aspects of the Theory of Change

## Understanding User Intent:
- When users request modifications, explain the reasoning behind your suggestions
- For "between" requests: explain creating sequential connection chains (A → New → B)
- For column requests: clarify creating new columns vs. adding to existing ones
- Always consider the logical flow and evidence base of proposed changes

## Important Notes:
- Graph modifications will be handled automatically when you recommend changes
- Focus on providing clear explanations and strategic guidance
- You don't need to specify technical implementation details
- Emphasize the theory and logic behind suggested modifications

Your expertise should guide users in creating robust, evidence-based Theories of Change that clearly show how activities lead to desired outcomes.`;

export { SYSTEM_PROMPT };


class ChatService {
  private baseURL = '/api'; // Vite will proxy this to backend

  async sendMessage(messages: ChatMessage[], currentGraphData?: any): Promise<ChatResponse> {
    try {
      // Prepare messages with graph summary for the last user message
      const processedMessages = messages.map((msg, index) => {
        let content = msg.content;
        
        // Append current graph summary to user messages (much smaller than full JSON)
        if (msg.role === 'user' && currentGraphData && index === messages.length - 1) {
          const graphSummary = generateGraphSummary(currentGraphData);
          console.log('=== GRAPH SUMMARY SENT TO AI ===');
          console.log(graphSummary);
          console.log('=== END GRAPH SUMMARY ===');
          content += `\n\n[CURRENT_GRAPH_SUMMARY]\n${graphSummary}\n[/CURRENT_GRAPH_SUMMARY]`;
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
        
        const displayMessage = content.text;
        let editInstructions: EditInstruction[] | null = null;
        
        // Check if the user message requires graph modifications
        const lastUserMessage = messages[messages.length - 1]?.content || '';
        if (requiresGraphModification(lastUserMessage) && currentGraphData) {
          console.log('=== CALLING MCP GRAPH EDIT TOOL ===');
          
          // Build conversation context from recent messages
          const conversationContext = messages
            .slice(-3) // Last 3 messages for context
            .map(msg => `${msg.role}: ${msg.content}`)
            .join('\n');
          
          try {
            editInstructions = await generateGraphEdits(
              lastUserMessage,
              generateGraphSummary(currentGraphData),
              conversationContext
            );
            
            if (editInstructions && editInstructions.length > 0) {
              console.log('=== MCP GENERATED EDITS ===');
              console.log(JSON.stringify(editInstructions, null, 2));
              console.log('=== END MCP EDITS ===');
            }
          } catch (error) {
            console.error('Error calling MCP graph edit tool:', error);
          }
        }
        
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