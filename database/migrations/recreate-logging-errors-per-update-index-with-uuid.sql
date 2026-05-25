-- Migration: Recreate idx_logging_errors_per_update_message_id with ::uuid cast
-- Created: 2026-05-17
-- Purpose: The original index stored the indexed expression as TEXT, but
--          the cost-recovery runbook (and any caller joining diagnostic
--          rows back to logging_messages) uses the natural
--          (request_metadata->>'logging_message_id')::uuid syntax — Postgres
--          can't use a TEXT-typed expression index for a UUID-typed join
--          predicate, so it has to recompute per row and the index goes
--          unused. Drop and recreate with the cast baked into the index
--          expression so the storage type matches `logging_messages.message_id`
--          (UUID).
--
--          The diagnostic rows being indexed (`error_name =
--          'DiagnosticPerUpdateCommit'`) are written by `firePerUpdateCommit`
--          / `applyDeltaCommit` on every running_cost emit; see the original
--          migration `add-logging-errors-per-update-index.sql` for the full
--          rationale.
-- Legal basis: No new data collection — index re-shaping over existing columns.

BEGIN;

DROP INDEX IF EXISTS idx_logging_errors_per_update_message_id;

CREATE INDEX IF NOT EXISTS idx_logging_errors_per_update_message_id
ON logging_errors (((request_metadata->>'logging_message_id')::uuid))
WHERE error_name = 'DiagnosticPerUpdateCommit';

COMMENT ON INDEX idx_logging_errors_per_update_message_id IS
  'Partial expression index over DiagnosticPerUpdateCommit rows in logging_errors. Indexed expression is cast to UUID to match logging_messages.message_id, otherwise the planner skips the index for the natural (...->>field)::uuid join syntax used by the cost-recovery runbook joining logging_errors to logging_messages on logging_message_id. Diagnostic rows are written by firePerUpdateCommit / applyDeltaCommit on every running_cost emit.';

COMMIT;
