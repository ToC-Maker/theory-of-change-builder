import type { EditInstruction } from '../utils/graphEdits';

// Simple wrapper around the server-side MCP tool endpoint
export async function generateGraphEdits(
  userIntent: string,
  graphData: string,
  conversationContext: string
): Promise<EditInstruction[]> {
  
  try {
    const response = await fetch('/api/mcp-graph-edit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: `USER REQUEST: "${userIntent}"

CURRENT GRAPH DATA:
${graphData}

CONVERSATION CONTEXT:
${conversationContext}`,
        userIntent,
        graphSummary: graphData,
        conversationContext
      })
    });

    if (!response.ok) {
      throw new Error(`MCP tool failed: ${response.status}`);
    }

    const result = await response.json();
    
    // Ensure we get a valid array of edit instructions
    if (Array.isArray(result)) {
      return result as EditInstruction[];
    } else {
      console.error('MCP tool returned non-array result:', result);
      return [];
    }
    
  } catch (error) {
    console.error('Error calling MCP tool:', error);
    return [];
  }
}

// Helper function to check if a user message requires graph modifications
export function requiresGraphModification(message: string): boolean {
  const modificationKeywords = [
    'add', 'create', 'insert', 'put', 'make', 'new',
    'remove', 'delete', 'get rid', 'take out', 'eliminate',
    'connect', 'link', 'wire', 'attach', 'point to',
    'disconnect', 'unlink', 'remove connection', 'break connection',
    'move', 'relocate', 'transfer', 'change', 'rename', 'update',
    'between', 'column', 'section', 'undo', 'redo'
  ];
  
  const lowerMessage = message.toLowerCase();
  return modificationKeywords.some(keyword => lowerMessage.includes(keyword));
}