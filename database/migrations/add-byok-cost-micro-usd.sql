-- Migration: Add byok_cost_micro_usd to user_api_usage
-- Created: 2026-05-17
-- Purpose: Separate the BYOK-spend signal from the free-tier-cap signal.
--          `user_api_usage.cost_micro_usd` is the column that `reserveCost`
--          (`worker/api/anthropic-stream.ts`) checks against
--          `LIFETIME_CAP_MICRO_USD` — it must reflect free-tier spend only,
--          or BYOK users would consume their own free cap by paying with
--          their own key. This column gives BYOK its own counter so the cap
--          check stays free-only while total BYOK spend remains observable
--          (display sums both columns).
--
--          Routing: deltas are routed to `byok_cost_micro_usd` vs
--          `cost_micro_usd` by `applyDeltaCommit` (`worker/_shared/cost-commit.ts`)
--          during per-update commits, and again by the post-stream
--          signed-delta reconcile (IIFE in `worker/api/anthropic-stream.ts`;
--          fallback `worker/api/reconcile-cost.ts`), based on whether the
--          request actor was BYOK. The two counters are independent — a
--          BYOK delta never touches `cost_micro_usd` and so never moves the
--          free-tier cap-bar.
-- Legal basis: No new PII; column tracks existing internal cost metric.

BEGIN;

ALTER TABLE user_api_usage
ADD COLUMN IF NOT EXISTS byok_cost_micro_usd BIGINT NOT NULL DEFAULT 0;

COMMENT ON COLUMN user_api_usage.byok_cost_micro_usd IS
  'Cumulative BYOK-tier µUSD for this user. Written by applyDeltaCommit (worker/_shared/cost-commit.ts) on per-update commits and by the post-stream signed-delta reconcile (worker/api/anthropic-stream.ts IIFE; fallback worker/api/reconcile-cost.ts) when the actor is BYOK. Independent of cost_micro_usd (the free-tier counter that reserveCost checks against LIFETIME_CAP_MICRO_USD) — BYOK deltas never move the free cap. Display sums both columns for total spend.';

COMMIT;
