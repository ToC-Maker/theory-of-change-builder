-- Migration: Add cost_settled_micro_usd + reconciled_at to logging_messages
-- Created: 2026-05-16
-- Purpose: Add cost_settled_micro_usd high-water-mark + reconciled_at lock
--          columns to logging_messages for the continuous delta-commit cost
--          tracking flow. cost_settled_micro_usd is the monotone-up HWM
--          written by applyDeltaCommit on every running_cost emit;
--          reconciled_at is stamped exactly once by the post-stream
--          signed-delta SQL and acts as the lock against late client retries
--          from the 7-day reconcile-cost queue.
-- Legal basis: No new PII; columns track existing internal cost metrics.

BEGIN;

ALTER TABLE logging_messages
ADD COLUMN IF NOT EXISTS cost_settled_micro_usd BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN logging_messages.cost_settled_micro_usd IS
  'High-water-mark µUSD seen for this stream. Monotone-up during stream via GREATEST + applyDeltaCommit. Final value after reconcile = actual. Stored on the user-message row (loggingMessageId in the worker is the user-turn id); analytics queries that group by role should filter role=user.';

ALTER TABLE logging_messages
ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMP NULL;

COMMENT ON COLUMN logging_messages.reconciled_at IS
  'Set by post-stream reconcile (single signed-delta SQL). Lock against late client retries from the 7-day reconcile-cost retry queue.';

COMMIT;
