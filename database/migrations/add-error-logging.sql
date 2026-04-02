-- Migration: Error Logging
-- Created: 2026-04-02
-- Purpose: Store client-side error reports for debugging (e.g., network errors, API failures)
-- Legal basis: Same as usage logging - Legitimate interests, Art. 6(1)(f) GDPR
-- Note: Opted-out users' errors are not stored. Enforced both client-side and server-side.

BEGIN;

CREATE TABLE IF NOT EXISTS logging_errors (
  id SERIAL PRIMARY KEY,
  error_id UUID NOT NULL UNIQUE,
  error_name TEXT NOT NULL,            -- e.g. TypeError, Error
  error_message TEXT NOT NULL,         -- original error.message (not the user-facing one)
  http_status INTEGER,                 -- response status code if available
  stack_trace TEXT,                     -- error.stack, truncated client-side to 4KB
  user_agent TEXT,
  user_id TEXT,
  chart_id VARCHAR(12) REFERENCES charts(id) ON DELETE SET NULL,
  session_id UUID REFERENCES logging_sessions(session_id) ON DELETE SET NULL,
  request_metadata JSONB,              -- model, mode, messageCount, features enabled
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logging_errors_created ON logging_errors(created_at);
CREATE INDEX IF NOT EXISTS idx_logging_errors_chart ON logging_errors(chart_id);
CREATE INDEX IF NOT EXISTS idx_logging_errors_error_name ON logging_errors(error_name);

COMMENT ON TABLE logging_errors IS 'Client-side error reports for debugging AI chat failures';

-- Extend the existing purge function to also clean up error logs
CREATE OR REPLACE FUNCTION purge_old_logging_data() RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
  error_deleted INTEGER;
BEGIN
  DELETE FROM logging_sessions
  WHERE started_at < NOW() - INTERVAL '24 months';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  DELETE FROM logging_errors
  WHERE created_at < NOW() - INTERVAL '24 months';
  GET DIAGNOSTICS error_deleted = ROW_COUNT;

  RAISE NOTICE 'Purged % logging sessions and % error logs older than 24 months', deleted_count, error_deleted;
  RETURN deleted_count + error_deleted;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION purge_old_logging_data() IS 'Purge logging sessions (and cascaded messages/snapshots) and error logs older than 24 months.';

COMMIT;
