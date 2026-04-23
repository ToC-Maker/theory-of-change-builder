import React, { useId, useState } from 'react';
import { useApiKey } from '../contexts/ApiKeyContext';
import { useAuth0 } from '@auth0/auth0-react';
import { KeyIcon, EyeIcon, EyeSlashIcon, CheckCircleIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';

export type ByokPanelMode =
  | 'generate'
  | 'cap_reached'         // pre-flight 429: prior cumulative usage already ≥ cap
  | 'request_cut_off'     // mid-stream kill: this message went over remaining budget
  | 'global_budget'       // 402: our shared monthly AI spend cap hit
  | 'voluntary';

export interface ByokPanelProps {
  mode: ByokPanelMode;
  onSubmitted?: () => void;
  anthropicKeyHelpUrl?: string;
  donateUrl?: string;
  className?: string;
}

const DEFAULT_HELP_URL = 'https://platform.claude.com/settings/keys';
const DEFAULT_DONATE_URL = '#donate';

/**
 * Inline panel for Bring-Your-Own-Key (BYOK) Anthropic API key entry.
 *
 * Rendered in three contexts:
 * - `'generate'`: replaces the Generate panel when the user triggers Generate
 *   without a verified key.
 * - `'cap_reached'`: shown beneath the last assistant message after the $5
 *   lifetime free cap is hit.
 * - `'voluntary'`: launched from the settings menu for users adding or
 *   changing a key on their own.
 *
 * The caller passes `onSubmitted` to re-trigger whatever action the user was
 * attempting (e.g. resume Generate). Anonymous visitors should never reach
 * this panel (they're routed to sign-in first); the component still renders
 * a gentle fallback for robustness.
 */
export function ByokPanel({
  mode,
  onSubmitted,
  anthropicKeyHelpUrl = DEFAULT_HELP_URL,
  donateUrl = DEFAULT_DONATE_URL,
  className,
}: ByokPanelProps) {
  const { hasKey, keyLast4, submitKey } = useApiKey();
  const { isAuthenticated, isLoading: authLoading } = useAuth0();

  const [rawKey, setRawKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSubmittedLast4, setJustSubmittedLast4] = useState<string | null>(null);

  const inputId = useId();
  const disclosureId = useId();

  const trimmed = rawKey.trim();
  const looksValid = trimmed.startsWith('sk-ant-');
  const canSubmit = looksValid && !submitting;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitKey(trimmed);
      if (!result.verified) {
        setError(
          result.error ??
            "This key wasn't accepted by Anthropic. Double-check it and try again."
        );
        return;
      }
      setJustSubmittedLast4(result.last4 ?? null);
      setRawKey('');
      setShowKey(false);
      onSubmitted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const header = renderHeader(mode);
  const wrapperClass = [
    'bg-white rounded-lg shadow-sm border border-gray-200 p-4',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  // Anonymous-user fallback: we bind the stored key to the user's auth0 sub,
  // so key entry requires a signed-in account. Explain what Generate needs
  // and why, rather than a bare "please sign in".
  if (!authLoading && !isAuthenticated) {
    return (
      <section className={wrapperClass} aria-labelledby={`${inputId}-title`}>
        <h3 id={`${inputId}-title`} className="flex items-start gap-2 text-base font-semibold text-gray-900">
          <KeyIcon className="w-5 h-5 text-gray-500 flex-shrink-0 mt-0.5" aria-hidden />
          <span>Sign in to use Generate with your Anthropic API key</span>
        </h3>
        <p className="mt-2 text-sm text-gray-700 leading-relaxed">
          Generate runs a deep analysis of your documents; a single run
          often costs more than the free tier covers. To use it, sign in
          and add your own Anthropic API key; usage is billed directly to your
          Anthropic account.
        </p>
      </section>
    );
  }

  // Confirmation state: in voluntary / cap_reached modes, show a success
  // pill instead of re-rendering an empty input. In generate mode the caller
  // typically unmounts us via onSubmitted.
  const showConfirmation =
    (mode === 'voluntary' || mode === 'cap_reached' || mode === 'request_cut_off' || mode === 'global_budget') && (justSubmittedLast4 || (hasKey && !error));
  const confirmationLast4 = justSubmittedLast4 ?? keyLast4 ?? null;

  return (
    <section className={wrapperClass} aria-labelledby={`${inputId}-title`}>
      <h3 id={`${inputId}-title`} className="flex items-start gap-2 text-base font-semibold text-gray-900">
        <KeyIcon className="w-5 h-5 text-gray-500 flex-shrink-0 mt-0.5" aria-hidden />
        <span>{header.title}</span>
      </h3>
      {header.body && (
        <p className="mt-2 text-sm text-gray-700 leading-relaxed">{header.body}</p>
      )}

      {showConfirmation ? (
        <div
          className="mt-3 flex items-center gap-2 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800"
          role="status"
        >
          <CheckCircleIcon className="w-4 h-4 flex-shrink-0" aria-hidden />
          <span>
            Key verified
            {confirmationLast4 ? <> &middot; ends in <code className="font-mono">{confirmationLast4}</code></> : null}
          </span>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-3 space-y-3" noValidate>
          <ol className="text-sm text-gray-700 space-y-1 list-decimal list-inside">
            <li>
              Open{' '}
              <a
                href={anthropicKeyHelpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 underline inline-flex items-center gap-1"
              >
                platform.claude.com/settings/keys
                <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" aria-hidden />
              </a>{' '}
              (sign in if prompted).
            </li>
            <li>
              If you haven&apos;t already, add a payment method under
              {' '}Billing &rarr; add credit or a card.
            </li>
            <li>
              Click <strong>Create Key</strong>, name it (e.g. &ldquo;Theory of
              Change&rdquo;), copy the <code className="font-mono">sk-ant-&hellip;</code>{' '}
              value, and paste it below. The key is only shown once.
            </li>
          </ol>

          <label htmlFor={inputId} className="sr-only">
            Anthropic API key
          </label>
          <div className="relative">
            <input
              id={inputId}
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-..."
              value={rawKey}
              onChange={(e) => {
                setRawKey(e.target.value);
                if (error) setError(null);
              }}
              aria-describedby={disclosureId}
              aria-invalid={error ? true : undefined}
              className="w-full pr-10 px-3 py-2 text-sm font-mono border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
              disabled={submitting}
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-500 hover:text-gray-700 focus:outline-none focus:text-gray-700"
              aria-label={showKey ? 'Hide API key' : 'Show API key'}
              tabIndex={0}
            >
              {showKey ? (
                <EyeSlashIcon className="w-4 h-4" aria-hidden />
              ) : (
                <EyeIcon className="w-4 h-4" aria-hidden />
              )}
            </button>
          </div>

          {!looksValid && trimmed.length > 0 && (
            <p className="text-xs text-amber-700">
              Anthropic keys start with <code className="font-mono">sk-ant-</code>. Double-check you
              copied the full key.
            </p>
          )}

          {error && (
            <p role="alert" className="text-xs text-red-700">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
            >
              {submitting && (
                <span
                  className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"
                  aria-hidden
                />
              )}
              {submitting ? 'Verifying…' : 'Verify and continue'}
            </button>
            {/* Donate makes sense when the user has hit the overall free
                tier ('cap_reached') or when the global pool is exhausted
                ('global_budget') — donations help keep or raise the pool.
                For 'request_cut_off' (one message went over), donate is
                a non-sequitur; hide it there. */}
            {(mode === 'cap_reached' || mode === 'global_budget') && (
              <a
                href={donateUrl}
                className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-800"
              >
                Donate instead
              </a>
            )}
          </div>

          {mode === 'generate' && (
            <p id={disclosureId} className="text-xs text-gray-600">
              A Generate run usually costs <strong>a few dollars</strong> on your
              Anthropic account, and can be more for large documents or
              heavy web searching. The live cost is shown as the response
              streams so you can stop it if it runs long.
            </p>
          )}
        </form>
      )}
    </section>
  );
}

function renderHeader(
  mode: ByokPanelMode
): { title: React.ReactNode; body: React.ReactNode | null } {
  switch (mode) {
    case 'generate':
      return {
        title: 'Add your Anthropic API key to use Generate',
        body:
          'Generate runs a deep analysis of your documents; a single run often costs more than the free tier covers. Use your own Anthropic API key to run it; usage is billed directly to your Anthropic account.',
      };
    case 'cap_reached':
      return {
        title: "You've used the free lifetime quota",
        body:
          'To keep chatting, add your own Anthropic API key; usage is billed directly to your Anthropic account. You can also donate to help us raise the cap and keep this tool sustainable.',
      };
    case 'request_cut_off':
      return {
        title: 'Message cut off — free quota exhausted',
        body:
          "Your last message used the rest of your free quota and was stopped mid-response. Add your Anthropic API key to keep going; future messages will keep working on your own account.",
      };
    case 'global_budget':
      return {
        title: "We've hit our shared monthly spend cap",
        body:
          "Everyone on the free tier is paused until next month's reset. Add your Anthropic API key to keep going, or donate to help us raise the cap.",
      };
    case 'voluntary':
      return {
        title: 'Add your Anthropic API key',
        body:
          "When a key is set, your messages are billed to your Anthropic account instead of our shared free pool.",
      };
  }
}

export default ByokPanel;
