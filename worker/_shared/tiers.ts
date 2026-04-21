/**
 * Tier constants and pure helpers for free / anon / BYOK classification.
 *
 * No DB access, no I/O -- tier rules live as code constants (not a DB table)
 * because they don't need hot-reload complexity. Cap changes land via deploy.
 */

// Per-user lifetime cap across all free-tier users (auth'd + anon).
// Context: p50 auth-user usage ~45K tokens (~$0.33), p90 ~1M tokens (~$7.22).
// $5 covers most users' first substantial chart work; power users hit BYOK.
export const LIFETIME_CAP_USD = 5;
export const LIFETIME_CAP_MICRO_USD = 5_000_000n;

// Flat per-request ceiling used as the mid-stream kill threshold's upper bound.
// An individual stream is aborted if cumulative cost exceeds its pre-flight
// reservation × KILL_SWITCH_MULTIPLIER, OR this flat cap, whichever is lower.
export const PER_REQUEST_CAP_MICRO_USD = 5_000_000n;

// Global observability cap -- matches the Anthropic Console customer-set cap.
// NOT an enforcement mechanism (Anthropic's cap is the hard stop); this is
// for near-real-time dashboards instead of waiting on billing emails (~24h lag).
export const GLOBAL_MONTHLY_CAP_USD = 100;
export const GLOBAL_MONTHLY_CAP_MICRO_USD = 100_000_000n;

// Mid-stream kill switch: abort when cumulative cost > reservation × this.
// 1.2 leaves 20% headroom for reasonable output-token overruns without
// letting a runaway stream blow through the per-user cap.
export const KILL_SWITCH_MULTIPLIER = 1.2;

// Request-body size limit (32 MB). Matches Anthropic Messages API ceiling.
// Enforced via streaming byte counter on the request body (not Content-Length),
// so we stop reading as soon as we cross the threshold.
export const BODY_SIZE_LIMIT_BYTES = 33_554_432;

// Anthropic Files API upload ceiling (500 MB per file).
export const FILE_UPLOAD_LIMIT_BYTES = 524_288_000;

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
