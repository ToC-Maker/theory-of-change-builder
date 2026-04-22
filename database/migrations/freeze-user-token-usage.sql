-- Migration: Freeze legacy user_token_usage table
-- Created: 2026-04-21
-- Purpose: Block future writes to user_token_usage via a NOT VALID CHECK (false)
--          constraint. The table's total_tokens_used column is underreported
--          (sums only input+output, excludes cache_creation / cache_read /
--          web_search) and mixes models at different prices, so it cannot be
--          used for cost analysis. Forward-looking data lives in user_api_usage.
--          Kept for historical reference only.
-- Legal basis: No new data collection — this migration only restricts writes.

BEGIN;

-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`; guard with a catalog lookup
-- so re-runs on PR synchronize don't error on the existing constraint.
-- NOT VALID so existing rows are not re-validated; the constraint blocks
-- future INSERT/UPDATE that would produce a row (DELETE is unaffected —
-- useful for GDPR).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_token_usage_frozen'
      AND conrelid = 'user_token_usage'::regclass
  ) THEN
    ALTER TABLE user_token_usage
      ADD CONSTRAINT user_token_usage_frozen CHECK (false) NOT VALID;
  END IF;
END $$;

COMMENT ON TABLE user_token_usage IS 'FROZEN 2026-04-21. LEGACY — do not read for cost/usage analysis and do not write. total_tokens_used is underreported: sums only input+output (excludes cache_creation, cache_read, web_search) and mixes models at different prices (Opus 4.6 $5/$25 vs Sonnet 4.6 $3/$15). For current data see user_api_usage. Kept for historical reference only.';

COMMENT ON COLUMN user_token_usage.total_tokens_used IS 'LEGACY. Sums input+output tokens only; excludes cache tokens and web-search uses. Not comparable across users due to mixed model pricing.';

COMMIT;
