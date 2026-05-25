-- Migration: Idempotency keys for /api/anthropic-stream
-- Created: 2026-04-21
-- Purpose: Back the 60s dedup window for the X-Idempotency-Key header on the
--          anthropic-stream route. Clients supply a UUID; the Worker rejects
--          duplicates within the window so that accidental double-submits
--          (double-click, retry on network blip) don't double-charge the user
--          or double-bill our Anthropic account.
-- Legal basis: Legitimate interests, Art. 6(1)(f) GDPR — necessary to prevent
--              duplicate-charge abuse and protect platform cost.

BEGIN;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id    TEXT NOT NULL,
  key        TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);

COMMENT ON TABLE idempotency_keys IS 'Backs the 60s dedup window for the X-Idempotency-Key header on the anthropic-stream route. Rows are inserted before the upstream fetch and pruned by a periodic cleanup that deletes entries older than the dedup window.';

COMMIT;
