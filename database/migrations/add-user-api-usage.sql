-- Migration: Per-user API usage (cost-denominated)
-- Created: 2026-04-21
-- Purpose: Authoritative source for lifetime cost-cap enforcement. Tracks full
--          Anthropic usage breakdown (input/output/cache/web-search) plus computed
--          cost in micro-USD. Replaces the legacy user_token_usage table (frozen
--          in freeze-user-token-usage.sql) for go-forward accounting.
-- Legal basis: Legitimate interests, Art. 6(1)(f) GDPR — necessary for abuse
--              prevention and cost control on a free service.

BEGIN;

CREATE TABLE IF NOT EXISTS user_api_usage (
  user_id             TEXT PRIMARY KEY,           -- auth0 sub OR `anon-<hmac>`
  input_tokens        BIGINT NOT NULL DEFAULT 0,
  output_tokens       BIGINT NOT NULL DEFAULT 0,
  cache_create_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens   BIGINT NOT NULL DEFAULT 0,
  web_search_uses     INT    NOT NULL DEFAULT 0,
  cost_micro_usd      BIGINT NOT NULL DEFAULT 0,
  first_activity_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE user_api_usage IS 'Per-user cumulative API usage with full Anthropic breakdown + computed cost. Authoritative source for lifetime-cap enforcement. Populated server-side from SSE message_delta.usage events in worker/api/anthropic-stream.ts. Anon-to-auth migration folds rows via worker/_shared/auth.ts:tryMigrateUser().';

COMMIT;
