// Composer-blocker state machine.
//
// Single discriminated union replacing the fragmented three-slot state in
// ChatInterface.tsx (`costErrorBanner`, `byokPanelMode`,
// `globalBudgetUpstreamMessage`). The render-time selector folds in the
// derived `would_exceed_cap` flag (computed from usage snapshot + draft
// estimate) so all cap/cost UI flows through one slot.
//
// All transitions live here as pure functions; the calling component just
// dispatches events and renders the result, no priority chain to maintain in
// component code. See plans/composer-banner-unification.md for the failure
// modes this closes and the decision record.

import type { CostError, CostErrorType } from '../../services/chatService';

// Inline shape of the /api/usage response, matching the literal at
// ChatInterface.tsx (state.usage). Inlined here rather than extracted to
// chatService.ts to keep this task's diff scope to "new files only" — a
// promotion to a shared type is a separate cleanup PR.
type UsageSnapshot = {
  used_usd: number;
  limit_usd: number;
  tier: string;
};

/**
 * Discriminated union over the event-driven blocker variants. Render-time
 * derived blockers (would_exceed_cap) are NOT included here; they live in
 * `RenderedBlocker` and are composed by `selectBlocker`.
 *
 * - `cap_reached`: server rejected AND user genuinely at-or-over cap
 *   (used_usd >= limit_usd at the moment of rejection). Sticky blocking
 *   red banner; only clears via BYOK / chart-change / clearChat. Editing
 *   the draft can't help — any send would still fail.
 * - `last_send_exceeded`: server rejected because THIS specific send was
 *   projected over remaining quota, but user is under cap
 *   (used_usd < limit_usd). Non-blocking amber banner; auto-clears on
 *   input/files edit (a smaller draft may succeed). Differs from
 *   `would_exceed_cap` (derived, present-tense, current draft) in being
 *   event-driven and past-tense about a specific rejection.
 * - `request_cut_off`: mid-stream kill switch fired (request_cost_ceiling).
 * - `global_budget`: Anthropic Console budget cap; optional upstream message
 *   so the user sees Anthropic's actual reason.
 * - `advisory`: soft warning that doesn't block sends. Covers
 *   body_too_large, chart_deleted, file_unavailable, invalid_token,
 *   service-class errors, AND the lifetime_cap $0/$0 fallback +
 *   unknown-variant defensive arm.
 */
export type ComposerBlocker =
  | { type: 'cap_reached' }
  | { type: 'last_send_exceeded' }
  | { type: 'request_cut_off' }
  | { type: 'global_budget'; upstream_message?: string }
  | {
      type: 'advisory';
      cost_error_type: CostErrorType | 'unknown';
      detail: string;
    };

/**
 * Render-time blocker: event blockers plus the derived `would_exceed_cap`
 * variant computed from the current draft's estimate. `selectBlocker`
 * returns this; consumers (banner, send gate) match against it.
 */
export type RenderedBlocker = ComposerBlocker | { type: 'would_exceed_cap' } | null;

/**
 * Cap-class predicate. Used in three places: `selectBlocker` tier-filter,
 * `clearOnSendStart` stickiness rule, and the send-gate label. Single
 * source of truth.
 *
 * Note: `global_budget` is NOT cap-class — it fires for both free-tier-cap
 * AND BYOK-billing-error conditions; tier flip to byok should preserve it
 * (the user's own key still hit Anthropic's billing error).
 */
export function isCapClassBlocker(blocker: ComposerBlocker | null): boolean {
  if (!blocker) return false;
  return blocker.type === 'cap_reached' || blocker.type === 'request_cut_off';
}

/**
 * Service-class CostErrorType set. Co-located here so the DU and the
 * observability gate in `chatService.ts` stay in sync — adding a new
 * service-class variant in one place doesn't need a coordinated edit in
 * the other. `chatService.ts` imports this to decide which CostErrors
 * to log via `loggingService.reportError` (cap/quota events are expected
 * operational states, not diagnostic noise).
 */
export const SERVICE_ERROR_TYPES: ReadonlySet<CostErrorType> = new Set([
  'database_unavailable',
  'estimation_unavailable',
  'authentication_service_unavailable',
]);

/**
 * Map a structured CostError to the next ComposerBlocker.
 *
 * Returns:
 *   - `ComposerBlocker` variant → set the slot
 *   - `undefined` → no-op (preserve existing blocker)
 *
 * Stickiness for cap-class variants is enforced by `clearOnSendStart` (the
 * send-start updater); this function doesn't enforce stickiness on its own.
 *
 * Stateless w.r.t. the prior blocker (no `current` param needed) — the
 * caller pattern `if (next !== undefined) setComposerBlocker(next)` is the
 * mechanism that preserves prior state for the no-op cases.
 */
export function costErrorToBlocker(error: CostError): ComposerBlocker | undefined {
  switch (error.type) {
    case 'turnstile_required':
    case 'turnstile_failed':
    case 'idempotent_replay':
      // No-op: turnstile arms are handled separately by the caller (they
      // touch Turnstile state, not the blocker slot). idempotent_replay
      // is a silent dedup signal — preserve the existing blocker so a
      // double-click on a capped state doesn't clobber the sticky banner.
      return undefined;

    case 'lifetime_cap_reached': {
      // Two distinct cases route to two distinct variants:
      // (a) used >= limit: user genuinely at cap. Any send fails. Sticky
      //     blocking red banner; only clears on BYOK / chart-change /
      //     clearChat. → cap_reached
      // (b) used <  limit: user under cap, this specific send projected
      //     over remaining quota. Editing down may let a smaller send
      //     through. Non-blocking amber banner; auto-clears on input/
      //     files edit (handled by a useEffect in ChatInterface).
      //     → last_send_exceeded
      const data = error.data as { used_usd?: number; limit_usd?: number } | null | undefined;
      const used = typeof data?.used_usd === 'number' ? data.used_usd : 0;
      const limit = typeof data?.limit_usd === 'number' ? data.limit_usd : 0;
      if (used === 0 && limit === 0) {
        // Legacy/buggy worker emit; fall through to advisory rather than
        // render misleading "$0.00 quota" copy.
        return {
          type: 'advisory',
          cost_error_type: 'lifetime_cap_reached',
          detail: 'Free-tier limit reached. Add an Anthropic API key to continue.',
        };
      }
      if (used >= limit) return { type: 'cap_reached' };
      return { type: 'last_send_exceeded' };
    }

    case 'request_cost_ceiling_exceeded':
      return { type: 'request_cut_off' };

    case 'global_budget_exhausted': {
      const data = error.data as { upstream_message?: unknown } | null | undefined;
      const upstream_message =
        typeof data?.upstream_message === 'string' ? data.upstream_message : undefined;
      return { type: 'global_budget', upstream_message };
    }

    case 'invalid_token':
      // Preserves today's non-blocking behavior. invalid_token fires for
      // both true-expired tokens AND transient JWKS fetch failures; treating
      // it as a hard-blocking variant regresses recovery from the latter
      // (1-second JWKS blip clears on the next request via Auth0 silent
      // refresh — hard-blocking would require manual sign-out).
      return {
        type: 'advisory',
        cost_error_type: 'invalid_token',
        detail: 'Your session may have expired. Try again, or sign out and back in if it persists.',
      };

    case 'body_too_large':
      return {
        type: 'advisory',
        cost_error_type: 'body_too_large',
        detail: 'Message too large. Reduce attachments or trim the prompt.',
      };

    case 'chart_deleted':
      return {
        type: 'advisory',
        cost_error_type: 'chart_deleted',
        detail: 'This chart was deleted in another tab. Reload to continue.',
      };

    case 'file_unavailable':
      return {
        type: 'advisory',
        cost_error_type: 'file_unavailable',
        detail: 'A file referenced by this chat is no longer available. Remove it and retry.',
      };

    case 'database_unavailable':
    case 'estimation_unavailable':
    case 'authentication_service_unavailable':
      return {
        type: 'advisory',
        cost_error_type: error.type,
        detail: 'Service temporarily unavailable. Please try again shortly.',
      };

    default: {
      // TypeScript catches at compile; runtime fallback is defensive for
      // old/new bundle skew (worker ships a new CostErrorType before the
      // client picks it up). cost_error_type='unknown' sentinel makes
      // shouldBlockSend over-block defensively. console.error gives
      // DevTools-pasted bug reports a grep handle.
      const _exhaustive: never = error.type;
      void _exhaustive;
      console.error('[ComposerBlocker] unknown CostErrorType:', error.type);
      return {
        type: 'advisory',
        cost_error_type: 'unknown',
        detail: `Unexpected error: ${String(error.type)}`,
      };
    }
  }
}

/**
 * Compose the render-time blocker from event-driven state + derived inputs.
 * Pure function — call inline at render (cheap). Returns:
 *   - Event blocker if any (filtered for cap-class on byok tier flip)
 *   - Derived `would_exceed_cap` if estimate would push usage over limit
 *   - `null` otherwise
 */
export function selectBlocker(params: {
  eventBlocker: ComposerBlocker | null;
  usage: UsageSnapshot | null;
  composerEstimateUsd: number;
}): RenderedBlocker {
  const { eventBlocker, usage, composerEstimateUsd } = params;

  // BYOK tier-flip clear: cap-related event blockers become irrelevant
  // when the user has BYOK active (free-tier cap doesn't apply). Includes
  // last_send_exceeded — the past rejection was about the free-tier cap;
  // doesn't apply to BYOK users. NOT global_budget (BYOK billing errors
  // also produce global_budget; BYOK doesn't fix Anthropic-side billing).
  // NOT advisory (chart_deleted etc. are independent of tier).
  //
  // Membership intentionally inlined here rather than extracted as a
  // predicate because it's slightly different from isCapClassBlocker
  // (which is "preserve across UI navigation/send-start" and excludes
  // last_send_exceeded since that variant clears on edit instead).
  const filteredEvent =
    eventBlocker &&
    usage?.tier === 'byok' &&
    (eventBlocker.type === 'cap_reached' ||
      eventBlocker.type === 'last_send_exceeded' ||
      eventBlocker.type === 'request_cut_off')
      ? null
      : eventBlocker;

  if (filteredEvent) return filteredEvent;

  // Derived would_exceed_cap. Only when no event blocker, on a capped tier,
  // and the in-flight draft estimate would push cumulative usage past the
  // cap. Strict `>` so an estimate that exactly hits the limit is allowed
  // through (the server's reservation uses the same boundary).
  if (
    usage != null &&
    usage.tier !== 'byok' &&
    composerEstimateUsd > 0 &&
    usage.used_usd + composerEstimateUsd > usage.limit_usd
  ) {
    return { type: 'would_exceed_cap' };
  }

  return null;
}

/**
 * Send-start clear semantics. Preserve sticky cap-class blockers across
 * send attempts (the cap gate blocks the send anyway, so the banner must
 * stay visible); clear advisory blockers so they don't linger after the
 * next successful send.
 *
 * Extracted as a pure function (vs an inline updater closure at the call
 * site) so the stickiness rule is TDD-testable and there's a single source
 * of truth for "what survives a send-start." Suitable for passing directly
 * to setState as `setComposerBlocker(clearOnSendStart)`.
 */
export function clearOnSendStart(prev: ComposerBlocker | null): ComposerBlocker | null {
  if (!prev) return null;
  return isCapClassBlocker(prev) ? prev : null;
}

/**
 * Send-gate predicate. `true` = composer's send button should be disabled
 * and any direct send attempts should early-return. Single source of truth
 * for both Chat (handleSendMessage) and Generate (startGeneration) cap
 * gates.
 *
 * Blocks: cap_reached, request_cut_off, global_budget, would_exceed_cap,
 * AND advisory with cost_error_type='unknown' (FM-Q4 defensive over-block
 * for client/server bundle skew).
 *
 * Does NOT block: regular advisory (body_too_large, invalid_token, etc.),
 * last_send_exceeded (user can retry with a smaller draft — would_exceed_cap
 * derived state gates the actual attempt if the new draft is still too big),
 * or null.
 */
export function shouldBlockSend(rendered: RenderedBlocker): boolean {
  if (!rendered) return false;
  switch (rendered.type) {
    case 'cap_reached':
    case 'request_cut_off':
    case 'global_budget':
    case 'would_exceed_cap':
      return true;
    case 'last_send_exceeded':
      // Past-tense informational. User is under cap; editing down may let
      // a smaller send through. would_exceed_cap derived gates if their
      // current draft also exceeds.
      return false;
    case 'advisory':
      return rendered.cost_error_type === 'unknown';
    default: {
      const _exhaustive: never = rendered;
      void _exhaustive;
      return true; // Safer to over-block on unknown variant
    }
  }
}
