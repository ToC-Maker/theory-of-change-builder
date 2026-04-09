# Theory of Change Builder

An interactive web application for creating [Theory of Change](https://en.wikipedia.org/wiki/Theory_of_change) diagrams with AI assistance. Built for nonprofits, researchers, and anyone designing interventions who wants to think rigorously about how their work leads to impact.

A Theory of Change maps the causal chain from your activities to your intended impact, making assumptions explicit, testable, and open to scrutiny. This tool helps you build those maps collaboratively, with an AI co-pilot that challenges weak logic and demands evidence.

## Features

- **AI-assisted graph building**: An AI co-pilot guides you through constructing your Theory of Change step by step, challenging assumptions and suggesting evidence
- **Interactive graph editor**: Drag-and-drop nodes, draw connections, and organize your causal chain visually
- **Confidence scoring**: Rate the strength of each causal link (0-100%) with evidence and assumptions attached
- **Shareable URLs**: Every chart gets a persistent URL for viewing (`/chart/{id}`) or editing (`/edit/{token}`)
- **Permission system**: Control who can view or edit your charts, with link sharing and approval workflows
- **PDF and document import**: Upload existing Theory of Change documents to seed your graph
- **Cloud saving**: Charts are automatically saved to the database
- **Auth0 authentication**: Optional sign-in for chart ownership and access control
- **Undo/redo**: Full history of edits with keyboard shortcuts

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (for local development with backend functions)
- A [Neon](https://neon.tech) PostgreSQL database
- An [Auth0](https://auth0.com) application (for authentication)
- An [Anthropic API key](https://console.anthropic.com/) (for AI features)

### Installation

```bash
git clone https://github.com/ToC-Maker/theory-of-change-builder.git
cd theory-of-change-builder
npm install
```

### Environment Variables

Create a `.dev.vars` file (for Wrangler local dev):

```env
DATABASE_URL=postgresql://...              # Neon connection string
VITE_AUTH0_DOMAIN=your-domain.auth0.com    # Auth0 domain (public, client-side)
VITE_AUTH0_CLIENT_ID=your-client-id        # Auth0 client ID (public, client-side)
ANTHROPIC_API_KEY=sk-ant-...               # Anthropic API key (server-side only)
IP_HASH_SALT=your-random-salt              # Salt for IP hashing (server-side only)
```

### Database Setup

1. Create a [Neon](https://neon.tech) PostgreSQL database
2. Run the schema from `database/schema.sql`
3. Apply migrations from `database/migrations/` in order

### Running Locally

```bash
# Full-stack development (recommended: includes backend functions and AI features)
npm run dev

# Frontend only (no backend functions)
npm run dev:vite
```

The app will be available at `http://localhost:8787` (Wrangler dev) or `http://localhost:5173` (Vite only).

For full-stack dev with hot reloading: run `npm run dev` in one terminal, then `npm run dev:vite` in another (proxies `/api` calls to the Worker).

## Usage

1. **Create a new chart** at the root URL
2. **Use the AI assistant** (chat panel) to build your Theory of Change step by step, or create nodes manually
3. **Share your chart** using the share button to get view-only or edit links
4. **Import documents** by uploading PDFs or text files describing an existing Theory of Change

### URL Structure

- `/` -- Create a new chart
- `/chart/{id}` -- View a chart (read-only)
- `/edit/{token}` -- Edit a chart (with permissions)

## Tech Stack

- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, React Router 7
- **Backend**: Cloudflare Pages Functions (Workers runtime)
- **Database**: Neon PostgreSQL (serverless)
- **Auth**: Auth0
- **AI**: Anthropic Claude API

## Contributing

Contributions are welcome. See `CLAUDE.md` for architecture details and development guidance.
