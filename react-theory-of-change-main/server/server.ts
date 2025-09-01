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

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, currentGraphData, systemPrompt } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Invalid messages format' });
    }

    if (!systemPrompt) {
      return res.status(400).json({ error: 'System prompt is required' });
    }

    console.log(`[${new Date().toISOString()}] Received chat request with ${messages.length} messages`);

    const response = await anthropic.messages.create({
      model: "claude-3-5-haiku-latest",
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