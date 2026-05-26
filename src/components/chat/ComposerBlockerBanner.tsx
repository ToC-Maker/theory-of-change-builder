// Unified composer-area banner for all cap/cost blocker variants.
//
// Renders correct copy + CTAs per RenderedBlocker variant, matching the
// JSX that previously lived inline in ChatInterface.tsx. Wrapped in
// React.memo so it doesn't re-render on every parent state change — the
// blocker (event-driven) and usage snapshot change at a much lower
// frequency than the rest of ChatInterface state.
//
// Variants handled:
//   - cap_reached: red, "you've used the free quota"
//   - request_cut_off: red, "message cut off, your last message used the rest"
//   - global_budget: red, conditional copy by hasKey
//   - would_exceed_cap: amber, "your next send is estimated at $X but only $Y left"
//   - advisory: amber, soft warning with detail text from the blocker
//   - null: renders nothing
//
// The component reads `usage.limit_usd` and `usage.used_usd` at render
// time (no payload trust on the cap_reached variant — single source of
// truth for limit values is the live usage snapshot).
import React from 'react';
import { KeyIcon } from '@heroicons/react/24/outline';
import { DonateCta } from '../ByokPanel';
import { formatCostUsd } from '../../utils/cost';
import type { RenderedBlocker } from './composerBlocker';

// Local copy of the AddApiKeyButton from ChatInterface — duplicated rather
// than imported to keep this component self-contained (no circular
// imports back into ChatInterface). The button just dispatches a custom
// event that ChatInterface listens for to open the key-entry modal.
function AddApiKeyButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent('tocb:openApiKeyModal'))}
      className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
    >
      <KeyIcon className="w-4 h-4" aria-hidden />
      Add an Anthropic API key
    </button>
  );
}

interface ComposerBlockerBannerProps {
  blocker: RenderedBlocker;
  /** Live usage snapshot. Required when blocker is cap_reached or
   *  would_exceed_cap (those variants read limit_usd / used_usd directly
   *  rather than trusting a stale payload). */
  usage: { used_usd: number; limit_usd: number; tier: string } | null;
  /** Whether the user has a verified BYOK key. Affects global_budget copy
   *  (BYOK user vs free-tier copy) and which CTAs render. */
  hasKey: boolean;
  /** The active draft's estimate in USD; rendered in the would_exceed_cap
   *  copy as "Your next send is estimated at $X". Pass the Chat or
   *  Generate estimate based on current mode (the parent component does
   *  the mode-aware selection). */
  composerEstimateUsd: number;
}

function ComposerBlockerBannerImpl({
  blocker,
  usage,
  hasKey,
  composerEstimateUsd,
}: ComposerBlockerBannerProps) {
  if (!blocker) return null;

  switch (blocker.type) {
    case 'request_cut_off':
      // Mid-stream kill — the user's last message used the rest of their
      // quota and got cut off. Red because the message they sent is gone.
      return (
        <div className="space-y-2">
          <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">
            Message cut off — your last message used the rest of the free quota. Add an Anthropic
            API key to keep going.
          </div>
          <AddApiKeyButton />
        </div>
      );

    case 'global_budget':
      // Anthropic Console budget cap OR BYOK billing error. Two different
      // failure modes share this variant because the wire shape is the
      // same; conditional copy distinguishes them.
      return (
        <div className="space-y-2">
          <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2 space-y-1">
            {hasKey ? (
              // BYOK user: their own key returned billing_error. Pointing
              // them at "add an API key" would be wrong (they already have
              // one); the remediation is the Anthropic Console.
              <div>
                Anthropic returned a billing error for your API key. This can be transient — try
                again in a minute. If it persists, check your Anthropic Console for cap, payment, or
                organization status.
              </div>
            ) : (
              // Free/anon user: our shared key hit the cap (or Anthropic
              // billing desync). BYOK is the unblock path.
              <div>
                We hit our shared monthly spend cap, or Anthropic returned a transient billing
                error. Try again in a minute, or use your own Anthropic key to continue.
              </div>
            )}
            {blocker.upstream_message && (
              <div className="text-xs text-red-700 italic">
                Anthropic says: &ldquo;{blocker.upstream_message}&rdquo;
              </div>
            )}
          </div>
          {/* Action affordances: AddApiKeyButton only helps if the user
              doesn't already have a key. DonateCta only helps the free-
              tier case (BYOK users are self-funded; donations don't
              unblock them). */}
          {!hasKey && <AddApiKeyButton />}
          {!hasKey && <DonateCta />}
        </div>
      );

    case 'cap_reached':
      // Server-confirmed lifetime cap. Reads limit_usd from the live
      // usage snapshot rather than the blocker payload (single source
      // of truth; survives a stale event payload).
      return (
        <div className="space-y-2">
          <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">
            You&apos;ve used the free quota of {usage ? formatCostUsd(usage.limit_usd) : '$5.00'}.
            Add an Anthropic API key to keep going.
          </div>
          <AddApiKeyButton />
          <DonateCta />
        </div>
      );

    case 'would_exceed_cap':
      // Derived: user's draft estimate would push them past the cap on
      // send. Amber (not red) because they can still trim the draft.
      // Renders the remaining quota so users see what they have to work
      // with. Both unblock affordances (add key OR donate) — same shape
      // as cap_reached since the user's options are identical in both.
      return (
        <div className="space-y-2">
          <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            Your next send (includes chat history and attached files) is estimated at{' '}
            <strong>{formatCostUsd(composerEstimateUsd)}</strong>, but only{' '}
            <strong>
              {usage
                ? `${formatCostUsd(Math.max(0, usage.limit_usd - usage.used_usd))}/${formatCostUsd(usage.limit_usd)}`
                : ''}
            </strong>{' '}
            left. Add an Anthropic API key to continue.
          </div>
          <AddApiKeyButton />
          <DonateCta />
        </div>
      );

    case 'advisory':
      // Soft warning — composer stays usable (shouldBlockSend returns
      // false except for cost_error_type='unknown' defensive sentinel).
      // Single amber pill with the detail text from the blocker. The
      // legacy in-scroll banner is consolidated here in Task 7.
      return (
        <div className="text-sm bg-amber-50 border border-amber-200 text-amber-900 rounded px-3 py-2">
          {blocker.detail}
        </div>
      );

    default: {
      // Exhaustiveness: TypeScript catches at compile, runtime fallback
      // for old/new bundle skew.
      const _exhaustive: never = blocker;
      void _exhaustive;
      return null;
    }
  }
}

// React.memo absorbs reference-equality churn on parent re-renders. The
// banner shouldn't re-render unless one of its props (blocker reference,
// usage values, hasKey, composerEstimateUsd) actually changed. Default
// shallow comparison is enough since blocker objects are replaced (not
// mutated) by setComposerBlocker.
export const ComposerBlockerBanner = React.memo(ComposerBlockerBannerImpl);
