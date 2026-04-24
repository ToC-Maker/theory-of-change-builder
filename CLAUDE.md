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
| `BYOK_ENCRYPTION_KEY` | optional (secret) | no | yes | Dashboard → Variables and Secrets (type: Secret). Must be 32 bytes, base64-encoded. Used by `worker/_shared/byok-crypto.ts` to wrap per-user Anthropic keys with AES-GCM. When unset, BYOK is disabled (users cannot save personal keys). |
| `TURNSTILE_SECRET_KEY` | optional (secret) | no | yes | Dashboard → Variables and Secrets (type: Secret). Used by `worker/api/anthropic-stream.ts` to verify the Cloudflare Turnstile challenge on anonymous requests. When unset, the anon bot-check is disabled (anon AI requests skip Turnstile). |
| `VITE_AUTH0_DOMAIN` | no (public) | **yes** | yes | `wrangler.jsonc` `vars` + committed `.env.production` |
| `VITE_AUTH0_CLIENT_ID` | no (public) | **yes** | yes | `wrangler.jsonc` `vars` + committed `.env.production` |
| `VITE_TURNSTILE_SITE_KEY` | no (public) | **yes** | yes | `wrangler.jsonc` `vars` + committed `.env.production`. Read by the client-side Turnstile widget. |
| `SITE_URL` | no (public) | no | optional | `wrangler.jsonc` `vars` (falls back to request origin if unset) |

**Three locations, three purposes:**

1. **Dashboard → Variables and Secrets**: Runtime values. Secrets are encrypted; plaintext vars are visible. Equivalent to `wrangler secret put` / `wrangler.jsonc vars`.
2. **`wrangler.jsonc` `vars`**: Runtime values for non-secrets, version-controlled. Appears in the dashboard as plaintext after deploy.
3. **`.env.production` (committed) or `.env` (gitignored)**: Build-time values. Vite reads these at `npm run build` and inlines `import.meta.env.VITE_*` into the frontend bundle. Cloudflare's build pipeline does **not** automatically propagate `wrangler.jsonc` `vars` to the build environment.

**The `VITE_*` trap**: `VITE_*` variables are inlined by Vite at build time AND read by the Worker at runtime. Setting them only in `wrangler.jsonc` `vars` makes them available to the Worker but leaves the frontend bundle with `undefined` values — `src/main.tsx` throws at startup in that case. You need them in both `wrangler.jsonc` `vars` (runtime) AND `.env.production` or build-env-vars (build-time).

**Never commit secrets.** `VITE_AUTH0_*` are client-exposed by design (Auth0 public SPA credentials), so committing them in `.env.production` is fine.

For local development, copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in values. Wrangler's `wrangler dev` reads `.dev.vars`; Vite reads `.env.local` or `.env.development` — create those too if you need frontend-side vars for local Vite builds.

## Database Schema

See `database/schema.sql` for full schema. Key tables:

- **charts**: Stores graph data (JSONB), edit tokens, view counts. The `total_tokens_used INT` column still exists for backward compatibility but is legacy; authoritative spend lives in `user_api_usage` (micro-USD), not here. Same for `user_token_usage`, which is frozen.
- **chart_permissions**: User access control with approval workflow
- **user_api_usage**: Per-user cumulative AI spend, in micro-USD (see Cost accounting below). Replaces the legacy `user_token_usage` table.
- **global_monthly_usage**: Observability-only table tracking aggregate monthly spend. Enforcement is via the Anthropic Console customer-set cap, not this table.
- **logging_messages**: AI improvement logs. `cost_micro_usd` column stores per-message cost.
- **logging_snapshots**: Graph-state snapshots after each AI edit, correlated to the triggering message. Used for replay and eval of AI edit outcomes.
- **logging_errors**: Client-side error reports plus kill-switch diagnostics and server-side service errors. Each row is stamped with `deployment_host` (inside `request_metadata` JSONB) so staging vs prod can be separated.
- **user_byok_keys**: Encrypted blobs of user-supplied Anthropic API keys (column `encrypted_key` as `BYTEA`).
- **chart_files**: Metadata for files uploaded to Anthropic's Files API (`file_id`, `chart_id` FK, original filename, timestamp). `ON DELETE CASCADE` on the FK so chart deletion removes the rows.
- **idempotency_keys**: 60s replay-dedup window for the `X-Idempotency-Key` header on `/api/anthropic-stream`. Rows inserted before the upstream fetch; periodic cleanup removes entries older than the dedup window.

For migrations, see `database/migrations/`. Always test on staging first.

## Database migrations

Migrations in `database/migrations/` are applied manually against staging and prod (no per-PR preview branches). **Keep them idempotent** so re-running the same file is safe: use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `INSERT ... ON CONFLICT`. For `ADD CONSTRAINT` (no `IF NOT EXISTS` in Postgres), wrap in a `DO` block with a `pg_constraint` lookup — see `freeze-user-token-usage.sql`.

## Cost Accounting

All server-side cost accounting uses **micro-USD** (1_000_000 µUSD = $1) as the integer unit. Rate tables live in `worker/_shared/cost.ts`. Per-user cumulative spend is stored in `user_api_usage`; global monthly spend in `global_monthly_usage` (observability only — enforcement is the Anthropic Console customer-set cap). Per-message cost lands in `logging_messages.cost_micro_usd`. Tier caps and infra limits are constants in `worker/_shared/tiers.ts`.

The legacy `POST /api/updateTokenUsage` endpoint and `user_token_usage` table have been replaced by server-side SSE parsing in `worker/api/anthropic-stream.ts`. The client no longer reports token usage; the Worker observes it from Anthropic's `message_delta.usage` events and UPSERTs into `user_api_usage` via `ctx.waitUntil()`.

## BYOK (Bring Your Own Key)

Users can supply their own Anthropic API key via the settings panel. Keys are validated via `POST /v1/messages/count_tokens`, encrypted with AES-GCM using `env.BYOK_ENCRYPTION_KEY` and the user's `user_id` as AAD, then stored in `user_byok_keys` (column `encrypted_key` as `BYTEA`). BYOK requests bypass the per-user lifetime cap; the Anthropic Console cap still applies globally. Users can delete their key via `DELETE /api/byok-key`, which zeros and removes the encrypted blob.

## Files API

PDFs and other files attached in Chat are uploaded to Anthropic's Files API (`https://api.anthropic.com/v1/files`) with beta header `anthropic-beta: files-api-2025-04-14`. The resulting `file_id` is stored in the local `chart_files` table, keyed to the chart via `chart_id` FK. File deletion triggers:

- **Chart delete** — CASCADE on the FK removes the rows; a follow-up job DELETEs at Anthropic.
- **Clear Chat button** — `DELETE /api/chart-files?chart_id=X` clears both the local rows and the Anthropic-side files.
- **Abandoned upload cleanup**: `DELETE /api/files/:id` removes a single file (used when the user attaches then detaches before sending).
- **Lookup**: `GET /api/files/:id` returns metadata for a single file (ownership check + filename).
- **GDPR erasure** — manual admin script walks the user's charts and deletes.

Files are not subject to Anthropic's 7-day message retention; they persist at Anthropic until an explicit DELETE. Privacy policy discloses this (see `policies/privacy-policy.md § 2E` and the retention table). The Markdown sources of the privacy policy and LIA live under `policies/` (gitignored — canonical published version is the Google Doc linked from `AuthButton.tsx`).

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

### Anonymous Identity and Turnstile Session

Anon users are identified by a cookie-pinned UUID, not by IP. Three cookies coordinate this:

- `tocb_actor_id` (1 year): UUIDv4 keying the anon `user_api_usage` row; survives across sessions.
- `tocb_anon` (24h): HMAC-signed Turnstile session cookie. Set by `/api/verify-turnstile` on solve; checked by `/api/anthropic-stream` on each anon request so the user does not re-solve per message.
- `tocb_auth_link` (1 year): HMAC-signed cookie binding a browser to an Auth0 `sub`. Survives logout so the same browser + same Auth0 account re-converge to the same `user_api_usage` row (Policy B: cap preservation across sign-out).

On first sign-in, the anon `user_api_usage` row folds into the authenticated row (the anon spend is credited to the authenticated user so users do not lose history by signing in). IP is not used for identity; the earlier IP-hashed scheme (`IP_HASH_SALT`) was dropped during this migration and is no longer load-bearing for identity.

See `worker/_shared/anon-id.ts`, `worker/_shared/turnstile-cookie.ts`.

### Turnstile Failures
Anon users must solve a Cloudflare Turnstile challenge before the first AI request in a session. If the widget fails to load or verification returns 403:
- Check `VITE_TURNSTILE_SITE_KEY` is set **at build time** (baked into the bundle by Vite).
- Check `TURNSTILE_SECRET_KEY` is set as a Worker secret (server-side verification).
- If `TURNSTILE_SECRET_KEY` is unset, the anon bot-check silently disables; the widget still renders but verification is skipped.

### BYOK Validation Errors
`POST /api/byok-key` validates the submitted key via Anthropic's `POST /v1/messages/count_tokens` before encrypting and storing. Common failure modes:
- Key prefix wrong (`sk-ant-` expected).
- Key tier below required minimum (see `worker/_shared/tiers.ts`).
- `BYOK_ENCRYPTION_KEY` unset on the Worker (BYOK disabled globally).

### Cost Cap 402 / 429s
A 402 from `/api/anthropic-stream` means the user hit their per-user lifetime cap in `user_api_usage` (see `worker/_shared/tiers.ts` for caps per tier). Supplying a BYOK key bypasses the lifetime cap; the Anthropic Console customer-set cap still applies globally and will surface as a 429 upstream.

### PDF Handling
PDFs are not parsed client-side. `src/utils/fileParser.ts:validatePdf` runs
a lightweight header scan that extracts `{pageCount, sizeBytes}` from the
first 500 KB of the file (looking for `/Type /Pages ... /Count N`) and
returns an upload-intent signal. It does NOT throw on size or page count
— Anthropic enforces its own limits at upload/use time (see
`shared/anthropic-limits.ts`: `ANTHROPIC_FILE_UPLOAD_BYTES` = 500 MB per
file, `ANTHROPIC_PDF_PAGE_LIMIT` = 600 pages per PDF document). The
caller uploads the binary to Anthropic's Files API and references it
via a `document` content block.

### Local Development with Functions
Run `npm run dev` in one terminal (Worker on :8787), then `npm run dev:vite` in another
(Vite HMR on :5173, proxies `/api/*` to the Worker). This gives HMR for frontend + live API.

For quick full-stack testing without HMR, `npm run dev` alone serves everything on :8787.

## Key Files

- `src/App.tsx` - Main app logic, routing, undo/redo
- `src/components/TheoryOfChangeGraph.tsx` - Graph SVG renderer
- `src/components/ChatInterface.tsx` - AI assistant UI
- `src/services/chartService.ts` - API client for CRUD operations
- `src/utils/graphEdits.ts` - AI edit instruction parser and applier
- `worker/index.ts` - Worker entry point (router, CORS, security headers)
- `worker/api/` - API route handlers (getChart, updateChart, etc.)
- `worker/api/anthropic-stream.ts` - AI streaming proxy (SSE, usage UPSERT, kill-switch, Turnstile gate)
- `worker/api/verify-turnstile.ts` - Turnstile challenge verification, issues `tocb_anon` session cookie
- `worker/api/upload-file.ts` - Anthropic Files API upload proxy, records rows in `chart_files`
- `worker/api/chart-files.ts` - `chart_files` cleanup (clear-chat and per-chart erasure)
- `worker/_shared/auth.ts` - Auth0 JWT verification (jose)
- `worker/_shared/byok-crypto.ts` - AES-GCM wrap/unwrap for per-user BYOK keys
- `worker/_shared/turnstile-cookie.ts` - HMAC-signed Turnstile session cookie (`tocb_anon`)
- `worker/_shared/anon-id.ts` - Cookie-pinned anon identity (`tocb_actor_id`) and auth-link (`tocb_auth_link`)
- `worker/_shared/cost.ts` - Micro-USD cost math (`computeCostMicroUsd`, rate tables)
- `worker/_shared/tiers.ts` - Tier predicates, per-user caps, infra limits
- `shared/pricing.ts` - Single source of truth for model pricing, shared client/server

For complex graph editing logic or connection rendering issues, see `ConnectionsComponent.tsx` and `graphEdits.ts`.

For Auth0 integration details or permission system changes, see `worker/_shared/auth.ts`.

## Testing

Run all worker-side unit tests: `npm test`. Tests live under `tests/worker/` and use vitest + `@cloudflare/vitest-pool-workers` to execute in a real Workers runtime. Watch mode: `npm run test:watch`.

Current coverage: `computeCostMicroUsd`, tier predicates, AES-GCM BYOK key round-trip, Turnstile session-cookie HMAC. Add tests for new Worker helpers alongside the code; especially `anon-id.ts`, the kill-switch logic in `anthropic-stream.ts`, and `reserveCost` race-safety tests.

Manual testing is still needed for end-to-end flows (graph editing, permissions, AI streaming):
1. Create chart → 2. Edit nodes/connections → 3. Share with different users → 4. Test permission flows

## Deployment

Manual deploy: `npm run deploy` (builds + deploys to Cloudflare Workers).

Configuration: `wrangler.jsonc` (entry point, compatibility flags, static assets config).
