-- Migration: Partial expression index on logging_errors for per-update diagnostics
-- Created: 2026-05-16
-- Purpose: The Task 7 per-update-commit path writes a `DiagnosticPerUpdateCommit`
--          row to logging_errors on every running_cost emit, keyed to the
--          triggering user-turn via request_metadata->>'logging_message_id'.
--          The cost-recovery runbook joins logging_errors back to
--          logging_messages on this key to compute coverage, drift, and
--          stuck-stream metrics. A partial expression index over just the
--          diagnostic rows keeps the index small (most logging_errors rows
--          are real client errors, not diagnostics) while making those joins
--          index-driven instead of full-table scans.
-- Legal basis: No new data collection — index over existing columns only.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_logging_errors_per_update_message_id
ON logging_errors ((request_metadata->>'logging_message_id'))
WHERE error_name = 'DiagnosticPerUpdateCommit';

COMMENT ON INDEX idx_logging_errors_per_update_message_id IS
  'Partial expression index for the Task 7 per-update-commit diagnostics. Used by the cost-recovery runbook to join logging_errors to logging_messages on logging_message_id.';

COMMIT;
