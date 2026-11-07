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

# Quality checks (also what CI runs)
npm run typecheck
npm run lint
npm run format:check
npm test
npm run preflight        # typecheck + lint + format:check + build + test, in parallel
npm run preflight:serial # same as preflight but sequential (easier to read when debugging a failure)
```

For full-stack dev with HMR: run `npm run dev` in one terminal (Worker + API),
then `npm run dev:vite` in another (Vite HMR, proxies `/api` to Worker).

`npm run preflight` runs locally what CI enforces as gates (typecheck, lint,
format check, build, unit tests). It runs the gates in parallel via
`npm-run-all2` (takes ~15s vs ~35s serial). A `pre-push` git hook (via
`simple-git-hooks`) runs it automatically before every `git push`; bypass
with `git push --no-verify` when you need to push work-in-progress that
isn't CI-clean yet. If a parallel run's interleaved output is hard to
read, `npm run preflight:serial` runs the same gates sequentially.

## Stack

- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS + React Router 7
- **Backend**: Cloudflare Workers (with Static Assets)
- **Database**: Neon PostgreSQL (serverless)
- **Auth**: Auth0 (JWT validation server-side via `jose`)
- **AI**: Anthropic Claude API via `/api/anthropic-stream` Worker route
- **Hosting**: Cloudflare Workers (static assets + API in one Worker)

## Critical Architecture Notes

### Graph Data Structure

Theory of Change graphs use nested structure: `sections[] → columns[] → nodes[] → connections[]`

**Ids:** every section, column and node has an `id`, and it is what code refers to, never an index that has to outlive one event (another editor can insert a section while you hold an index). Charts stored before ids existed lack them on sections and columns: `normalizeChart` (`shared/chart-model.ts`) gives them deterministic ones on read (`s0`, `c0.1`, suffixed `~2`, `~3` when taken), so two tabs reading the same chart agree, and they reach storage on the next save. Sections and columns created in the app get random ids (`newSectionId()`, `newColumnId()`: `sec-…`, `col-…`); the AI's model never sees container ids (`addNodePaths` drops them).

**IMPORTANT - Node Positioning:**
- `node.yPosition` is the CENTER Y coordinate, not top-left
- Calculate top position: `yPosition - (nodeHeight / 2)`
- Never treat yPosition as top coordinate or nodes will misalign

**Connections:**
- Canonical: `connections: [{ targetId, confidence, evidence, assumptions, waypoints? }]`; `connectionIds` is kept listing the same targets
- A chart that has only `connectionIds` (stored before `connections`) is converted by `normalizeChart` at confidence 50, which draws identically. Every way a chart enters the tab goes through it (`ChartService` for anything from the server; `validateChartImport`, `parseGeneratedGraph` and `prepareAIResult` for imports, generated charts and AI results; App for files, localStorage and the template), so the app reads `connections` only
- Confidence (0-100) determines visual style CONTINUOUSLY: solid at 95+; below that the dash length grows cubically toward the threshold (2px dots at 0 → ~46.6px at 94) while the gap shrinks linearly (8px → ~1.6px), so 94 reads ~97% ink (near-solid, the 95 boundary is imperceptible) and low confidence reads as sparse dots (see `computeConfidenceDash` in `src/utils/index.ts`; no hard style buckets)
- The connection-strength Legend is view-mode chrome only: `ToCViewerOnly` mounts it as a fixed bottom-left overlay outside the zoom/pan transform; the editor renders no legend (confidence is numeric in the EdgeEditor) and the legend is not draggable
- `waypoints`: array of `{ dx, dy }` pixel offsets from the midpoint of the straight line between the connection's source and target anchors, so a bend keeps its place relative to its nodes whatever moves them. The conversion to and from canvas coordinates lives in `src/utils/connectionGeometry.ts` (applied when rendering and when dragging). The UI edits at most one waypoint per connection; a drag replaces the whole array and double-clicking the handle clears it (automatic curve). Escape or a cancelled pointer restores the offsets the document has committed (a bend a collaborator changed during the drag stays) and saves nothing. A press on the midpoint dot that is released without becoming a drag opens the connection's editor, as a click on the line does. Entries that are not finite `{ dx, dy }`, including the earlier absolute `{ x, y }` format, render as the automatic curve until the next drag replaces them; import accepts them unchanged.

### Edit and View Layout

Inside the graph, edit mode and view mode have the same geometry: node rects and connection paths are identical in content coordinates, and view mode's markup is unchanged by edit mode's overlays. Node, column and section positions and widths, the gaps between them, and connection paths do not depend on `editMode`. The vertical extent does (see the column-body bullet below).

- The gap between sections is `sectionPadding` (32px) and between columns `columnPadding` (24px), in both modes.
- A section title bar is as wide as its title, at least as wide as its columns. While its label is edited it keeps the width it had when the editor opened.
- The chart title block takes space only when the chart has a title (or while one is being typed). The "Click to add title" prompt of an untitled chart is a chip floating just above the canvas card; it is sized in on-screen pixels (content pixels divided by the zoom) so it stays readable at fit zoom.
- Edit mode gives column bodies an explicit height and lets the graph container take its height from content. Both are invisible and keep the empty space below nodes double-clickable. They leave node positions alone but not the chart's vertical extent: the graph container is up to about 70px taller or shorter than view mode's (737 vs 745 with a title, 817 vs 745 without, at text size 1), and the edit card has a fixed height where view mode's follows its content. The difference is blank space at the bottom of the card.
- Add-column and add-section controls are overlays (`src/components/canvas/AddControlZone.tsx`): one zone over each gap between columns (one control), each gap between sections (three), and each outer edge of the chart (two, in the card's 16px padding).
  - At rest a zone shows a faint dashed hairline and a "+" badge at the columns' mid-height. The badge sits below the connection layer, so a connection that crosses it keeps its hover, press, tap and drag. The controls appear after the pointer has rested on the zone for `HOVER_INTENT_MS` (a sweep across the chart shows nothing), or at once on a click on the badge. They hide `HOVER_GRACE_MS` after the pointer leaves.
  - Controls are sized in on-screen pixels (divided by the canvas zoom): at least `MOUSE_TARGET_PX` wide for mouse and pen, `TOUCH_TARGET_PX` for touch, with a 12px (touch 14px) label, at any zoom. They overhang the gap, are placed where they cover no node or connection if the zone has room, and sit below nodes; where there is no such spot they sit above nodes while open.
  - Touch takes two taps: the first, on the gap or its badge, opens the controls; the second, on a control, adds. They close on a tap elsewhere or after `TOUCH_OPEN_MS`.
  - Controls are `role="button"` divs, not `<button>`s, because a press on a `<button>` never starts a canvas pan; a press that travels past `MOVE_THRESHOLD_PX` adds nothing.
- Elements with `data-export-exclude` are dropped from PNG and PDF exports (`src/utils/exportChart.ts`).

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
- **`update` REPLACES the whole value at its path** (`setAtPath` in `graphEdits.ts`); it does not merge. Rewriting a whole connection/node object therefore silently drops any field the model omits.
- **UI-managed fields the prompts must keep documented as "preserve, don't author":** `connection.waypoints`, `node.width`/`node.color`, and the root-level format fields (`curvature`, `textSize`, `fontFamily`, `columnPadding`, `sectionPadding`). They live in the JSON and must round-trip through edits, so the model changes a connection/node via **granular path edits** (e.g. `...connections.0.confidence`) rather than whole-object rewrites, or those fields are lost. The prompts (`src/prompts/chatModePrompt.md`, `generateModePrompt.md`) document this; `tests/frontend/graphEdits.waypoints.test.ts` guards the replace-vs-granular behavior.

### URL Patterns and Permissions

Three access patterns:
1. `/` - Create new chart (edit mode)
2. `/chart/{chartId}` - View-only (public, except an owned chart at `restricted` or NULL, which needs the signed-in owner or an approved user)
3. `/edit/{editToken}` - Edit mode (permission-controlled)

**Permission System:**
- Anonymous charts (`user_id` NULL): Anyone with edit token can edit
- Authenticated charts: Owner must approve access requests (status: pending/approved/rejected)
- Link sharing levels: `restricted` (approval required to view or edit; the column default), `viewer` (public view link, editing still needs approval), `editor` (public view and edit)
- Set `link_sharing_level='editor'` to bypass approval workflow

If you encounter 401/403 errors, check: token validity, permission status, link sharing level.

### Concurrent Editing

Several people can edit one chart at once and nobody's work is lost silently. Four parts:

- **One client document.** The editor route holds the chart in a `ChartDocument` (`src/sync/ChartDocument.ts`), a synchronous store the canvas, the toolbar and the save and poll hooks all read and write: the last chart the server confirmed (with its `version`), the committed chart (what saves send and App renders), the live chart (committed plus the typing, slider and drag previews, what the canvas renders) and the undo history. A chart from the server is merged into the committed chart and the live chart is rebased onto it in the same call, so a landing can neither drop a keystroke nor revert a remote change. Previews go through `useGraphMutation(store)` (`src/hooks/useGraphMutation.ts`); open editors follow remote changes to fields they are not editing through `useFieldBuffer` (`src/hooks/useFieldBuffer.ts`).
- **Versioned saves.** `charts.version` advances whenever `chart_data` changes. `POST /api/updateChart` carries `baseVersion` and the Worker applies it only if that is still current (`UPDATE ... WHERE version = $n`); otherwise it answers `409 { version, chartData }`, and the client merges that chart into its own and sends again at once (`useChartSave`). A 409 is a normal outcome, not an error. A save without `baseVersion` comes from a tab still running the previous client: it is applied as before (last save wins), still advances the version and is logged as `updateChart.legacy`; the branch exists for that transition and goes once the line stops appearing in the logs.
- **Polling.** While the tab is visible and used, `useChartSync` sends `POST /api/pollChart { editToken, knownVersion }` every 2.5 s (`POLL_MS`); the answer carries the chart only when the version differs. It pauses while the tab is hidden, after 5 minutes idle, during a pointer drag and while a save is in flight, and a failure waits 30 s. The check is read-only (it does not go through `getChart`, which writes permission rows). A chart it cannot use shows in the save pill.
- **The merge** (`shared/chart-merge.ts`, a pure three-way merge by field with undo in revert form) decides every conflict: the last save of a field wins; a delete wins over a move or restyle but not over an edit of a node's title or details, or of a connection's evidence or assumptions. The rules and their reasons are in that file's header. Undo reverses only the user's own change and leaves fields others changed since. AI edits, imports and generated charts reach the document through `src/sync/aiEdit.ts` (`prepareAIResult`: fresh ids, then `doc.applyRebased`) or `doc.replace`.

A chart on `/` has no server until the first message or share creates it; `doc.attachServer` then supplies the created version, and edits made meanwhile are sent on it.

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

### Turnstile testkeys in dev

Cloudflare publishes [always-pass testkeys for Turnstile](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) so dev sessions (human or headless) can complete the widget without a real challenge. They are wired into this repo:

- **Site key** (`1x00000000000000000000AA`): committed in `.env.development`. Loaded by Vite when building in development mode. `npm run dev` passes `--mode development` to `vite build` so the testkey is inlined into the dev bundle; `npm run dev:vite` (the HMR dev server) loads it automatically because Vite defaults to development mode there.
- **Secret key** (`1x0000000000000000000000000000000AA`): present in `.dev.vars.example`. Copy that to `.dev.vars` (gitignored) and `wrangler dev` reads it. The Worker's `/api/verify-turnstile` and the anon Turnstile gate in `/api/anthropic-stream` accept any token the widget emits when this secret is configured.

Production keeps real Turnstile keys: site key in `.env.production` + `wrangler.jsonc` `vars`, secret in the Cloudflare dashboard. Nothing in the code path differs — dev exercises the full Turnstile round-trip, just against the always-pass keypair.

## Database Schema

See `database/schema.sql` for full schema. Key tables:

- **charts**: Stores graph data (JSONB), edit tokens, view counts, and `version INTEGER` (starts at 1), which the `charts_bump_version` trigger advances on every change to `chart_data` (not on view counts, link sharing or an identical resave) so saves can compare-and-swap on it. `updated_at` cannot serve as the version: its own trigger bumps it on any update. The `total_tokens_used INT` column still exists for backward compatibility but is legacy; authoritative spend lives in `user_api_usage` (micro-USD), not here. Same for `user_token_usage`, which is frozen.
- **chart_permissions**: User access control with approval workflow
- **user_api_usage**: Per-user cumulative AI spend, in micro-USD (see Cost accounting below). Replaces the legacy `user_token_usage` table.
- **global_monthly_usage**: Observability-only table tracking aggregate monthly spend. Enforcement is via the Anthropic Console customer-set cap, not this table.
- **logging_messages**: AI improvement logs. `cost_micro_usd` stores per-message cost. `content_blocks` (TEXT, not JSONB — so signed-thinking blocks round-trip byte-identical for replay/fork) holds the raw assistant turn (text + thinking + tool_use + tool_results). `was_killed` (BOOLEAN) is true iff the cost-cap kill switch fired for this turn — distinct from user-aborted (Stop button) and from transport failures, neither of which set it.
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

Two writers update `logging_messages.cost_micro_usd`: (1) the post-stream IIFE in `worker/api/anthropic-stream.ts`, and (2) `POST /api/reconcile-cost` (`worker/api/reconcile-cost.ts`) — a client-driven fallback for streams where `ctx.waitUntil()` was killed by Cloudflare's time budget before the IIFE finished, leaving the row at the input-only floor. The endpoint clamps `GREATEST(existing, client_value)`, so the client can only push the cost up; combined with the message_start floor it cannot under-report. `reconcile-cost` does NOT touch `user_api_usage` (the cap was already enforced by the pre-stream reservation).

`POST /api/count-tokens-estimate` (`worker/api/count-tokens-estimate.ts`) is a thin pass-through to Anthropic's `/v1/messages/count_tokens` plus a server-side cost projection. It strips Files-API `document` blocks (count_tokens rejects them), bucket-counts cached file tokens by draft vs history (so the client can apply cache-write 1.25× to the draft side and cache-read 0.1× to history), and returns `{input_tokens, estimated_cost_usd, ...}` for the composer's pre-send estimate. It also sanitizes the forwarded messages against count_tokens's shape rules (`sanitizeMessagesForCountTokens`: trailing-whitespace final assistant turns, empty/whitespace-only text blocks and messages, empty message lists) so shape-violating payloads can't surface as 503s — endpoint-contract hardening; the current UI does not produce these shapes (the graph JSON always rides in the draft text block). No usage is billed because `count_tokens` is a free Anthropic endpoint.

## BYOK (Bring Your Own Key)

Users can supply their own Anthropic API key via the settings panel. Keys are validated via `POST /v1/messages/count_tokens`, encrypted with AES-GCM using `env.BYOK_ENCRYPTION_KEY` and the user's `user_id` as AAD, then stored in `user_byok_keys` (column `encrypted_key` as `BYTEA`). BYOK requests bypass the per-user lifetime cap; the Anthropic Console cap still applies globally. Users can delete their key via `DELETE /api/byok-key`, which zeros and removes the encrypted blob.

## Files API

PDFs and other files attached in Chat are uploaded to Anthropic's Files API (`https://api.anthropic.com/v1/files`) with beta header `anthropic-beta: files-api-2025-04-14`. The resulting `file_id` is stored in the local `chart_files` table, keyed to the chart via `chart_id` FK. File deletion triggers:

- **Chart delete** — CASCADE on the FK removes the rows; a follow-up job DELETEs at Anthropic.
- **Clear Chat button** — `DELETE /api/chart-files?chart_id=X` clears both the local rows and the Anthropic-side files.
- **Abandoned upload cleanup**: `DELETE /api/files/:id` removes a single file (used when the user attaches then detaches before sending).
- **Lookup**: `GET /api/files/:id` returns metadata for a single file (ownership check + filename).
- **"Delete all my data"** — `DELETE /api/my-data` (see `worker/api/delete-my-data.ts`). User-initiated GDPR Art. 17 erasure, available in the Data & Privacy modal. Hard-deletes sole-owned charts (CASCADEs `chart_files` + `chart_permissions`), orphans collab-edited charts (`user_id → NULL`), DELETEs the user's `logging_*` rows and `chart_files`, and (auth only) zero-then-deletes the BYOK encrypted blob. Anthropic Files API DELETEs fan out via `ctx.waitUntil` (concurrency 6). Preserves `user_api_usage` and `tocb_actor_id` (anti-abuse cap, separate Art 6(1)(f) basis per LIA §1B); clears `tocb_anon` and `tocb_auth_link`.
- **GDPR erasure (admin)** — manual admin script walks the user's charts and deletes; backstop for partial / non-self-service requests.

Files are not subject to Anthropic's 7-day message retention; they persist at Anthropic until an explicit DELETE. Privacy policy discloses this (see `policies/privacy-policy.md § 2E` and the retention table). The Markdown sources of the privacy policy and LIA live under `policies/` (gitignored — canonical published version is the Google Doc linked from `AuthButton.tsx`).

## Common Issues

### SVG Connection Rendering
Connections use `offsetLeft`/`offsetTop` for position calculations (immune to CSS zoom/transforms). If connections appear disconnected from nodes, check that:
- Container ref is correctly passed to ConnectionsComponent
- Node refs are updated when nodes mount/unmount
- yPosition is CENTER Y, not top Y

### Concurrent Editing: Conflicts and Merge Failures
A `409` from `updateChart` is the normal answer to a save based on an old version: the client merges the chart in the response and sends again, so seeing them in the logs means two people (or two tabs) edited at once, not a bug. The Worker logs `updateChart.conflict` (chart id, base and current version) for each, and `updateChart.legacy` for each save from a tab still on the previous client. When the merge itself throws (a chart that repeats a section, column or node id, or is not a chart), the client shows the reason in the save pill (a failing save also stops saving; the poll keeps checking) and reports `ChartMergeFailed` to `logging_errors` with versions only, never chart content; a server that goes back to an older version reports `ChartVersionWentBackwards`. A details text MDXEditor cannot parse reports `MarkdownImportFailed`. A save answered without a version (a Worker older than the page) is not retried and the pill shows "The server did not return a chart version"; a chart load that gets none says so on the error page.

### Auth Token Issues
Auth0 tokens refresh automatically, but invalid tokens silently fall back to anonymous mode. If permission checks fail unexpectedly, verify:
- Token in Authorization header: `Bearer <token>`
- Token validated in backend via `verifyToken()` in `worker/_shared/auth.ts`
- User exists in `chart_permissions` table with `status='approved'`

ChartService, chatService, and LoggingService all resolve the token **per request** via `setAuthTokenProvider()` (one shared resolver, `src/services/requestTokenSource.ts`; the App auth effect registers `() => getFreshIdToken(...)` on all three, which refreshes near expiry). The static `setAuthToken()` is only a fallback for callers without a provider. Don't reintroduce mount-time-only token capture: the worker fails closed on stale tokens — 401 on `getUserCharts`, 403 on `updateChart` for owned charts with `link_sharing_level != 'editor'`, 401 `invalid_token` on `/api/anthropic-stream` (and a NULL token silently demotes the stream to anonymous: BYOK ignored, anon caps + Turnstile gate), 401 on the `logging-*` writes (which trips LoggingService's circuit breaker and silently kills logging). A stale snapshot therefore means signed-in 401s, silent autosave failures, broken AI chat, and lost logs.

**Persistently dead sessions are surfaced, not silent**: when the provider keeps failing while `isAuthenticated` is true (classically Auth0 403 "Unknown or invalid refresh token" — revoked refresh-token grant; only a re-login fixes it), `src/services/authSessionHealth.ts` flips to degraded (invalid_grant-family errors immediately, transient failures after 3 consecutive) and `SessionExpiredBanner.tsx` shows a "Sign in again" affordance. Any successful token resolution clears it. `useRefreshTokensFallback` is enabled in `main.tsx` so browsers with third-party cookies self-heal via iframe silent auth before the banner is ever needed (requires the app origin in Auth0 "Allowed Web Origins").

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

### count_tokens Assistant-Turn Validation
The mid-stream cost-cap poller and the post-stream reconcile both call `/v1/messages/count_tokens` on a partial assistant turn. Anthropic's count_tokens validator is stricter than `/v1/messages` itself; four rules trip on half-streamed shapes (all empirically confirmed against the live endpoint):
1. Final block cannot be `thinking` (append a `.` text block).
2. Final block cannot end with trailing whitespace (rstrip; drop block if it'd become empty).
3. Text blocks must be non-empty and contain non-whitespace.
4. Two `thinking` blocks cannot be adjacent without a text block between them.

Any new code that builds an assistant turn for count_tokens must go through `buildAssistantBlocksForCountTokens` in `worker/api/anthropic-stream.ts` so these rules stay enforced; rolling your own can silently disable the kill-switch poller.

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

- `src/App.tsx` - Main app logic and routing; the editor route builds the `ChartDocument` and wires undo, redo, import, AI edits and the create flows to it
- `shared/chart-model.ts` - Chart types, `normalizeChart` (ids, canonical connections; `ChartShapeError`, `assertChartShape`), id minting, `deepEqual`
- `shared/chart-merge.ts` - `mergeCharts(base, mine, theirs, { onConflict })`, the three-way merge and the home of its rules
- `shared/chart-wire.ts` - Wire shapes for `updateChart` and `pollChart`
- `src/sync/ChartDocument.ts` - The tab's chart store: server base, committed, live, undo history; `takeSave` / `saveSucceeded` / `saveConflicted` / `receiveRemote`. Undo and redo entries are `{ before, after }` pairs, replayed in revert form so they never overwrite what someone else changed since, and commits closer together than 300 ms share one entry. Every graph updater (`mutate`, `mutateDebounced`, the add/delete/move handlers) must return new arrays and objects and never write into the state it receives: the document keeps both sides of a change by reference (the updater tests deep-freeze their fixtures). Undo and redo are suppressed only while a text field has focus (`isTextEntryFocused`), not a slider or colour input.
- `src/sync/aiEdit.ts` - `prepareAIResult`: makes an AI reply's chart safe to merge (fresh ids, normalised)
- `src/hooks/useFieldBuffer.ts` - The text an open editor shows: what is being typed, else the field's value in the chart
- `src/components/TheoryOfChangeGraph.tsx` - Graph SVG renderer
- `src/components/ChatInterface.tsx` - AI assistant UI
- `src/services/chartService.ts` - API client for CRUD operations
- `src/hooks/useChartSave.ts` - Sends the document's saves (`doc.takeSave()`, then one of `saveSucceeded`, `saveConflicted`, `saveFailed`): a 300 ms debounce, one save in flight at a time, a 409 merged and sent again at once, edits made before the chart has a server sent once it has one, retries with backoff (capped at 30s) while edits stay unsaved, for network and 5xx failures (401/403 only at the 30s cap, never cut short; other 4xx none), and at once when the browser comes back online or the tab is shown again. A merge that throws, or a server that went back to an older version, stops saving and shows why in the pill
- `src/hooks/useChartSync.ts` - The 2.5 s version check (`pollChart`) that lands other people's changes in the document
- `src/utils/graphEdits.ts` - AI edit instruction parser and applier
- `src/components/canvas/AddControlZone.tsx` - Zones with the add-column / add-section controls and their resting cue, laid over the gaps of the chart
- `worker/index.ts` - Worker entry point (router, CORS, security headers)
- `worker/api/` - API route handlers (getChart, updateChart, etc.)
- `worker/api/pollChart.ts` - Read-only version check: the chart's version, with the chart only when it differs from `knownVersion`
- `worker/_shared/chart-edit-access.ts` - `authorizeChartEdit`, the one gate for who may edit a chart, shared by `updateChart` and `pollChart`
- `worker/api/anthropic-stream.ts` - AI streaming proxy (SSE, usage UPSERT, kill-switch, Turnstile gate). Exports `buildAssistantBlocksForCountTokens` (count_tokens validation rules) and `collectAssistantBlocksForAnalytics` (raw `content_blocks` capture).
- `worker/api/reconcile-cost.ts` - Client-driven fallback that pushes the running cost figure when the streaming reconcile IIFE was killed by `ctx.waitUntil()` time budget; clamps `GREATEST(existing, client)` so it can only push up. Updates `logging_messages.cost_micro_usd` only — never `user_api_usage`.
- `worker/api/count-tokens-estimate.ts` - Pre-send cost projection. Strips Files-API `document` blocks (count_tokens 400s on them), splits cached file tokens by draft vs history so the client prices cache-write vs cache-read correctly. Exports `sanitizeMessagesForCountTokens`, which repairs the count_tokens shape rules on the forwarded payload so shape-violating payloads can't 503 the estimate (contract hardening; the current UI doesn't produce these shapes — see the sanitizer's header for verified reachability notes).
- `worker/api/verify-turnstile.ts` - Turnstile challenge verification, issues `tocb_anon` session cookie
- `worker/api/upload-file.ts` - Anthropic Files API upload proxy, records rows in `chart_files`
- `worker/api/chart-files.ts` - `chart_files` cleanup (clear-chat and per-chart erasure)
- `worker/api/delete-my-data.ts` - User-initiated GDPR Art. 17 erasure (`DELETE /api/my-data`); dual-mode auth/anon
- `src/components/DeleteMyDataPanel.tsx` - "Delete all my data" UI affordance, lives inside the Data & Privacy modal
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

Run everything: `npm test` (watch mode: `npm run test:watch`; one project: `npx vitest run --project frontend`). `vitest.config.ts` defines two Vitest projects:

- **`workerd`**: `tests/worker/`, `tests/client/`, `tests/shared/` and the top-level `tests/*.test.ts`. They run inside a real Workers runtime via `@cloudflare/vitest-plugin`, with bindings and secrets from `wrangler.jsonc` and `.dev.vars`.
- **`frontend`**: `tests/frontend/**/*.test.{ts,tsx}`. They run in jsdom with React Testing Library and `@testing-library/jest-dom` for components, hooks and client utilities.

Concurrency has its own suites: `tests/shared/chart-merge.test.ts` and `chart-merge.fuzz.test.ts` (the merge rules, and a seeded fuzz of three clients over a compare-and-swap server), `tests/frontend/ChartDocument.test.ts` and `ChartDocument.sim.test.ts` (the document, and a seeded simulation of three tabs with random latency and lost acknowledgements), `tests/worker/updateChart-cas.test.ts`, `pollChart.test.ts` and `chart-edit-gate.test.ts` (versioned saves, the poll, and the access table both endpoints share), and two integration tests that run the real document, hooks and canvas over a mocked `ChartService`: `tests/frontend/remoteLandingWhileEditing.test.tsx` (a remote chart landing while someone types, drags or has an editor open) and `tests/frontend/App.chartDocument.test.tsx` (App's wiring). `tests/frontend/helpers/renderToC.tsx` mounts the canvas over a document with a way to land a remote chart. jsdom has no layout or real caret, so a landing while typing or dragging in a real browser is checked by hand in two tabs.

Add tests for new Worker helpers alongside the code; especially `anon-id.ts`, the kill-switch logic in `anthropic-stream.ts`, and `reserveCost` race-safety tests. jsdom does not do layout, so geometry (overflow, positions) needs a manual browser check.

Manual testing is still needed for end-to-end flows (graph editing, permissions, AI streaming):
1. Create chart → 2. Edit nodes/connections → 3. Share with different users → 4. Test permission flows

## Deployment

Manual deploy: `npm run deploy` (builds + deploys to Cloudflare Workers).

**Apply `database/migrations/add-chart-version.sql` to staging, then production, before deploying the Worker** (the Worker reads `version` on every chart read). On each database check that `SELECT version FROM charts LIMIT 1` succeeds and that `SELECT 1 FROM pg_trigger WHERE tgname = 'charts_bump_version'` returns a row; without the trigger every save matches its base forever and polls never see a change, with no error. To undo the migration, roll the Worker back first (the current one fails every chart read without the column), then run the down-step in the migration's header. After a deploy, watch `updateChart.conflict`, `updateChart.legacy` and `ChartMergeFailed` (see Common Issues).

Configuration: `wrangler.jsonc` (entry point, compatibility flags, static assets config).
