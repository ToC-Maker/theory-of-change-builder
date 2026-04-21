-- Migration: Global monthly usage counter
-- Created: 2026-04-21
-- Purpose: Observability counter for our aggregate Anthropic spend. Enforcement
--          is handled by the Anthropic Console customer-set cap ($100/mo); this
--          table exists so we can see spend in near-real-time instead of waiting
--          on Anthropic billing emails (~24h lag).
-- Legal basis: Internal operational metric — no personal data stored.

BEGIN;

CREATE TABLE IF NOT EXISTS global_monthly_usage (
  month_start    DATE   PRIMARY KEY,   -- first of month UTC
  cost_micro_usd BIGINT NOT NULL DEFAULT 0
);

COMMENT ON TABLE global_monthly_usage IS 'Observability counter for our aggregate Anthropic spend. NOT an enforcement mechanism — the Anthropic Console customer-set cap ($100/mo) is the hard stop. This table lets us see spend in near-real-time instead of waiting on Anthropic billing emails (~24h lag).';

COMMIT;
