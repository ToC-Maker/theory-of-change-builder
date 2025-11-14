# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Theory of Change Graph Builder - Interactive web app for creating Theory of Change diagrams with AI assistance, persistent URLs, and collaborative editing. Built for the effective altruism community.

## Development Commands

```bash
# Install and start
npm install
npm run dev              # Vite dev server (port 5173)
netlify dev              # With serverless functions (port 8888) - use this for testing AI features

# Build and lint
npm run build
npm run lint

# Storybook
npm run storybook        # Component development (port 6006)
```

## Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS + React Router 7
- **Backend**: Netlify Functions (Node.js) + Edge Functions (Deno)
- **Database**: Neon PostgreSQL (serverless)
- **Auth**: Auth0 (JWT validation server-side)
- **AI**: Anthropic Claude API via `/api/anthropic-stream` edge function

## Critical Architecture Notes

### Graph Data Structure

Theory of Change graphs use nested structure: `sections[] → columns[] → nodes[] → connections[]`

**IMPORTANT - Node Positioning:**
- `node.yPosition` is the CENTER Y coordinate, not top-left
- Calculate top position: `yPosition - (nodeHeight / 2)`
- Never treat yPosition as top coordinate or nodes will misalign

**Connections:**
- New format: `connections: [{ targetId, confidence, evidence, assumptions }]`
- Old format still supported: `connectionIds: string[]`
- Always use new format for new code
- Confidence (0-100) determines visual style: solid (80+), dashed (40-79), dotted (0-39)

### AI Edit System

The AI modifies graphs via structured JSON edits in `src/utils/graphEdits.ts`:

```json
[EDIT_INSTRUCTIONS]
[
  { "type": "update", "path": "sections.0.title", "value": "New Title" },
  { "type": "push", "path": "sections.1.columns.0.nodes", "value": {...} },
  { "type": "delete", "path": "sections.0.columns.1.nodes.2" }
]
[/EDIT_INSTRUCTIONS]
```

- Path format: `sections.0.columns.1.nodes.2` (dot notation, zero-indexed)
- Four types: `update`, `insert`, `delete`, `push`
- Edits validated sequentially - later edits can reference earlier results
- Never use negative indices or invalid paths

### URL Patterns and Permissions

Three access patterns:
1. `/` - Create new chart (edit mode)
2. `/chart/{chartId}` - View-only (public)
3. `/edit/{editToken}` - Edit mode (permission-controlled)

**Permission System:**
- Anonymous charts (`user_id` NULL): Anyone with edit token can edit
- Authenticated charts: Owner must approve access requests (status: pending/approved/rejected)
- Link sharing levels: `restricted` (approval required), `viewer` (public view), `editor` (public edit)
- Set `link_sharing_level='editor'` to bypass approval workflow

If you encounter 401/403 errors, check: token validity, permission status, link sharing level.

## Environment Variables

Required in `.env.local` and Netlify:

```bash
DATABASE_URL=postgresql://...              # Neon connection string
VITE_AUTH0_DOMAIN=your-domain.auth0.com   # Public (VITE_ prefix exposed to client)
VITE_AUTH0_CLIENT_ID=your-client-id       # Public
ANTHROPIC_API_KEY=sk-...                  # Server-side only (edge function)
```

**Never** commit API keys. `VITE_*` variables are client-exposed by design (Auth0 public credentials).

## Database Schema

See `database/schema.sql` for full schema. Key tables:

- **charts**: Stores graph data (JSONB), edit tokens, view counts, AI token usage
- **chart_permissions**: User access control with approval workflow
- **user_token_usage**: Per-user AI token tracking

For migrations, see `database/migrations/`. Always test on staging first.

## Common Issues

### SVG Connection Rendering
Connections use `offsetLeft`/`offsetTop` for position calculations (immune to CSS zoom/transforms). If connections appear disconnected from nodes, check that:
- Container ref is correctly passed to ConnectionsComponent
- Node refs are updated when nodes mount/unmount
- yPosition is CENTER Y, not top Y

### Auth Token Issues
Auth0 tokens refresh automatically, but invalid tokens silently fall back to anonymous mode. If permission checks fail unexpectedly, verify:
- Token in Authorization header: `Bearer <token>`
- Token validated in backend via `verifyToken()` in `netlify/functions/utils/auth.ts`
- User exists in `chart_permissions` table with `status='approved'`

### PDF Parsing
PDF parsing uses `pdfjs-dist` with web worker. If PDFs fail to parse:
- Check worker path configured in `src/utils/fileParser.ts` (must use Vite `?url` import)
- Verify PDF is not password-protected or corrupted
- Check browser console for worker errors

### Local Development with Functions
Use `netlify dev` (not `npm run dev`) when testing:
- AI features (requires edge function `/api/anthropic-stream`)
- Database operations (requires serverless functions)
- Auth flows (requires proper callback URLs)

`npm run dev` alone won't proxy requests to functions correctly.

## Key Files

- `src/App.tsx` - Main app logic, routing, undo/redo (1,780 lines)
- `src/components/TheoryOfChangeGraph.tsx` - Graph SVG renderer
- `src/components/ChatInterface.tsx` - AI assistant UI
- `src/services/chartService.ts` - API client for CRUD operations
- `src/utils/graphEdits.ts` - AI edit instruction parser and applier
- `netlify/functions/` - Serverless functions (getChart, updateChart, etc.)
- `netlify/edge-functions/anthropic-stream.ts` - AI streaming proxy

For complex graph editing logic or connection rendering issues, see `ConnectionsComponent.tsx` and `graphEdits.ts`.

For Auth0 integration details or permission system changes, see `AUTH0_INTEGRATION_GUIDE.md`.

## Testing

No formal test suite currently. Manual testing workflow:
1. Create chart → 2. Edit nodes/connections → 3. Share with different users → 4. Test permission flows

## Deployment

Netlify auto-deploys on push to `main`. Build: `npm run build` → `dist/`.

Preview deploys created for PRs automatically.
