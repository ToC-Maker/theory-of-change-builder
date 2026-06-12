// Unified composer-area banner for all cap/cost blocker variants.
//
// Renders the right copy + CTAs per RenderedBlocker variant. Wrapped in
// React.memo so it doesn't re-render on every parent state change — the
// blocker (event-driven) and usage snapshot change at a much lower
// frequency than the rest of ChatInterface state.
//
// The component reads `usage.limit_usd` and `usage.used_usd` at render
// time — single source of truth for limit values is the live usage
// snapshot rather than the (potentially stale) event payload.
//
// Quota-variant copy principles (fb5 issue 73, round-5 reviewer feedback —
// the at-cap state read as "estimation is broken"):
//   - name the identity whose allowance ran out ("the free anonymous
//     allowance" vs "your account's free allowance"), keyed off the
//     server-reported `usage.tier` (the server knows whose quota row
//     answered), falling back to isAuthenticated when usage is null;
//   - name what's blocked ("sending messages is paused", not the app);
//   - name the truthful action. Anon users must sign in BEFORE a key can
//     be added (BYOK binds to an Auth0 sub), and signing in does NOT grant
//     a fresh allowance (anon spend folds into the account row via
//     mergeAnonUsageIntoAuth), so the anon action is "sign in and add your
//     own key", never "sign in for more quota".
// Copy strings are single template expressions so tests can pin them
// verbatim via textContent equality.
import React from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { KeyIcon } from '@heroicons/react/24/outline';
import { DonateCta } from '../ByokPanel';
import { formatCostUsd } from '../../utils/cost';
import type { RenderedBlocker } from './composerBlocker';

// Local copy of the AddApiKeyButton from ChatInterface — duplicated rather
// than imported to keep this component self-contained (no circular
// imports back into ChatInterface). The button just dispatches a custom
// event that ChatInterface listens for to open the key-entry modal.
// (For anon users that modal asks them to sign in first; the banner copy
// sets that expectation so the two-step flow isn't a surprise.)
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

// Re-login affordance for the session_expired_quota deferral. Same
// returnTo contract as SessionExpiredBanner / ByokPanel's sign-in: land
// back on the chart being edited, not at `/` (Auth0RedirectHandler in
// App.tsx consumes auth0_returnTo).
function SignInAgainButton() {
  const { loginWithRedirect } = useAuth0();
  return (
    <button
      type="button"
      onClick={() => {
        const returnTo = window.location.pathname + window.location.search;
        localStorage.setItem('auth0_returnTo', returnTo);
        void loginWithRedirect({ appState: { returnTo } });
      }}
      className="inline-flex items-center gap-2 px-3 py-1.5 bg-amber-600 text-white text-sm font-medium rounded-md hover:bg-amber-700 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:ring-offset-1"
    >
      Sign in again
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
   *  copy as "This message is estimated at $X". Pass the Chat or
   *  Generate estimate based on current mode (the parent component does
   *  the mode-aware selection). */
  composerEstimateUsd: number;
  /** Auth0 client-side auth state. Quota-variant copy uses it to (a) fall
   *  back on identity naming when `usage` is null and (b) pick the action
   *  sentence — signed-out users must sign in before a key can be added. */
  isAuthenticated: boolean;
}

function ComposerBlockerBannerImpl({
  blocker,
  usage,
  hasKey,
  composerEstimateUsd,
  isAuthenticated,
}: ComposerBlockerBannerProps) {
  if (!blocker) return null;

  // Identity naming for quota copy. The server's tier is authoritative for
  // WHOSE allowance answered the usage probe ('anon' = anon actor row,
  // 'free' = account row — including the signed-out-with-auth-link case
  // where the cap follows the account per Policy B). With no snapshot
  // (usage fetch failed; event-driven blocker), fall back to the client's
  // auth state.
  const anonAllowance = usage ? usage.tier === 'anon' : !isAuthenticated;
  const allowanceNoun = anonAllowance
    ? 'the free anonymous allowance'
    : "your account's free allowance";
  // Action sentence keys off isAuthenticated (NOT tier): adding a key
  // requires a signed-in session whatever row the allowance lives in.
  const addKeyAction = isAuthenticated
    ? 'Add your own Anthropic API key to keep going.'
    : 'Sign in and add your own Anthropic API key to keep going.';
  const shortenAction = isAuthenticated
    ? 'Shorten it, or add your own Anthropic API key to keep going.'
    : 'Shorten it, or sign in and add your own Anthropic API key to keep going.';

  switch (blocker.type) {
    case 'request_cut_off':
      // Mid-stream kill — the user's last message used the rest of their
      // quota and got cut off. Red because the response they got is
      // truncated and no further send can succeed.
      return (
        <div className="space-y-2">
          <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">
            {`The response was cut short because it used the last of ${allowanceNoun}, so sending messages is paused. ${addKeyAction}`}
          </div>
          <AddApiKeyButton />
        </div>
      );

    case 'global_budget':
      // Anthropic Console budget cap OR BYOK billing error. Two different
      // failure modes share this variant because the wire shape is the
      // same; conditional copy distinguishes them. Identity-independent
      // (the shared cap is exhausted for everyone), so no allowance noun.
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

    case 'cap_reached': {
      // Server-confirmed preflight rejection AND user genuinely at-or-over
      // the lifetime cap (used >= limit). Sticky red blocking banner —
      // editing the draft can't help because any send would still fail.
      // Only clears on BYOK / chart-change / clearChat.
      //
      // Copy intentionally shows only the displayed limit, not the actual
      // used figure: thanks to the kill-switch + preflight buffer, used
      // can sit slightly above limit (e.g. $5.10 of $5.00), and rendering
      // both would read as a literal contradiction. With no usage
      // snapshot the figure is omitted rather than hardcoded.
      const limitText = usage ? ` (${formatCostUsd(usage.limit_usd)})` : '';
      return (
        <div className="space-y-2">
          <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">
            {`You've used all of ${allowanceNoun}${limitText}, so sending messages is paused. ${addKeyAction}`}
          </div>
          <AddApiKeyButton />
          <DonateCta />
        </div>
      );
    }

    case 'last_send_exceeded': {
      // Server-confirmed preflight rejection BUT user is under the cap
      // (used < limit). The rejection was about THIS send's projected
      // cost being too large for the remaining quota — editing down
      // to a smaller draft may let it through. Non-blocking amber
      // banner; auto-clears on input/files edit (via useEffect in
      // ChatInterface that nulls the blocker when this variant is set).
      //
      // Intentionally no DonateCta here (cap_reached has both):
      // donating doesn't unblock the immediate "this draft was too big
      // for remaining quota" problem since the user is under cap.
      // Editing or BYOK are the actionable recovery paths.
      const remainingText = usage
        ? `the ${formatCostUsd(Math.max(0, usage.limit_usd - usage.used_usd))} left`
        : "what's left";
      return (
        <div className="space-y-2">
          <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            {`That message would have cost more than ${remainingText} of ${allowanceNoun}, so it wasn't sent. ${shortenAction}`}
          </div>
          <AddApiKeyButton />
        </div>
      );
    }

    case 'would_exceed_cap': {
      // Derived: user's draft estimate would push them past the cap on
      // send. Amber (not red) because they can still trim the draft.
      // Renders the remaining quota so users see what they have to work
      // with. Both unblock affordances (add key OR donate) — same shape
      // as cap_reached since the user's options are identical in both.
      // selectBlocker only derives this variant from a non-null usage
      // snapshot; the fallback phrase is defensive for prop drift.
      const remainingText = usage
        ? `only ${formatCostUsd(Math.max(0, usage.limit_usd - usage.used_usd))}`
        : "only what's left";
      return (
        <div className="space-y-2">
          <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            {`This message is estimated at ${formatCostUsd(composerEstimateUsd)} (chat history and files included), but ${remainingText} of ${allowanceNoun} is left. ${shortenAction}`}
          </div>
          <AddApiKeyButton />
          <DonateCta />
        </div>
      );
    }

    case 'session_expired_quota':
      // Degraded-session deferral (selectBlocker precedence rule): a
      // quota-class blocker fired while the SessionExpiredBanner state is
      // active, meaning the allowance being enforced belongs to the anon
      // actor the dead session demoted us to. Quota remedies would be
      // wrong here — adding a key needs a live session, and the account's
      // own allowance may be untouched — so the only CTA is the same
      // re-login the top banner offers. Amber, matching that banner.
      return (
        <div className="space-y-2">
          <div className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            {`Your session has expired, so sending is paused (you're temporarily on the free anonymous allowance). Sign in again to use your account.`}
          </div>
          <SignInAgainButton />
        </div>
      );

    case 'advisory':
      // Soft warning — composer stays usable (shouldBlockSend returns
      // false except for cost_error_type='unknown' defensive sentinel).
      // Single amber pill with the detail text from the blocker.
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
// usage values, hasKey, composerEstimateUsd, isAuthenticated) actually
// changed. Default shallow comparison is enough since blocker objects are
// replaced (not mutated) by setComposerBlocker.
export const ComposerBlockerBanner = React.memo(ComposerBlockerBannerImpl);
