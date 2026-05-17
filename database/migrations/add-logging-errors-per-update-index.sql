-- Migration: Partial expression index on logging_errors for per-update diagnostics
-- Created: 2026-05-16
-- Purpose: The per-update-commit pipeline (`firePerUpdateCommit` in
--          `worker/api/anthropic-stream.ts`, which calls `applyDeltaCommit`
--          from `worker/_shared/cost-commit.ts`) writes a diagnostic row to
--          `logging_errors` with `error_name = 'DiagnosticPerUpdateCommit'`
--          on every running_cost emit. The row is keyed to the triggering
--          user-turn via `request_metadata->>'logging_message_id'`.
--
--          The cost-recovery runbook joins these diagnostic rows back to
--          `logging_messages` on `logging_message_id` to compute coverage,
--          drift, and stuck-stream metrics. A partial expression index over
--          just the DiagnosticPerUpdateCommit rows keeps the index small
--          (most logging_errors rows are real client errors, not
--          diagnostics) while making those joins index-driven instead of
--          full-table scans.
-- Legal basis: No new data collection — index over existing columns only.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_logging_errors_per_update_message_id
ON logging_errors ((request_metadata->>'logging_message_id'))
WHERE error_name = 'DiagnosticPerUpdateCommit';

COMMENT ON INDEX idx_logging_errors_per_update_message_id IS
  'Partial expression index over DiagnosticPerUpdateCommit rows in logging_errors. Supports the cost-recovery runbook joins from logging_errors to logging_messages on logging_message_id (the diagnostic rows are written by firePerUpdateCommit / applyDeltaCommit on every running_cost emit).';

COMMIT;
