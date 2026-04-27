-- Migration: User BYOK (Bring Your Own Key) storage
-- Created: 2026-04-21
-- Purpose: Store user-supplied Anthropic API keys so authenticated users who
--          have hit the $5 lifetime cap (or prefer to self-fund from the start)
--          can continue using the service on their own billing. Keys are
--          encrypted at rest; only the last 4 characters are stored in clear
--          text for UI display.
-- Legal basis: Consent, Art. 6(1)(a) GDPR — user explicitly supplies the key
--              as an opt-in alternative to our metered free tier.

BEGIN;

CREATE TABLE IF NOT EXISTS user_byok_keys (
  user_id       TEXT PRIMARY KEY,
  encrypted_key BYTEA NOT NULL,
  key_last4     CHAR(4) NOT NULL,
  verified_at   TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN user_byok_keys.encrypted_key IS 'Layout: iv (12 bytes) || ciphertext || gcm tag (16 bytes). Encrypted with AES-GCM using env.BYOK_ENCRYPTION_KEY as master key and user_id bytes as AAD.';

COMMIT;
