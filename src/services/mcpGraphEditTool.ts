import type { EditInstruction } from '../utils/graphEdits';

// MCP tool function that generates graph edit instructions
// This tool can only output valid JSON, no natural language
export async function generateGraphEdits(
  userIntent: string,
  graphSummary: string,
  conversationContext: string
): Promise<EditInstruction[]> {
  
  const toolPrompt = `ANALYSIS TASK:
Analyze this user request and current graph state, then generate edit instructions.

USER REQUEST: "${userIntent}"

CURRENT GRAPH STRUCTURE:
${graphSummary}

CONVERSATION CONTEXT:
${conversationContext}

REASONING PROCESS (think through this, but don't output reasoning):
1. What exactly is the user asking for?
2. Which section/column/node are they referring to?
3. What changes need to be made to accomplish this?
4. What are the step-by-step edit instructions needed?

EXTENSIVE PATTERN RECOGNITION EXAMPLES:

=== ADDING NODES ===
"add [X] to [section]" → push new node to appropriate section/column
"create a new node called [X]" → push new node to first available location
"insert [X] in activities" → push to Activities section
"put a [X] node in outcomes" → push to Outcomes section
"I need a [X] in the first column" → push to sections.0.columns.0.nodes
"add [X] to the top" → push with yPosition: 0
"add [X] to the bottom" → push with yPosition: max existing + 180
"create [X] after [Y]" → find Y's yPosition, add new node with yPosition + 180
"make a new [X]" → push new node to appropriate section based on context

=== ADDING NODES BETWEEN EXISTING ONES ===
"add [X] between [A] and [B]" → create A→X→B chain (3 operations: remove A→B, add A→X, add X→B)
"insert [X] between [A] and [B]" → same as above
"put [X] in the middle of [A] and [B]" → same as above
"create [X] linking [A] to [B]" → same as above
"add a node between [A] and [B]" → same as above
"I want [X] to go from [A] to [B]" → same as above

=== DELETING NODES ===
"remove [X]" → delete node and clean up connections pointing to it
"delete the [X] node" → same as above
"get rid of [X]" → same as above
"take out [X]" → same as above
"eliminate [X]" → same as above
"remove that [X]" → same as above

=== DELETING CHAINS/GROUPS ===
"delete the chain of nodes" → identify connected sequence, delete multiple nodes
"remove the whole chain from [X] to [Y]" → delete all nodes in the path
"delete everything between [X] and [Y]" → delete intermediate nodes, keep X and Y
"clear out the connection path" → delete intermediate nodes in a chain
"remove the sequence" → delete multiple connected nodes

=== CONNECTING NODES ===
"connect [A] to [B]" → add connection from A to B
"link [A] to [B]" → same as above
"make [A] point to [B]" → same as above
"[A] should lead to [B]" → same as above
"create connection from [A] to [B]" → same as above
"[A] goes to [B]" → same as above
"wire [A] to [B]" → same as above
"attach [A] to [B]" → same as above

=== DISCONNECTING NODES ===
"disconnect [A] from [B]" → remove ONLY the A→B connection, keep others
"remove connection between [A] and [B]" → same as above
"unlink [A] from [B]" → same as above
"break the connection from [A] to [B]" → same as above
"[A] should not connect to [B]" → same as above
"remove the link between [A] and [B]" → same as above
"disconnect [A] and [B]" → same as above
"cut the connection" → same as above

=== DISCONNECTING ALL ===
"disconnect [A] from everything" → set A's connections to []
"remove all connections from [A]" → same as above
"[A] should not connect to anything" → same as above
"clear [A]'s connections" → same as above
"unlink [A] completely" → same as above

=== MOVING NODES ===
"move [X] to [section]" → delete from current location, push to new section
"relocate [X]" → same as above
"put [X] in activities instead" → same as above
"transfer [X] to outcomes" → same as above
"[X] belongs in impacts" → same as above

=== COLUMN OPERATIONS ===
"add a new column" → insert new column structure
"create another column in [section]" → insert column in specific section
"I need more space in activities" → add column to Activities section
"make a new column" → insert new column structure

=== SECTION OPERATIONS ===
"add a new section" → push new section to sections array
"create [X] section before activities" → insert at sections.0
"I need a [X] section at the beginning" → insert at sections.0
"add [X] section at the end" → push to sections array
"insert [X] section before [Y]" → find Y section index, insert before it

=== EDITING NODE PROPERTIES ===
"change [X] title to [Y]" → update sections.X.columns.Y.nodes.Z.title
"rename [X] to [Y]" → same as above
"update [X] text" → update sections.X.columns.Y.nodes.Z.text
"modify [X] description" → same as above

=== BATCH OPERATIONS ===
"connect [A] to all outputs" → multiple connection operations
"disconnect everything from [A]" → clear A's connections and remove A from other nodes' connections
"remove all nodes in [section]" → delete multiple nodes
"clear the activities section" → delete all nodes in Activities

CRITICAL PATH STRUCTURE:
Graph structure is: sections[X].columns[Y].nodes[Z].property
- ALWAYS include "columns" in paths: sections.0.columns.0.nodes.0.connections
- NEVER use: sections.0.nodes.0.connections (missing columns!)

DETAILED ANALYSIS EXAMPLES:
"Add training programs to activities" → 
  Analysis: User wants new node in Activities section (usually sections.0)
  Action: Create node with title "Training Programs", push to first column
  Path: "sections.0.columns.0.nodes" (push operation)

"Remove the marketing node" → 
  Analysis: Find node with title containing "marketing", delete it
  Action: Delete node and clean up any connections pointing to it
  Path: "sections.X.columns.Y.nodes.Z" (delete operation)

"Connect outreach to awareness" → 
  Analysis: Find "outreach" node, add connection to "awareness" node's ID
  Action: Push new connection object to outreach node's connections array
  Path: "sections.X.columns.Y.nodes.Z.connections" (push operation)

"Remove connection from A to B" → 
  Analysis: Find node A, filter its connections to remove ONLY targetId="B"
  Action: Update connections array with filtered version (keep other connections!)
  Path: "sections.X.columns.Y.nodes.Z.connections" (update operation)

"Add a node between research and reports" →
  Analysis: Create research→new_node→reports chain
  Action: 1) Remove research→reports connection, 2) Add research→new_node, 3) Add new_node→reports
  Paths: Multiple operations on connections arrays

"Delete the chain from A to C" →
  Analysis: Find path A→B→C, delete intermediate nodes (B), keep A and C
  Action: Delete B node, remove A→B connection, remove B→C connection
  Paths: Delete node operations and connection updates

"Move funding to impacts section" →
  Analysis: User wants to relocate "funding" node to Impacts section
  Action: 1) Delete from current location, 2) Create in Impacts section with same properties
  Paths: Delete operation + Push operation

CRITICAL RULES:
- When removing connections, PRESERVE existing connections to other nodes!
- When adding "between" nodes, create proper chain: A→New→B (remove A→B first)
- When deleting chains, be careful about what "chain" means (intermediate nodes vs entire sequence)
- Always match existing styling (colors, widths) from the target column
- Generate unique IDs with timestamp: "node_" + Date.now() + "_" + Math.random()

Remember: Output ONLY the JSON array result of your analysis.`;

  try {
    const response = a
    wait fetch('/api/mcp-graph-edit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: toolPrompt,
        userIntent,
        graphSummary,
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
    } else if (result.edits && Array.isArray(result.edits)) {
      return result.edits as EditInstruction[];
    } else {
      console.error('MCP tool returned invalid format:', result);
      return [];
    }
    
  } catch (error) {
    console.error('Error calling MCP graph edit tool:', error);
    return [];
  }
}

// Helper function to determine if user intent requires graph modifications
export function requiresGraphModification(userMessage: string): boolean {
  const modificationKeywords = [
    'add', 'create', 'insert', 'new',
    'remove', 'delete', 'take out',
    'update', 'change', 'modify', 'edit',
    'move', 'connect', 'disconnect',
    'between', 'column', 'node', 'section'
  ];
  
  const lowerMessage = userMessage.toLowerCase();
  return modificationKeywords.some(keyword => lowerMessage.includes(keyword));
}