# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Theory of Change Graph Builder - Interactive web app for creating Theory of Change diagrams with AI assistance, persistent URLs, and collaborative editing. Built for the effective altruism community.

## Development Commands

```bash
# Install and start
npm install
npm run dev              # Build + wrangler dev (full stack on :8787)
npm run dev:vite         # Vite only with HMR (:5173, proxy /api to :8787)

# Build and deploy
npm run build            # Vite build only
npm run deploy           # Build + deploy to Cloudflare Workers
npm run lint

# Storybook
npm run storybook        # Component development (port 6006)
```

For full-stack dev with HMR: run `npm run dev` in one terminal (Worker + API),
then `npm run dev:vite` in another (Vite HMR, proxies `/api` to Worker).

## Stack

- **Frontend**: React 18 + TypeScript + Vite + Tailwind CSS + React Router 7
- **Backend**: Cloudflare Workers (with Static Assets)
- **Database**: Neon PostgreSQL (serverless)
- **Auth**: Auth0 (JWT validation server-side via `jose`)
- **AI**: Anthropic Claude API via `/api/anthropic-stream` Worker route
- **Hosting**: Cloudflare Workers (static assets + API in one Worker)

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

There are three distinct "where it's needed" categories. Some variables are needed in more than one place.

| Variable | Sensitive? | Build-time (Vite inlines) | Runtime (Worker reads) | Set where |
|---|---|---|---|---|
| `DATABASE_URL` | yes (secret) | no | yes | Dashboard → Variables and Secrets (type: Secret) |
| `ANTHROPIC_API_KEY` | yes (secret) | no | yes | Dashboard → Variables and Secrets (type: Secret) |
| `IP_HASH_SALT` | yes (secret) | no | yes | Dashboard → Variables and Secrets (type: Secret) |
| `VITE_AUTH0_DOMAIN` | no (public) | **yes** | yes | `wrangler.toml` `[vars]` + committed `.env.production` |
| `VITE_AUTH0_CLIENT_ID` | no (public) | **yes** | yes | `wrangler.toml` `[vars]` + committed `.env.production` |
| `SITE_URL` | no (public) | no | optional | `wrangler.toml` `[vars]` (falls back to request origin if unset) |

**Three locations, three purposes:**

1. **Dashboard → Variables and Secrets**: Runtime values. Secrets are encrypted; plaintext vars are visible. Equivalent to `wrangler secret put` / `wrangler.toml [vars]`.
2. **`wrangler.toml [vars]`**: Runtime values for non-secrets, version-controlled. Appears in the dashboard as plaintext after deploy.
3. **`.env.production` (committed) or `.env` (gitignored)**: Build-time values. Vite reads these at `npm run build` and inlines `import.meta.env.VITE_*` into the frontend bundle. Cloudflare's build pipeline does **not** automatically propagate `wrangler.toml [vars]` to the build environment.

**The `VITE_*` trap**: `VITE_*` variables are inlined by Vite at build time AND read by the Worker at runtime. Setting them only in `wrangler.toml [vars]` makes them available to the Worker but leaves the frontend bundle with `undefined` values — `src/main.tsx` throws at startup in that case. You need them in both `wrangler.toml [vars]` (runtime) AND `.env.production` or build-env-vars (build-time).

**Never commit secrets.** `VITE_AUTH0_*` are client-exposed by design (Auth0 public SPA credentials), so committing them in `.env.production` is fine.

For local development, copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in values. Wrangler's `wrangler dev` reads `.dev.vars`; Vite reads `.env.local` or `.env.development` — create those too if you need frontend-side vars for local Vite builds.

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
- Token validated in backend via `verifyToken()` in `worker/_shared/auth.ts`
- User exists in `chart_permissions` table with `status='approved'`

### PDF Parsing
PDF parsing uses `pdfjs-dist` with web worker. If PDFs fail to parse:
- Check worker path configured in `src/utils/fileParser.ts` (must use Vite `?url` import)
- Verify PDF is not password-protected or corrupted
- Check browser console for worker errors

### Local Development with Functions
Run `npm run dev` in one terminal (Worker on :8787), then `npm run dev:vite` in another
(Vite HMR on :5173, proxies `/api/*` to the Worker). This gives HMR for frontend + live API.

For quick full-stack testing without HMR, `npm run dev` alone serves everything on :8787.

## Key Files

- `src/App.tsx` - Main app logic, routing, undo/redo (1,780 lines)
- `src/components/TheoryOfChangeGraph.tsx` - Graph SVG renderer
- `src/components/ChatInterface.tsx` - AI assistant UI
- `src/services/chartService.ts` - API client for CRUD operations
- `src/utils/graphEdits.ts` - AI edit instruction parser and applier
- `worker/index.ts` - Worker entry point (router, CORS, security headers)
- `worker/api/` - API route handlers (getChart, updateChart, etc.)
- `worker/api/anthropic-stream.ts` - AI streaming proxy
- `worker/_shared/auth.ts` - Auth0 JWT verification (jose)

For complex graph editing logic or connection rendering issues, see `ConnectionsComponent.tsx` and `graphEdits.ts`.

For Auth0 integration details or permission system changes, see `worker/_shared/auth.ts`.

## Testing

No formal test suite currently. Manual testing workflow:
1. Create chart → 2. Edit nodes/connections → 3. Share with different users → 4. Test permission flows

## Deployment

Manual deploy: `npm run deploy` (builds + deploys to Cloudflare Workers).

Configuration: `wrangler.toml` (entry point, compatibility flags, static assets config).
