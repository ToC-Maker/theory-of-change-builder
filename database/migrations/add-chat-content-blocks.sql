-- Migration: Persist rich content blocks + kill marker for analytics
-- Created: 2026-04-25
--
-- Adds columns to logging_messages so the analytics team can:
--   1. See full assistant content (text + signed thinking + tool_use +
--      tool_results) instead of just cleaned text. Useful for AI quality
--      eval and for forking conversations to test alternative responses.
--   2. Distinguish assistant turns cut short by the cost-cap kill switch
--      from cleanly-completed turns.
--
-- content_blocks is TEXT (not JSONB) so the literal JSON bytes the client
-- supplied round-trip byte-identical. JSONB would normalize key ordering /
-- whitespace / numbers, which could break Anthropic signature verification
-- on replay (the signature covers the block envelope, not just the
-- signature string field).
--
-- Idempotent. Safe to re-run.

BEGIN;

ALTER TABLE logging_messages
  ADD COLUMN IF NOT EXISTS content_blocks TEXT;

COMMENT ON COLUMN logging_messages.content_blocks IS
  'Raw client-supplied JSON bytes for the message content blocks ' ||
  'discriminated union (see shared/chat-blocks.ts). NULL for legacy ' ||
  'rows written before this column existed; analytics treats NULL ' ||
  'as text-only fallback to logging_messages.content. Stored as TEXT ' ||
  '(not JSONB) so signed thinking blocks round-trip byte-identical for ' ||
  'replay/fork via Anthropic API.';

ALTER TABLE logging_messages
  ADD COLUMN IF NOT EXISTS was_killed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN logging_messages.was_killed IS
  'True iff this assistant turn was terminated by the cost-cap kill ' ||
  'switch. content_blocks holds the truncated-to-last-complete snapshot, ' ||
  'safe to replay. Distinct from client-aborted (the user clicked Stop) ' ||
  'which is not currently tracked separately.';

COMMIT;

-- Rollback (run manually if needed):
-- BEGIN;
-- ALTER TABLE logging_messages DROP COLUMN IF EXISTS was_killed;
-- ALTER TABLE logging_messages DROP COLUMN IF EXISTS content_blocks;
-- COMMIT;
