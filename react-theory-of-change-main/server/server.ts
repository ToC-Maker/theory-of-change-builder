import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// Load environment variables from root directory
dotenv.config({ path: path.resolve(process.cwd(), '..', '.env') });

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increase limit for large graph data

// Initialize Anthropic client
const anthropic = new Anthropic({ 
  apiKey: process.env.CLAUDE_API_KEY || process.env.VITE_CLAUDE_API_KEY 
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// MCP Graph Edit Tool endpoint - returns pure JSON edits
app.post('/api/mcp-graph-edit', async (req, res) => {
  try {
    const { prompt, userIntent, graphSummary, conversationContext } = req.body;

    if (!prompt || !userIntent || !graphSummary) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    console.log(`[${new Date().toISOString()}] MCP Graph Edit Tool called for: "${userIntent.substring(0, 100)}..."`);

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      system: `You are a specialized MCP tool for Theory of Change graph modifications. You must analyze user intent, reason through the required changes, then output ONLY valid JSON.

ANALYSIS PROCESS:
1. Parse the user's request to understand what they want
2. Read the assistant's response to understand what was promised/explained to the user
3. Examine the current graph structure to understand context
4. Reason through the logical steps needed to fulfill what the assistant promised
5. Generate precise edit instructions that match the assistant's explanation

GRAPH STRUCTURE KNOWLEDGE:
- sections: Array of sections (For example: Activities, Outputs, Outcomes, Impacts)
- Each section has columns containing nodes
- CRITICAL PATH STRUCTURE: sections[X].columns[Y].nodes[Z].property
- Nodes require: id, title, text, yPosition, width, color, connections
- connections: Array with targetId, confidence (0-100), evidence, assumptions
- Generate unique IDs using lowercase words with dashes (e.g., "capacity-building", "program-execution", "funding-secured")
- NEVER use timestamp-based IDs like "node_1234567890"
- NEVER change existing node IDs when moving or modifying nodes - always preserve original IDs
- Match existing styling (colors, widths) from the same column

PATH STRUCTURE EXAMPLES:
- "sections.0.columns.0.nodes.0.title" - First node's title in first section, first column
- "sections.0.columns.0.nodes.0.connections" - First node's connections array
- "sections.1.columns.2.nodes" - Nodes array in section 1, column 2
- "sections.0.columns.0.nodes" - Add node to first column of first section
- "sections.0" - Insert new section at beginning (use "insert" type)
- "sections" - Add new section at end (use "push" type)

SECTION INSERTION RULES:
- To add section at beginning: {"type": "insert", "path": "sections.0", "value": {...}}
- To add section at end: {"type": "push", "path": "sections", "value": {...}}
- NEVER use: {"type": "insert", "path": "sections", "value": {...}} - this breaks the array!

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
"add [X] between [A] and [B]" → CRITICAL: First check if there's an empty column between A and B's columns. If YES, add X to that existing column. If NO, create new column between them. Then: 1) Remove A→B connection FROM NODE A ONLY, 2) Add A→X connection TO NODE A, 3) Add X→B connection TO NEW NODE X. NEVER modify node B's connections!
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

COLUMN CREATION FOR "BETWEEN" OPERATIONS:
- If node A is in sections.X.columns.0 and node B is in sections.X.columns.1, then there's NO column between them
- Must INSERT new column at sections.X.columns.1 (which pushes B to columns.2)
- If node A is in sections.X.columns.0 and node B is in sections.X.columns.2, then columns.1 exists between them
- Can ADD node to existing sections.X.columns.1

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

DETAILED ANALYSIS EXAMPLES:
User: "Add training programs to activities" 
Reasoning: User wants new node in Activities section (usually sections.0), determine appropriate column, match existing styling, generate unique ID, place at appropriate yPosition.
Path: "sections.0.columns.0.nodes" (push operation)

User: "Remove connection between A and B" 
Reasoning: Find node A at sections.X.columns.Y.nodes.Z, locate its connections array, filter out ONLY the entry with targetId matching node B's ID, keep all other connections intact.
Path: "sections.X.columns.Y.nodes.Z.connections" (update operation with filtered array)

User: "Add node between research and reports"  
Reasoning: STEP 1: Find research node (e.g., sections.0.columns.1) and reports node (e.g., sections.0.columns.2). STEP 2: Since adjacent columns, INSERT new column at sections.0.columns.2 (pushes reports to columns.3). STEP 3: Add new node with descriptive ID like "data-analysis" to new column. STEP 4: Remove research→reports connection from research node only. STEP 5: Add research→data-analysis connection to research node. STEP 6: Add data-analysis→reports connection to new node.
CORRECT Operations: 1) INSERT column, 2) PUSH new node to new column, 3) UPDATE research connections only
WRONG: Don't copy/move existing nodes, don't change existing IDs, don't touch reports node connections

User: "Delete the chain from A to C"
Reasoning: Find path A→B→C, delete intermediate nodes (B), keep A and C. Delete B node, remove A→B connection, remove B→C connection.
Paths: Delete node operations and connection updates

User: "Move funding to impacts section"
Reasoning: User wants to relocate "funding" node to Impacts section. 1) Delete from current location, 2) Create in Impacts section with same properties.
Paths: Delete operation + Push operation

OUTPUT FORMAT:
After reasoning, output ONLY a valid JSON array of edit instructions:
[{"type": "update|insert|delete|push", "path": "dot.notation.path", "value": any}, ...]

CRITICAL RULES:
- NO explanations in output
- NO natural language 
- NO markdown or code blocks
- Just pure JSON array starting with [ and ending with ]
- If no edits needed, return []
- NEVER modify connections of the target node when adding "between" - only modify source node and new node!
- When adding X between A and B: modify A's connections, create X with connections, NEVER touch B's connections
- NEVER change existing node IDs - always preserve original IDs when moving/modifying nodes
- Use descriptive lowercase-with-dashes IDs for new nodes (e.g., "capacity-building", not "node_123456")

NODE CREATION RULES:
- Always include ALL required properties: id, title, text, yPosition, width, color, connections
- Match column styling from graph summary
- connections must be array (empty [] if no connections)
- yPosition: for "bottom" use max existing yPosition + 180, for "top" use 0
- Generate realistic confidence levels (70-90)

CONNECTION REMOVAL RULES:
- NEVER set connections to [] unless removing ALL connections
- To remove ONE connection: filter existing connections array, keep others
- Example: If node has 3 connections and user says "remove connection to B", result should have 2 connections
- Only set connections to [] if user explicitly says "remove all connections" or "disconnect everything"`,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    console.log(`[${new Date().toISOString()}] MCP tool raw response:`, response.content[0]);

    // Extract and parse the JSON response
    const content = response.content[0];
    if (content.type === 'text') {
      let jsonText = content.text.trim();
      
      // Clean up any potential markdown formatting
      jsonText = jsonText.replace(/```\w*\s*/g, '').replace(/\s*```/g, '');
      
      try {
        const edits = JSON.parse(jsonText);
        
        if (Array.isArray(edits)) {
          console.log(`[${new Date().toISOString()}] MCP tool generated ${edits.length} edit instructions`);
          res.json(edits);
        } else {
          console.error('MCP tool returned non-array:', edits);
          res.json([]);
        }
      } catch (parseError) {
        console.error('Failed to parse MCP tool JSON:', parseError, 'Raw text:', jsonText);
        res.json([]);
      }
    } else {
      console.error('MCP tool returned non-text response');
      res.json([]);
    }

  } catch (error) {
    console.error('[MCP Tool Error]:', error);
    res.status(500).json({ error: 'MCP tool failed', details: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// Chat endpoint with streaming support
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, currentGraphData, systemPrompt, stream } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    if (!systemPrompt) {
      return res.status(400).json({ error: 'System prompt is required' });
    }

    console.log(`[${new Date().toISOString()}] Received chat request with ${messages.length} messages, streaming: ${stream}`);

    if (stream) {
      // Set up Server-Sent Events
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });

      let fullContent = '';
      let usage = null;

      try {
        const stream = await anthropic.messages.create({
          model: "claude-sonnet-4-20250514",
          max_tokens: 8000,
          system: systemPrompt,
          messages: messages.map(msg => ({
            role: msg.role,
            content: msg.content
          })),
          stream: true
        });

        for await (const messageStreamEvent of stream) {
          if (messageStreamEvent.type === 'message_start') {
            // Capture usage from the initial message
            if (messageStreamEvent.message.usage) {
              usage = messageStreamEvent.message.usage;
              console.log(`[${new Date().toISOString()}] Usage captured from message_start:`, usage);
            }
          } else if (messageStreamEvent.type === 'content_block_delta') {
            if (messageStreamEvent.delta.type === 'text_delta') {
              const chunk = messageStreamEvent.delta.text;
              fullContent += chunk;
              
              // Send the text chunk
              res.write(`data: ${JSON.stringify({ 
                type: 'content', 
                chunk: chunk,
                content: fullContent 
              })}\n\n`);
            }
          } else if (messageStreamEvent.type === 'message_delta') {
            // Update usage if provided in delta (for final token counts)
            if (messageStreamEvent.delta.usage) {
              usage = { ...usage, ...messageStreamEvent.delta.usage };
              console.log(`[${new Date().toISOString()}] Usage updated from message_delta:`, usage);
            }
          } else if (messageStreamEvent.type === 'message_stop') {
            console.log(`[${new Date().toISOString()}] message_stop event, final usage:`, usage);
            
            // Send final message with usage
            res.write(`data: ${JSON.stringify({ 
              type: 'done', 
              content: [{ type: 'text', text: fullContent }],
              usage: usage
            })}\n\n`);
            
            console.log(`[${new Date().toISOString()}] Streaming complete`);
            console.log(`Usage: ${usage?.input_tokens} input tokens, ${usage?.output_tokens} output tokens`);
            break;
          }
        }
      } catch (streamError) {
        console.error('[Streaming Error]:', streamError);
        res.write(`data: ${JSON.stringify({ 
          type: 'error', 
          error: streamError instanceof Error ? streamError.message : 'Unknown streaming error'
        })}\n\n`);
      }

      res.end();
    } else {
      // Original non-streaming response
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 8000,
        system: systemPrompt,
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content
        }))
      });

      console.log(`[${new Date().toISOString()}] Successfully received response from Anthropic API`);
      console.log(`Usage: ${response.usage.input_tokens} input tokens, ${response.usage.output_tokens} output tokens`);

      res.json(response);
    }
  } catch (error) {
    console.error('[API Error]:', error);
    
    if (error instanceof Error) {
      // Handle specific Anthropic API errors
      if (error.message.includes('rate_limit')) {
        return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
      }
      if (error.message.includes('invalid_api_key')) {
        return res.status(401).json({ error: 'Invalid API key' });
      }
      if (error.message.includes('insufficient_quota')) {
        return res.status(402).json({ error: 'Insufficient API quota' });
      }
    }
    
    res.status(500).json({ 
      error: 'Anthropic API call failed',
      details: process.env.NODE_ENV === 'development' ? error : undefined
    });
  }
});

// Error handling middleware
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('[Server Error]:', error);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`✅ API endpoints available at http://localhost:${PORT}/api/`);
  
  // Check if API key is configured
  if (!process.env.CLAUDE_API_KEY && !process.env.VITE_CLAUDE_API_KEY) {
    console.warn('⚠️  Warning: No Claude API key found in environment variables');
    console.warn('   Please set CLAUDE_API_KEY in your .env file');
  } else {
    console.log('✅ Claude API key configured');
  }
});

export default app;