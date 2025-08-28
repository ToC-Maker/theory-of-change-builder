# AI Assistant Setup Instructions

The "failed to fetch" error occurs because browsers can't directly call the Claude API due to CORS restrictions. I've created a simple proxy server to fix this.

## Quick Setup:

### 1. Install proxy server dependencies:
```bash
cd server
npm install
```

### 2. Start the proxy server:
```bash
npm start
```

### 3. In a new terminal, start your main app:
```bash
cd ..
npm run dev
```

## What this does:
- The proxy server runs on `localhost:3001`
- Your React app runs on `localhost:5173` (or similar)
- Vite automatically proxies `/api/*` requests to the proxy server
- The proxy server makes the actual Claude API calls (avoiding CORS issues)

## Troubleshooting:
- Make sure your `.env` file contains `VITE_CLAUDE_API_KEY=your_actual_key`
- Both servers need to be running simultaneously
- Check the proxy server terminal for error messages

## Alternative: Use Claude's JavaScript SDK
If you prefer, you could also use Claude's official JavaScript SDK in a more robust backend setup, but this simple proxy should work for development.

The AI Assistant will now be able to:
- Analyze your Theory of Change graph
- Suggest improvements and new connections
- Provide strategic guidance
- Help with graph organization

Try asking it: "Can you analyze my current theory of change and suggest improvements?"