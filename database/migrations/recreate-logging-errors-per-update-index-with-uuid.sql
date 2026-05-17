-- Migration: Recreate idx_logging_errors_per_update_message_id with ::uuid cast
-- Created: 2026-05-17
-- Purpose: The original index stored the indexed expression as TEXT, but
--          runbook Query B joins on (request_metadata->>'logging_message_id')::uuid.
--          Postgres can't use a TEXT-typed expression index for a UUID-typed
--          join predicate — it has to recompute per row, defeating the index.
--          Drop and recreate with the cast baked into the index expression so
--          the storage type matches the join's RHS.
-- Legal basis: No new data collection — index re-shaping over existing columns.

BEGIN;

DROP INDEX IF EXISTS idx_logging_errors_per_update_message_id;

CREATE INDEX IF NOT EXISTS idx_logging_errors_per_update_message_id
ON logging_errors (((request_metadata->>'logging_message_id')::uuid))
WHERE error_name = 'DiagnosticPerUpdateCommit';

COMMENT ON INDEX idx_logging_errors_per_update_message_id IS
  'Partial expression index supporting the cost-recovery runbook joins
   (logging_errors → logging_messages on logging_message_id) for
   DiagnosticPerUpdateCommit rows. Indexed expression is cast to UUID to
   match logging_messages.message_id type, otherwise planner skips the
   index when callers use the natural (...->>field)::uuid join syntax.';

COMMIT;
