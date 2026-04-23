import React, { useId, useState } from 'react';
import { useApiKey } from '../contexts/ApiKeyContext';
import { useAuth0 } from '@auth0/auth0-react';
import { KeyIcon, EyeIcon, EyeSlashIcon, CheckCircleIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';

export interface ByokPanelProps {
  onSubmitted?: () => void;
  anthropicKeyHelpUrl?: string;
  className?: string;
}

const DEFAULT_HELP_URL = 'https://platform.claude.com/settings/keys';

/**
 * Single "Add your Anthropic API key" card. Three render states:
 *  - anon: title + Sign in button (keys are bound to an auth0 sub).
 *  - auth'd, no key: step-by-step instructions + key input + Verify.
 *  - auth'd, key set: green verified pill.
 *
 * The panel is intentionally context-free. Callers explain WHY a key is
 * needed (Chat cap banner, Generate cost warning, settings menu) via their
 * own inline copy; this component is just the key-entry affordance.
 */
export function ByokPanel({
  onSubmitted,
  anthropicKeyHelpUrl = DEFAULT_HELP_URL,
  className,
}: ByokPanelProps) {
  const { hasKey, keyLast4, submitKey } = useApiKey();
  const { isAuthenticated, isLoading: authLoading, loginWithRedirect } = useAuth0();

  const [rawKey, setRawKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSubmittedLast4, setJustSubmittedLast4] = useState<string | null>(null);
  // `editing` overrides the verified-pill view so the user can replace an
  // existing key. Confirmation flips it back on successful verification.
  const [editing, setEditing] = useState(false);

  const inputId = useId();

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
      setEditing(false);
      onSubmitted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const wrapperClass = [
    'bg-white rounded-lg shadow-sm border border-gray-200 p-4',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  if (!authLoading && !isAuthenticated) {
    return (
      <section className={wrapperClass} aria-labelledby={`${inputId}-title`}>
        <h3 id={`${inputId}-title`} className="flex items-start gap-2 text-base font-semibold text-gray-900">
          <KeyIcon className="w-5 h-5 text-gray-500 flex-shrink-0 mt-0.5" aria-hidden />
          <span>Sign in to add your Anthropic API key</span>
        </h3>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => { void loginWithRedirect(); }}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
          >
            Sign in
          </button>
        </div>
      </section>
    );
  }

  const showConfirmation = !editing && (justSubmittedLast4 !== null || (hasKey && !error));
  const confirmationLast4 = justSubmittedLast4 ?? keyLast4 ?? null;

  return (
    <section className={wrapperClass} aria-labelledby={`${inputId}-title`}>
      <h3 id={`${inputId}-title`} className="flex items-start gap-2 text-base font-semibold text-gray-900">
        <KeyIcon className="w-5 h-5 text-gray-500 flex-shrink-0 mt-0.5" aria-hidden />
        <span>Add your Anthropic API key</span>
      </h3>

      {showConfirmation ? (
        <div className="mt-3 space-y-2">
          <div
            className="flex items-center gap-2 rounded-md bg-green-50 border border-green-200 px-3 py-2 text-sm text-green-800"
            role="status"
          >
            <CheckCircleIcon className="w-4 h-4 flex-shrink-0" aria-hidden />
            <span>
              Key verified
              {confirmationLast4 ? <> &middot; ends in <code className="font-mono">{confirmationLast4}</code></> : null}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              setError(null);
              setJustSubmittedLast4(null);
            }}
            className="text-sm text-blue-600 hover:text-blue-800 underline"
          >
            Change key
          </button>
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
            {/* Cancel is only meaningful when we're editing an existing key;
                without one there's no prior state to fall back to. */}
            {editing && hasKey && (
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setRawKey('');
                  setShowKey(false);
                  setError(null);
                }}
                className="text-sm text-gray-600 hover:text-gray-800"
                disabled={submitting}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}

/**
 * Small inline CTA linking to the donation page. Kept separate from
 * ByokPanel so callers can render it only when donations are relevant —
 * cap-hit paths (user lifetime cap, global monthly cap) where raising the
 * pool is a viable alternative to BYOK. NOT for mid-stream kills
 * (request_cut_off) where donation wouldn't unblock the user's specific
 * request, or voluntary key-entry where no cap has been hit.
 */
export function DonateCta({ donateUrl = '#donate' }: { donateUrl?: string }) {
  return (
    <a
      href={donateUrl}
      className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-800 underline"
    >
      Donate to help raise the cap
    </a>
  );
}

export default ByokPanel;
