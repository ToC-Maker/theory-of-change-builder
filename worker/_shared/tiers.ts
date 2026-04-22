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
const usdToMicro = (usd: number): bigint => BigInt(usd) * 1_000_000n;

// Per-user lifetime cap across all free-tier users (auth'd + anon).
// Context: p50 auth-user usage ~45K tokens (~$0.33), p90 ~1M tokens (~$7.22).
// $5 covers most users' first substantial chart work; power users hit BYOK.
export const LIFETIME_CAP_USD = 5;
export const LIFETIME_CAP_MICRO_USD = usdToMicro(LIFETIME_CAP_USD);

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
 * Anonymous actors (IP-hashed) have IDs prefixed with `anon-`. BYOK presence
 * overrides -- a BYOK header makes the request self-funded regardless of
 * whether the actor is authenticated. Callers that want to block BYOK for
 * anon users should consult `allowByok()` against the actor's base identity.
 */
export function tierFor(actorId: string, hasByokHeader: boolean): Tier {
  if (hasByokHeader) return 'byok';
  if (actorId.startsWith('anon-')) return 'anon';
  return 'free';
}

export const isCapped      = (tier: Tier) => tier !== 'byok';
export const allowByok     = (tier: Tier) => tier !== 'anon';
export const needTurnstile = (tier: Tier) => tier === 'anon';
