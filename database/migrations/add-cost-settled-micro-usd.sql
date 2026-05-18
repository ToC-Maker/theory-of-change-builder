-- Migration: Add cost_settled_micro_usd + reconciled_at to logging_messages
-- Created: 2026-05-16
-- Purpose: Add the per-stream cost high-water-mark column
--          (`cost_settled_micro_usd`) and the post-stream reconcile lock
--          (`reconciled_at`) used by the continuous delta-commit cost
--          tracking flow.
--
--          `cost_settled_micro_usd` is the monotone-up HWM of µUSD seen so
--          far for a given user-turn (logging_messages row keyed by
--          message_id = loggingMessageId, role='user'). It is written by
--          `applyDeltaCommit` (`worker/_shared/cost-commit.ts`) on every
--          running_cost emit and is GREATEST-clamped so it cannot regress.
--          After the post-stream reconcile completes, its value equals the
--          actual settled cost for that turn.
--
--          `reconciled_at` is stamped exactly once by the post-stream
--          reconcile path (the IIFE in `worker/api/anthropic-stream.ts`,
--          fallback `worker/api/reconcile-cost.ts`). It acts as the lock
--          against late retries from the client-side reconcile-cost retry
--          queue: every subsequent UPDATE includes
--          `WHERE reconciled_at IS NULL`, so once it is set, late writes
--          no-op.
-- Legal basis: No new PII; columns track existing internal cost metrics.

BEGIN;

ALTER TABLE logging_messages
ADD COLUMN IF NOT EXISTS cost_settled_micro_usd BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN logging_messages.cost_settled_micro_usd IS
  'Monotone-up µUSD high-water-mark for this stream, written by applyDeltaCommit (worker/_shared/cost-commit.ts) on every running_cost emit and GREATEST-clamped so it cannot regress. Final value after the post-stream reconcile equals the actual settled cost for the turn. Stored on the user-message row (loggingMessageId is the user-turn id); analytics that group by role should filter role=user.';

ALTER TABLE logging_messages
ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMP NULL;

COMMENT ON COLUMN logging_messages.reconciled_at IS
  'Stamped exactly once by the post-stream reconcile (IIFE in worker/api/anthropic-stream.ts; fallback worker/api/reconcile-cost.ts). Acts as the late-retry lock: subsequent UPDATEs include WHERE reconciled_at IS NULL, so retries from the client reconcile-cost queue no-op once it is set.';

COMMIT;
