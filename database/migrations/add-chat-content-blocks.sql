-- Add content_blocks (TEXT) + was_killed columns to logging_messages.
-- Idempotent. Created 2026-04-25.

BEGIN;

ALTER TABLE logging_messages
  ADD COLUMN IF NOT EXISTS content_blocks TEXT;

COMMENT ON COLUMN logging_messages.content_blocks IS
  'Raw client-supplied JSON bytes for the message content blocks discriminated union (see shared/chat-blocks.ts). NULL for legacy rows written before this column existed; analytics treats NULL as text-only fallback to logging_messages.content. Stored as TEXT (not JSONB) so signed thinking blocks round-trip byte-identical for replay/fork via Anthropic API.';

ALTER TABLE logging_messages
  ADD COLUMN IF NOT EXISTS was_killed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN logging_messages.was_killed IS
  'True iff this assistant turn was terminated by the cost-cap kill switch. content_blocks holds the truncated-to-last-complete snapshot, safe to replay. Distinct from client-aborted (the user clicked Stop) which is not currently tracked separately.';

COMMIT;

-- Rollback (run manually if needed):
-- BEGIN;
-- ALTER TABLE logging_messages DROP COLUMN IF EXISTS was_killed;
-- ALTER TABLE logging_messages DROP COLUMN IF EXISTS content_blocks;
-- COMMIT;
