import { useId, useState } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { ExclamationTriangleIcon, TrashIcon } from '@heroicons/react/24/outline';
import { getFreshIdToken } from '../utils/auth';
import { clearAllByokLocalState } from '../utils/byokSpend';

// "Delete all my data" affordance — GDPR Art. 17 erasure mechanism.
//
// Visible to both authenticated and anonymous users. The same Worker
// endpoint (DELETE /api/my-data) handles both paths; auth users send
// Authorization: Bearer <id_token>, anon users rely on the cookie-pinned
// `tocb_actor_id`. The Worker decides which path to take based on whether
// the JWT verifies.
//
// Confirm-by-typing flow: the destructive button is disabled until the user
// types the literal word "DELETE" (case-sensitive). Standard pattern; deters
// accidental clicks far more reliably than a yes/no modal because the
// muscle-memory dismissal of an "Are you sure?" prompt doesn't survive a
// type-the-word gate.
//
// What gets removed (matches the server's behaviour):
//   - charts the user solely owns
//   - logging messages, snapshots, sessions, errors keyed by user_id
//   - chart_files (local rows + Anthropic Files API DELETE fan-out)
//   - chart_permissions rows
//   - BYOK encrypted blob (auth only)
//   - tocb_anon and tocb_auth_link cookies
//
// What stays (deliberate):
//   - user_api_usage row (anti-abuse cap, separate Art 6(1)(f) basis)
//   - tocb_actor_id cookie (so the cap stays attached to this browser)
//   - charts the user collaborates on (orphaned: user_id → NULL, but the
//     chart itself stays so the other collaborators don't lose their work)

const CONFIRM_PHRASE = 'DELETE';

interface DeleteSummary {
  charts_hard_deleted: number;
  charts_orphaned: number;
  files: number;
  byok: boolean;
}

interface DeleteResponse {
  ok?: boolean;
  no_data?: boolean;
  deleted?: DeleteSummary;
  // Files whose Anthropic-side DELETE has not been confirmed at the time of
  // response. The Worker queues them for an out-of-band retry; UI words this
  // honestly rather than claiming they're already gone.
  files_pending_remote_delete?: number;
  // Server-side incident id when the cascade itself errored. Returned with
  // 5xx so the user has something to quote when reporting.
  incident_id?: string | null;
  error?: string;
}

export interface DeleteMyDataPanelProps {
  className?: string;
  /** Called after a successful delete completes (and any sign-out has run). */
  onDeleted?: () => void;
}

/**
 * In-page card with the destructive flow inline (no nested modal). Drop into
 * an existing privacy/settings modal; the parent should handle close/escape.
 */
export function DeleteMyDataPanel({ className, onDeleted }: DeleteMyDataPanelProps) {
  const { isAuthenticated, getIdTokenClaims, getAccessTokenSilently, logout } = useAuth0();
  const headingId = useId();
  const inputId = useId();

  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeleteSummary | null>(null);
  const [filesPending, setFilesPending] = useState(0);
  const [noData, setNoData] = useState(false);

  const canSubmit = confirmation === CONFIRM_PHRASE && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      // Auth users MUST send a JWT. Without one the Worker takes the anon
      // branch and only the anon-cookie row gets cleared — the auth user's
      // charts/BYOK survive but the UI would falsely report "deleted
      // everything". Bail out and ask the user to re-sign-in instead.
      const headers: Record<string, string> = {};
      if (isAuthenticated) {
        const idToken = await getFreshIdToken(getAccessTokenSilently, getIdTokenClaims);
        if (!idToken) {
          throw new Error('Your session expired. Please sign in again and retry.');
        }
        headers['Authorization'] = `Bearer ${idToken}`;
      }

      const response = await fetch('/api/my-data', {
        method: 'DELETE',
        // credentials:'include' is the Workers default for same-origin in
        // browsers. We're explicit so the cookies are sent even when the
        // SPA is iframed/embedded for development.
        credentials: 'include',
        headers,
      });

      const data = (await response.json().catch(() => ({}))) as DeleteResponse;
      if (!response.ok) {
        const incident = data.incident_id ? ` (incident ${data.incident_id})` : '';
        throw new Error(`${data.error ?? `Delete failed (${response.status})`}${incident}`);
      }

      // Wipe BYOK localStorage immediately — server-side blob is gone, the
      // client counters / use-for-chat toggle are local-only and would
      // otherwise leak account state across a same-browser sign-in by
      // someone else. See AuthButton's logout flow for the same call.
      clearAllByokLocalState();

      if (data.no_data) {
        setNoData(true);
      } else {
        setResult(data.deleted ?? null);
        setFilesPending(data.files_pending_remote_delete ?? 0);
      }

      onDeleted?.();

      // For authenticated users, sign out so the next page load starts
      // fresh (the auth_link cookie was just cleared too). Defer slightly
      // so the user gets to see the success state before the redirect.
      if (isAuthenticated) {
        window.setTimeout(() => {
          logout({ logoutParams: { returnTo: window.location.origin } });
        }, 1500);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const wrapperClass = ['rounded-lg border border-red-200 bg-red-50 p-4', className ?? '']
    .filter(Boolean)
    .join(' ');

  if (result || noData) {
    return (
      <section className={wrapperClass} aria-labelledby={headingId}>
        <h3 id={headingId} className="text-base font-semibold text-red-900">
          {noData ? 'No data to delete' : 'Your data has been deleted'}
        </h3>
        {noData ? (
          <p className="mt-2 text-sm text-red-800">
            We didn&apos;t find any data attached to this browser.
          </p>
        ) : (
          <p className="mt-2 text-sm text-red-800">
            {result!.charts_hard_deleted} chart{result!.charts_hard_deleted === 1 ? '' : 's'}{' '}
            removed
            {result!.charts_orphaned > 0 ? (
              <>
                {', '}
                {result!.charts_orphaned} collaborative chart
                {result!.charts_orphaned === 1 ? '' : 's'} unlinked from your account
              </>
            ) : null}
            {result!.files > 0 ? (
              <>
                {', '}
                {result!.files} attached file{result!.files === 1 ? '' : 's'} cleared locally
                {filesPending > 0 ? ' (queued for remote deletion at Anthropic)' : ''}
              </>
            ) : null}
            .{isAuthenticated ? ' Signing you out…' : ''}
          </p>
        )}
      </section>
    );
  }

  return (
    <section className={wrapperClass} aria-labelledby={headingId}>
      <div className="flex items-start gap-2">
        <ExclamationTriangleIcon
          className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5"
          aria-hidden
        />
        <div className="flex-1">
          <h3 id={headingId} className="text-base font-semibold text-red-900">
            Delete all my data
          </h3>
          <p className="mt-1 text-sm text-red-800">
            Permanently removes the charts you own, your chat history, uploaded files, and (if
            signed in) your stored Anthropic API key. Charts you co-edit with other people are kept,
            but unlinked from your account. This cannot be undone.
          </p>
        </div>
      </div>

      <div className="mt-3 space-y-2">
        <label htmlFor={inputId} className="block text-xs font-medium text-red-900">
          Type <code className="font-mono bg-white px-1 py-0.5 rounded">{CONFIRM_PHRASE}</code> to
          enable the button
        </label>
        <input
          id={inputId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={confirmation}
          onChange={(e) => {
            setConfirmation(e.target.value);
            if (error) setError(null);
          }}
          disabled={submitting}
          className="w-full px-3 py-2 text-sm font-mono border border-red-300 rounded-md focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 disabled:bg-gray-100 bg-white"
          aria-invalid={error ? true : undefined}
        />

        {error && (
          <p role="alert" className="text-xs text-red-700">
            {error}
          </p>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1"
        >
          {submitting ? (
            <span
              className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"
              aria-hidden
            />
          ) : (
            <TrashIcon className="w-4 h-4" aria-hidden />
          )}
          {submitting ? 'Deleting…' : 'Delete all my data'}
        </button>
      </div>
    </section>
  );
}

export default DeleteMyDataPanel;
