-- Migration: Refresh cost-tracking COMMENT ON metadata to remove plan-task vocabulary
-- Created: 2026-05-17
-- Purpose: The COMMENT ON COLUMN / COMMENT ON INDEX text written by the
--          earlier cost-tracking migrations (`add-cost-settled-micro-usd.sql`,
--          `add-logging-errors-per-update-index.sql`,
--          `recreate-logging-errors-per-update-index-with-uuid.sql`,
--          `add-byok-cost-micro-usd.sql`) referenced plan-task ordinals
--          ("Task 7" / "Task 8" / "post-stream signed-delta SQL" / "Pre-PR").
--          Those references will become unresolvable noise once the source
--          plan (`plans/byok-cost-stream-recovery.md`) is archived — it is
--          gitignored and only exists in worktrees during active development.
--
--          The source-of-truth SQL files have been rewritten to describe the
--          function/invariant by code symbol (`applyDeltaCommit`,
--          `firePerUpdateCommit`, `DiagnosticPerUpdateCommit`, `reserveCost`,
--          `LIFETIME_CAP_MICRO_USD`). This migration re-issues the same
--          cleaned-up COMMENT ON statements so the live Postgres metadata
--          (what an operator sees from `\d+ logging_messages` / `\d+
--          user_api_usage` / `\di+ idx_logging_errors_per_update_message_id`)
--          matches the source files. COMMENT ON is idempotent — it
--          overwrites — so this is safe to re-run.
-- Legal basis: Metadata-only change; no schema or data change.

BEGIN;

COMMENT ON COLUMN logging_messages.cost_settled_micro_usd IS
  'Monotone-up µUSD high-water-mark for this stream, written by applyDeltaCommit (worker/_shared/cost-commit.ts) on every running_cost emit and GREATEST-clamped so it cannot regress. Final value after the post-stream reconcile equals the actual settled cost for the turn. Stored on the user-message row (loggingMessageId is the user-turn id); analytics that group by role should filter role=user.';

COMMENT ON COLUMN logging_messages.reconciled_at IS
  'Stamped exactly once by the post-stream reconcile (IIFE in worker/api/anthropic-stream.ts; fallback worker/api/reconcile-cost.ts). Acts as the late-retry lock: subsequent UPDATEs include WHERE reconciled_at IS NULL, so retries from the client reconcile-cost queue no-op once it is set.';

COMMENT ON COLUMN user_api_usage.byok_cost_micro_usd IS
  'Cumulative BYOK-tier µUSD for this user. Written by applyDeltaCommit (worker/_shared/cost-commit.ts) on per-update commits and by the post-stream signed-delta reconcile (worker/api/anthropic-stream.ts IIFE; fallback worker/api/reconcile-cost.ts) when the actor is BYOK. Independent of cost_micro_usd (the free-tier counter that reserveCost checks against LIFETIME_CAP_MICRO_USD) — BYOK deltas never move the free cap. Display sums both columns for total spend.';

COMMENT ON INDEX idx_logging_errors_per_update_message_id IS
  'Partial expression index over DiagnosticPerUpdateCommit rows in logging_errors. Indexed expression is cast to UUID to match logging_messages.message_id, otherwise the planner skips the index for the natural (...->>field)::uuid join syntax used by the cost-recovery runbook joining logging_errors to logging_messages on logging_message_id. Diagnostic rows are written by firePerUpdateCommit / applyDeltaCommit on every running_cost emit.';

COMMIT;
