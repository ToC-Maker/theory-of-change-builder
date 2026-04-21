import React, { useId, useState } from 'react';
import { useApiKey } from '../contexts/ApiKeyContext';
import { useAuth0 } from '@auth0/auth0-react';
import { KeyIcon, EyeIcon, EyeSlashIcon, CheckCircleIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';

export type ByokPanelMode = 'generate' | 'cap_reached' | 'voluntary';

export interface ByokPanelCostEstimate {
  low_usd: number;
  remaining_usd?: number;
}

export interface ByokPanelProps {
  mode: ByokPanelMode;
  onSubmitted?: () => void;
  costEstimate?: ByokPanelCostEstimate;
  anthropicKeyHelpUrl?: string;
  donateUrl?: string;
  className?: string;
}

const DEFAULT_HELP_URL = 'https://console.anthropic.com/settings/keys';
const DEFAULT_DONATE_URL = '#donate';

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

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
  costEstimate,
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

  // Anonymous-user fallback: BYOK requires a user account so the encrypted
  // key can be bound to their auth0 sub. Route them to sign in instead of
  // showing the input field.
  if (!authLoading && !isAuthenticated) {
    return (
      <section className={wrapperClass} aria-labelledby={`${inputId}-title`}>
        <h3 id={`${inputId}-title`} className="flex items-center gap-2 text-base font-semibold text-gray-900">
          <KeyIcon className="w-5 h-5 text-gray-500" aria-hidden />
          Sign in first to add a BYOK key
        </h3>
        <p className="mt-2 text-sm text-gray-600">
          Encrypted on our servers, scoped to your account. Please sign in, then come back to add a key.
        </p>
      </section>
    );
  }

  // Confirmation state: in voluntary / cap_reached modes, show a success
  // pill instead of re-rendering an empty input. In generate mode the caller
  // typically unmounts us via onSubmitted.
  const showConfirmation =
    (mode === 'voluntary' || mode === 'cap_reached') && (justSubmittedLast4 || (hasKey && !error));
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
            <a
              href={anthropicKeyHelpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-800"
            >
              Get a key
              <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" aria-hidden />
            </a>
            {mode === 'cap_reached' && (
              <a
                href={donateUrl}
                className="inline-flex items-center gap-1 text-sm text-gray-600 hover:text-gray-800"
              >
                Donate instead
              </a>
            )}
          </div>

          {mode === 'generate' && costEstimate && (
            <p className="text-xs text-gray-600">
              Est. {formatUsd(costEstimate.low_usd)} (input only; final cost depends on model
              output).
            </p>
          )}

          <p id={disclosureId} className="text-xs text-gray-500">
            Encrypted on our servers, scoped to your account. You can delete it anytime from the
            settings menu.
          </p>
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
        title: 'Bring your own Anthropic key',
        body: 'Generate uses deep analysis. Please supply your own key to keep this free for others.',
      };
    case 'cap_reached':
      return {
        title: "You've used the free daily quota",
        body: 'Keep going with your own Anthropic key, or donate to top up the pool for everyone.',
      };
    case 'voluntary':
      return {
        title: 'Add your Anthropic API key',
        body: null,
      };
  }
}

export default ByokPanel;
