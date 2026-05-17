-- Migration: Add byok_cost_micro_usd to user_api_usage
-- Created: 2026-05-17
-- Purpose: Separate the BYOK-spend signal from the free-tier-cap signal.
--          Pre-PR, BYOK never wrote to user_api_usage; Tasks 7+8 changed
--          that for cost-accuracy reasons but inadvertently coupled BYOK
--          spend to the free cap (reserveCost's cap-check reads
--          cost_micro_usd). This column gives BYOK its own counter so the
--          cap check stays free-only while total spend remains observable.
-- Legal basis: No new PII; column tracks existing internal cost metric.

BEGIN;

ALTER TABLE user_api_usage
ADD COLUMN IF NOT EXISTS byok_cost_micro_usd BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN user_api_usage.byok_cost_micro_usd IS
  'Cumulative BYOK-tier µUSD for this user. Written by applyDeltaCommit and the post-stream signed-delta reconcile when tier=byok. Independent of cost_micro_usd (free-tier counter that reserveCost checks against LIFETIME_CAP_MICRO_USD). Display sums both for total spend.';

COMMIT;
