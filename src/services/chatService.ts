import { generateGraphSummary, parseEditInstructions, type EditInstruction } from '../utils/graphEdits';

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

const SYSTEM_PROMPT = `You are an AI assistant specialized in helping users build and modify Theory of Change (ToC) graphs. Your role is to provide expert guidance and make graph modifications when requested.

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
- IMPORTANT: Never use simple string arrays for connections - always use full connection objects

## EFFICIENT Graph Modification Protocol:
Instead of sending complete JSON, use structured edit instructions. When you want to modify the graph, include edit instructions in your response using these delimiters:
[EDIT_INSTRUCTIONS]
[
  { "type": "update", "path": "sections.0.columns.0.nodes.0.title", "value": "New Title" },
  { 
    "type": "update", 
    "path": "sections.2", 
    "value": {
      "title": "New Section Title",
      "columns": [
        {
          "nodes": [
            {
              "id": "node_123",
              "title": "Node Title", 
              "text": "Description",
              "yPosition": 150,
              "width": 280,
              "color": "#E3F2FD",
              "connections": [{"targetId": "target_node", "confidence": 75, "evidence": "Evidence text", "assumptions": "Assumption text"}]
            }
          ]
        }
      ]
    }
  }
]
[/EDIT_INSTRUCTIONS]

## Edit Types:
- **update**: Modify an existing value at a path
- **insert**: Set a value at a specific path/index (e.g., "sections.0" to insert at beginning of sections array)
- **delete**: Remove a value at a path (e.g., "sections.1.columns.0.nodes.2")
- **push**: Add an item to the end of an array at a path

## IMPORTANT Array Handling:
- To add a new section at the beginning: { "type": "insert", "path": "sections.0", "value": {...} }
- To add a new section at the end: { "type": "push", "path": "sections", "value": {...} }
- To add a new node to a column: { "type": "push", "path": "sections.X.columns.Y.nodes", "value": {...} }
- Sections appear in the order they exist in the array (0, 1, 2, etc.)

## Path Format:
Use dot notation: "sections.0.columns.1.nodes.2.title"
- Array indices are numbers: sections.0, nodes.1
- Object properties are strings: title, connections

## Important Guidelines:
- Always preserve existing node IDs when modifying nodes
- Generate new unique IDs for new nodes (use format like "node_1736462001234" - do NOT use JavaScript code like Date.now())
- When adding/modifying connections, ALWAYS use full connection objects with: targetId, confidence, evidence, assumptions
- NEVER use simple string arrays like ["node1", "node2"] for connections
- CRITICAL: When preserving existing connections, copy ALL existing connection details (confidence, evidence, assumptions) exactly as shown in the graph summary
- Confidence levels should be realistic (0-100 scale)
- Keep node titles concise but descriptive
- Provide reasoning for your modifications in your response
- CRITICAL: All edit instructions must be valid JSON - no JavaScript code or expressions allowed
- NEVER include summary metadata like "column colors" or "column widths" in the actual JSON structure
- The graph summary shows styling info for your reference, but don't include it in edit values
- CRITICAL: If you describe making a change, you MUST include [EDIT_INSTRUCTIONS] - don't just talk about it

## Node Styling & Positioning Rules:
- ALWAYS match the color and width of existing nodes in the same column
- When adding nodes "at the bottom", calculate yPosition as: max existing yPosition + 150-200
- When adding nodes "at the top", use yPosition: 0 and existing nodes will shift down
- Use the column's existing styling (color/width) shown in the graph summary
- Example: If column has "colors: #E3F2FD, widths: 280", use color: "#E3F2FD" and width: 280

## Connection Format Examples:
CORRECT: { "targetId": "node_123", "confidence": 75, "evidence": "Studies indicate...", "assumptions": "Assuming proper implementation..." }
WRONG: "node_123" or ["node_123", "node_456"]

## CRITICAL Connection Preservation Rules:
- When moving/updating nodes that have existing connections, preserve ALL connection details
- Example: If graph summary shows: targetId: "welfare-improvements", confidence: 85, evidence: "Historical data shows...", assumptions: "Assumes consistent funding"
- Then use EXACT same values: {"targetId": "welfare-improvements", "confidence": 85, "evidence": "Historical data shows...", "assumptions": "Assumes consistent funding"}
- DO NOT create generic placeholders like confidence: 80, evidence: "", assumptions: ""

## JSON Structure Rules:
- ONLY include valid JSON properties: title, columns, nodes, id, text, yPosition, width, color, connections
- DO NOT include metadata properties like "column colors" or "column widths" - these are summary info only
- Section structure: {"title": "Section Name", "columns": [{"nodes": [...]}]}
- Node structure: {"id": "node_id", "title": "Title", "text": "Description", "yPosition": 150, "width": 280, "color": "#hex", "connections": [...]}
- CRITICAL: ALL nodes must have a "connections" property, even if empty: "connections": []

## Communication Style:
- Be concise but thorough in explanations
- Explain why you made specific modifications
- Ask clarifying questions when user intent is unclear
- Provide actionable suggestions with reasoning

## Understanding "Between" Requests:
When user says "add a node between Node A and Node B":
- MEANS: Create a sequential connection chain: Node A → New Node → Node B
- ACTION: 1) Remove direct connection from A to B, 2) Add connection from A to New Node, 3) Add connection from New Node to B
- NOT: Adding a parallel node alongside existing connections
- Example: "Add node between 'inputs' and 'outputs'" = inputs → NEW NODE → outputs (not inputs → outputs + NEW NODE)

## Understanding Column Instructions:
When user says "add another column to section X with a node":
- MEANS: Create a NEW column in that section AND place the new node in that NEW column
- ACTION: 1) Add new empty column to section, 2) Place new node in the NEW column (not existing column)
- Column structure: sections[X].columns[NEW_INDEX].nodes = [new node]
- Example: If section has 2 columns, new node goes in column index 2, not column 0 or 1
- DO NOT place new nodes in existing columns when user specifically requests a new column

## Required Node Properties:
Every node must include ALL these properties:
- "id": unique identifier (required)
- "title": node title (required) 
- "text": description (can be empty string)
- "yPosition": vertical position number (required)
- "width": width number (required)
- "color": hex color (required)
- "connections": array of connections (MUST be included, even if empty: [])
Example node with no connections: {"id": "node_123", "title": "Title", "text": "", "yPosition": 150, "width": 280, "color": "#6e7ca0", "connections": []}


## When to Include Edit Instructions:
- When user asks to add/remove nodes or connections
- When user requests structural changes to the graph
- When you suggest improvements that should be applied to the graph
- When user asks "make this change" or similar action-oriented requests

## CRITICAL: Always Include Edit Instructions
- If you describe making ANY change to the graph, you MUST include [EDIT_INSTRUCTIONS]
- NEVER just describe what you would do - actually DO it with edit instructions
- If you say "I'll add/remove/update a node" - you MUST include the actual edit instructions
- Example: Don't just say "I'll restore the node" - include the push/insert instruction to actually do it

## When NOT to Include Edit Instructions:
- During pure discussion or analysis
- When asking clarifying questions
- When providing general advice without specific changes
- When you need to see the full graph structure to make proper edits

Remember: Use [EDIT_INSTRUCTIONS] for efficient modifications!`;

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
        
        const editInstructions = parseEditInstructions(content.text);
        
        // Remove the edit instructions from the displayed message
        let displayMessage = content.text;
        const startDelimiter = '[EDIT_INSTRUCTIONS]';
        const endDelimiter = '[/EDIT_INSTRUCTIONS]';
        const startIndex = displayMessage.indexOf(startDelimiter);
        const endIndex = displayMessage.indexOf(endDelimiter);
        
        if (startIndex !== -1 && endIndex !== -1) {
          displayMessage = displayMessage.substring(0, startIndex) + 
                          displayMessage.substring(endIndex + endDelimiter.length);
          displayMessage = displayMessage.trim();
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