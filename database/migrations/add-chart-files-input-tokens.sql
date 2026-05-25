-- Migration: chart_files.input_tokens column
-- Created: 2026-04-23
-- Purpose: Cache the exact input-token count of an uploaded file so the
--          composer cost estimate + anthropic-stream preflight can report a
--          precise number for PDFs, not a pageCount-based heuristic.
--
--          Anthropic's count_tokens endpoint does NOT accept the file_id
--          source variant — only base64, text, url, and inline content. So
--          we count once at upload time (we still have the bytes in the
--          multipart POST) by sending the PDF as Base64PDFSource, and stash
--          the result here. Every downstream estimator just SUMs this column
--          for the referenced file_ids.
--
--          NULL means "not counted yet" (e.g. rows pre-migration, or a
--          count_tokens failure at upload — we don't block upload on the
--          counting call). Consumers should treat NULL as an unknown
--          quantity and fall back to the pageCount × 400 heuristic, or
--          document the known-unknown in the UI.

BEGIN;

ALTER TABLE chart_files
  ADD COLUMN IF NOT EXISTS input_tokens BIGINT;

COMMIT;
