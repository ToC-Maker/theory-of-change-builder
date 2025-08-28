import Anthropic from "@anthropic-ai/sdk";

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ChatResponse {
  message: string;
  error?: string;
  graphUpdate?: any;
}

const SYSTEM_PROMPT = `You are an AI assistant specialized in helping users build and modify Theory of Change (ToC) graphs. Your role is to provide expert guidance and make graph modifications when requested.

## Core Responsibilities:
1. **Theory of Change Development**: Help users create logical, evidence-based pathways from activities to long-term outcomes
2. **Graph Structure Analysis**: Analyze existing ToC graphs for logical flow, completeness, and clarity
3. **Node and Connection Suggestions**: Recommend new nodes, connections, or modifications to improve the theory
4. **Strategic Guidance**: Provide insights on intervention strategies, assumptions, and potential risks

## Graph Data Structure:
The current graph will be provided in each user message between [CURRENT_GRAPH_JSON] and [/CURRENT_GRAPH_JSON] tags. The structure includes:
- sections: Array of sections (typically Activities, Outputs, Outcomes, Impacts)
- Each section has columns containing nodes
- Nodes have: id, title, text, connections, yPosition, width, color
- Connections have: targetId, confidence (0-100), evidence, assumptions

## Graph Modification Protocol:
When you want to modify the graph, include the complete updated JSON in your response using these delimiters:
[UPDATED_GRAPH_JSON]
{complete updated graph JSON here}
[/UPDATED_GRAPH_JSON]

## Important Guidelines:
- Always preserve existing node IDs when modifying nodes
- Generate new unique IDs for new nodes (use timestamp-based IDs)
- Maintain proper section structure (Activities → Outputs → Outcomes → Impacts)
- When adding connections, ensure targetId references exist
- Confidence levels should be realistic (0-100 scale)
- Keep node titles concise but descriptive
- Provide reasoning for your modifications in your response

## Communication Style:
- Be concise but thorough in explanations
- Explain why you made specific modifications
- Ask clarifying questions when user intent is unclear
- Provide actionable suggestions with reasoning

## When to Include Graph Updates:
- When user asks to add/remove nodes or connections
- When user requests structural changes to the graph
- When you suggest improvements that should be applied to the graph
- When user asks "make this change" or similar action-oriented requests

## When NOT to Include Graph Updates:
- During pure discussion or analysis
- When asking clarifying questions
- When providing general advice without specific changes

Remember: Be proactive about including [UPDATED_GRAPH_JSON] when users request changes!`;

export { SYSTEM_PROMPT };

function parseGraphUpdate(text: string): any | null {
  console.log('parseGraphUpdate called with text length:', text.length);
  
  const startDelimiter = '[UPDATED_GRAPH_JSON]';
  const endDelimiter = '[/UPDATED_GRAPH_JSON]';
  
  const startIndex = text.indexOf(startDelimiter);
  const endIndex = text.indexOf(endDelimiter);
  
  console.log('Delimiter positions - start:', startIndex, 'end:', endIndex);
  
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    console.log('No valid delimiters found in response');
    return null;
  }
  
  const jsonText = text.substring(startIndex + startDelimiter.length, endIndex).trim();
  console.log('Extracted JSON text length:', jsonText.length);
  console.log('=== EXTRACTED JSON TEXT ===');
  console.log(jsonText);
  console.log('=== END EXTRACTED JSON ===');
  
  try {
    const parsedData = JSON.parse(jsonText);
    console.log('Successfully parsed graph update:', parsedData);
    return parsedData;
  } catch (error) {
    console.error('Failed to parse graph update JSON:', error);
    console.log('JSON text that failed to parse:', jsonText);
    return null;
  }
}

class ChatService {
  private anthropic: Anthropic | null = null;

  constructor() {
    try {
      const apiKey = import.meta.env.VITE_CLAUDE_API_KEY;
      if (apiKey) {
        this.anthropic = new Anthropic({
          apiKey: apiKey,
          dangerouslyAllowBrowser: true
        });
      }
    } catch (error) {
      console.error('Failed to initialize Anthropic client:', error);
    }
  }

  async sendMessage(messages: ChatMessage[], currentGraphData?: any): Promise<ChatResponse> {
    if (!this.anthropic) {
      return {
        message: "API is not configured. Please check your API key.",
        error: "API_NOT_CONFIGURED"
      };
    }

    try {
      const anthropicMessages = messages.map((msg, index) => {
        let content = msg.content;
        
        // Append current graph JSON to user messages (but not the first system message)
        if (msg.role === 'user' && currentGraphData && index === messages.length - 1) {
          content += `\n\n[CURRENT_GRAPH_JSON]\n${JSON.stringify(currentGraphData, null, 2)}\n[/CURRENT_GRAPH_JSON]`;
        }
        
        return {
          role: msg.role as 'user' | 'assistant',
          content: content
        };
      });

      const response = await this.anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: anthropicMessages
      });

      const content = response.content[0];
      if (content.type === 'text') {
        console.log('=== COMPLETE AI RESPONSE ===');
        console.log(content.text);
        console.log('=== END AI RESPONSE ===');
        
        const graphUpdate = parseGraphUpdate(content.text);
        
        // Remove the graph JSON from the displayed message
        let displayMessage = content.text;
        const startDelimiter = '[UPDATED_GRAPH_JSON]';
        const endDelimiter = '[/UPDATED_GRAPH_JSON]';
        const startIndex = displayMessage.indexOf(startDelimiter);
        const endIndex = displayMessage.indexOf(endDelimiter);
        
        if (startIndex !== -1 && endIndex !== -1) {
          displayMessage = displayMessage.substring(0, startIndex) + 
                          displayMessage.substring(endIndex + endDelimiter.length);
          displayMessage = displayMessage.trim();
        }
        
        return {
          message: displayMessage,
          graphUpdate: graphUpdate
        };
      } else {
        return {
          message: "Received non-text response",
          error: "INVALID_RESPONSE_TYPE"
        };
      }
    } catch (error) {
      console.error('Error calling Anthropic API:', error);
      return {
        message: "Sorry, I encountered an error while processing your request.",
        error: "API_ERROR"
      };
    }
  }

  isConfigured(): boolean {
    return this.anthropic !== null;
  }
}

export const chatService = new ChatService();