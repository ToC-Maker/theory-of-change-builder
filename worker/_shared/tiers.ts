/**
 * Tier constants and pure helpers for free / anon / BYOK classification.
 *
 * No DB access, no I/O -- tier rules live as code constants (not a DB table)
 * because they don't need hot-reload complexity. Cap changes land via deploy.
 */

import {
  ANTHROPIC_MESSAGES_REQUEST_BODY_BYTES,
  ANTHROPIC_FILE_UPLOAD_BYTES,
} from '../../shared/anthropic-limits';

// All caps are declared in USD as the single source of truth; the micro-USD
// counterparts (used for BigInt arithmetic in cost accounting) are derived.
// If you change a cap, change the USD value — the micro-USD follows.
//
// Math.round handles non-integer USD values (e.g. $2.50) — a plain
// `BigInt(usd)` throws on floats. The µUSD grain is fine enough that any
// residual float wobble (e.g. 0.1 + 0.2) rounds cleanly back to an integer.
const usdToMicro = (usd: number): bigint => BigInt(Math.round(usd * 1_000_000));

// Per-user lifetime cap across all free-tier users (auth'd + anon).
// Context: p50 auth-user usage ~45K tokens (~$0.33), p90 ~1M tokens (~$7.22).
// $5 covers most users' first substantial chart work; power users hit BYOK.
export const LIFETIME_CAP_USD = 5;
export const LIFETIME_CAP_MICRO_USD = usdToMicro(LIFETIME_CAP_USD);

// Server-side overspend tolerance applied ONLY to the mid-stream kill switch.
// Preflight (composer gating, reserveCost) stays strict at LIFETIME_CAP_USD so
// users never knowingly start a request that would overrun budget. But the
// kill switch can't cut mid-sentence cleanly, so a small slack lets large
// legitimate responses finish rather than being truncated a few cents over.
// Reconciled actual cost still writes through to user_api_usage, so the cap
// bar can read e.g. $5.03 of $5.00 after a tolerant-kill stream; the client
// then blocks further sends via the strict preflight gate.
export const CAP_OVERSPEND_TOLERANCE_FRACTION = 0.05;

// Number round-trip is safe here: LIFETIME_CAP_MICRO_USD is bounded by the
// displayed cap (a small-integer µUSD value), so Number(cap) is exact and the
// tolerance multiplication stays well inside Number.MAX_SAFE_INTEGER. Math.round
// handles any float residue before converting back to BigInt.
const CAP_TOLERANCE_MICRO_USD = BigInt(
  Math.round(Number(LIFETIME_CAP_MICRO_USD) * CAP_OVERSPEND_TOLERANCE_FRACTION),
);
export const EFFECTIVE_LIFETIME_CAP_MICRO_USD = LIFETIME_CAP_MICRO_USD + CAP_TOLERANCE_MICRO_USD;

// Re-export the Anthropic-imposed request/file ceilings under the names
// existing callers use. Single source of truth is shared/anthropic-limits.ts.
export const BODY_SIZE_LIMIT_BYTES = ANTHROPIC_MESSAGES_REQUEST_BODY_BYTES;
export const FILE_UPLOAD_LIMIT_BYTES = ANTHROPIC_FILE_UPLOAD_BYTES;

// Idempotency window for de-duplicating retried requests (seconds).
export const IDEMPOTENCY_WINDOW_SECONDS = 60;

export type Tier = 'anon' | 'free' | 'byok';

/**
 * Classify an actor into a tier.
 *
 * Anonymous actors have IDs prefixed with `anon-`. BYOK presence
 * overrides -- a BYOK header makes the request self-funded regardless of
 * whether the actor is authenticated. Callers that want to block BYOK for
 * anon users should consult `allowByok()` against the actor's base identity.
 */
export function tierFor(actorId: string, hasByokHeader: boolean): Tier {
  if (hasByokHeader) return 'byok';
  if (actorId.startsWith('anon-')) return 'anon';
  return 'free';
}

export const isCapped = (tier: Tier) => tier !== 'byok';
export const allowByok = (tier: Tier) => tier !== 'anon';
export const needTurnstile = (tier: Tier) => tier === 'anon';
