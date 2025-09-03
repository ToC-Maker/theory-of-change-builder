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