ALTER TABLE logging_messages
ADD COLUMN IF NOT EXISTS cost_settled_micro_usd BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN logging_messages.cost_settled_micro_usd IS
  'High-water-mark µUSD seen for this stream. Monotone-up during stream via GREATEST + applyDeltaCommit. Final value after reconcile = actual. Stored on the user-message row (loggingMessageId in the worker is the user-turn id); analytics queries that group by role should filter role=user.';

ALTER TABLE logging_messages
ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMP NULL;

COMMENT ON COLUMN logging_messages.reconciled_at IS
  'Set by post-stream reconcile (single signed-delta SQL). Lock against late client retries from the 7-day reconcile-cost retry queue.';
