-- Migration: Usage Logging System
-- Created: 2025-12-04
-- Updated: 2026-03-11 - Removed user_email (data minimization), added 24-month auto-purge
-- Purpose: Track user sessions, chat messages, and graph edits for AI evaluation
-- Legal basis: Legitimate interests, Art. 6(1)(f) GDPR - see docs/legitimate-interest-assessment.md
-- Note: Opted-out users' data is not stored at all (handled on frontend)

BEGIN;

-- Table 1: Session tracking
CREATE TABLE IF NOT EXISTS logging_sessions (
  session_id UUID PRIMARY KEY,
  chart_id VARCHAR(12) REFERENCES charts(id) ON DELETE SET NULL,  -- Keep logs when chart deleted
  user_id TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logging_sessions_chart ON logging_sessions(chart_id);
CREATE INDEX IF NOT EXISTS idx_logging_sessions_user ON logging_sessions(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_logging_sessions_started ON logging_sessions(started_at);

COMMENT ON TABLE logging_sessions IS 'User session tracking for usage logging and future evaluation';

-- Table 2: Chat message logs
CREATE TABLE IF NOT EXISTS logging_messages (
  id SERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES logging_sessions(session_id) ON DELETE CASCADE,
  message_id UUID NOT NULL UNIQUE,
  chart_id VARCHAR(12) REFERENCES charts(id) ON DELETE SET NULL,  -- Keep logs when chart deleted
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW(),
  usage_input_tokens INTEGER,
  usage_output_tokens INTEGER,
  usage_total_tokens INTEGER,
  user_id TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logging_messages_session ON logging_messages(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_logging_messages_chart ON logging_messages(chart_id);
CREATE INDEX IF NOT EXISTS idx_logging_messages_message_id ON logging_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_logging_messages_timestamp ON logging_messages(timestamp);

COMMENT ON TABLE logging_messages IS 'Chat message logs for AI evaluation and prompt engineering';

-- Table 3: Graph state snapshots
CREATE TABLE IF NOT EXISTS logging_snapshots (
  id SERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES logging_sessions(session_id) ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  chart_id VARCHAR(12) REFERENCES charts(id) ON DELETE SET NULL,  -- Keep logs when chart deleted
  graph_data JSONB NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW(),
  edit_type VARCHAR(20) NOT NULL CHECK (edit_type IN ('ai_edit', 'manual_edit', 'undo', 'redo', 'initial')),
  triggered_by_message_id UUID REFERENCES logging_messages(message_id),
  edit_instructions JSONB,
  edit_success BOOLEAN DEFAULT TRUE,
  error_message TEXT,
  user_id TEXT,
  is_authenticated BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(session_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS idx_logging_snapshots_session_seq ON logging_snapshots(session_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_logging_snapshots_chart ON logging_snapshots(chart_id);
CREATE INDEX IF NOT EXISTS idx_logging_snapshots_message ON logging_snapshots(triggered_by_message_id) WHERE triggered_by_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_logging_snapshots_timestamp ON logging_snapshots(timestamp);
CREATE INDEX IF NOT EXISTS idx_logging_snapshots_edit_type ON logging_snapshots(edit_type);

COMMENT ON TABLE logging_snapshots IS 'Graph state snapshots after each edit for replay and evaluation';

COMMIT;

-- =============================================================================
-- Auto-purge: 24-month retention policy
-- Retention period: 24 months from session start
-- CASCADE on logging_sessions will automatically delete associated messages and snapshots.
-- Schedule this to run periodically (e.g., daily or weekly via pg_cron or external cron job).
-- =============================================================================

-- To install pg_cron (if available on your PostgreSQL provider):
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   SELECT cron.schedule('purge-old-logging-data', '0 3 * * 0',
--     $$DELETE FROM logging_sessions WHERE started_at < NOW() - INTERVAL '24 months'$$
--   );

-- Standalone purge function (can be called manually or via external cron):
CREATE OR REPLACE FUNCTION purge_old_logging_data() RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM logging_sessions
  WHERE started_at < NOW() - INTERVAL '24 months';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Purged % logging sessions older than 24 months', deleted_count;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION purge_old_logging_data() IS 'Purge logging sessions (and cascaded messages/snapshots) older than 24 months. Schedule via pg_cron or external cron job.';

-- Rollback script (save separately or run manually if needed):
-- BEGIN;
-- DROP FUNCTION IF EXISTS purge_old_logging_data();
-- DROP TABLE IF EXISTS logging_snapshots CASCADE;
-- DROP TABLE IF EXISTS logging_messages CASCADE;
-- DROP TABLE IF EXISTS logging_sessions CASCADE;
-- COMMIT;
