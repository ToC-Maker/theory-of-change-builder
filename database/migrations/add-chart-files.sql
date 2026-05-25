-- Migration: Chart file uploads (Anthropic Files API)
-- Created: 2026-04-21
-- Purpose: Track file uploads associated with a chart so we can attach document
--          blocks by file_id to outgoing /v1/messages requests. Replaces the
--          client-side pdfjs text-extraction path; unlocks prompt caching on
--          PDFs and fixes the mangled-PDF glyph-shift bug.
-- Legal basis: Legitimate interests, Art. 6(1)(f) GDPR — necessary to deliver
--              the requested AI feature on user-supplied files.

BEGIN;

CREATE TABLE IF NOT EXISTS chart_files (
  file_id     TEXT NOT NULL PRIMARY KEY,
  chart_id    VARCHAR(12) NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
  user_id     TEXT,
  filename    TEXT NOT NULL,
  size_bytes  BIGINT,
  mime_type   TEXT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chart_files_chart ON chart_files(chart_id);
CREATE INDEX IF NOT EXISTS idx_chart_files_user ON chart_files(user_id) WHERE user_id IS NOT NULL;

COMMIT;
