-- Migration: Per-message cost attribution
-- Created: 2026-04-21
-- Purpose: Add cost_micro_usd to logging_messages so we can answer "which chart
--          cost $X" queries by JOIN + SUM, without maintaining a separate
--          per-chart aggregate table. Populated by the post-stream reconcile
--          in worker/api/anthropic-stream.ts alongside the user_api_usage and
--          global_monthly_usage UPSERTs.
-- Legal basis: Same as the parent logging_messages table — legitimate interests,
--              Art. 6(1)(f) GDPR (abuse prevention and cost control).

BEGIN;

ALTER TABLE logging_messages
  ADD COLUMN IF NOT EXISTS cost_micro_usd BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN logging_messages.cost_micro_usd IS 'Per-message cost in micro-USD. Populated by the post-stream reconcile in worker/api/anthropic-stream.ts from the final message_delta.usage SSE event, using the per-model rate table in worker/_shared/cost.ts. Enables per-chart cost attribution via JOIN on chart_id + SUM.';

COMMIT;
