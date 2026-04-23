import { useAuth0 } from '@auth0/auth0-react';
import { useState, useRef, useEffect, useId, type ReactNode } from 'react';
import {
  UserCircleIcon,
  ShieldCheckIcon,
  XMarkIcon,
  KeyIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { loggingService } from '../services/loggingService';
import { ByokPanel } from './ByokPanel';
import { useApiKey } from '../contexts/useApiKey';
import { useKeyByokSpendUsd, clearAllByokLocalState } from '../utils/byokSpend';
import { formatCostUsd } from '../utils/cost';

// Shared accessible modal shell: role=dialog, Escape to close, focus the first
// focusable element on open, restore focus on close, trap focus inside on Tab.
// Used by both PrivacyModal and ApiKeyModal so accessibility behaviour stays
// in one place.
function AccessibleModal({
  isOpen,
  onClose,
  labelledBy,
  children,
  cardClassName,
}: {
  isOpen: boolean;
  onClose: () => void;
  labelledBy: string;
  children: ReactNode;
  cardClassName?: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocused.current =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

    // Focus the first focusable element inside the modal on open so keyboard
    // users land inside the dialog (defaults to the card itself if no
    // focusable children). Deferred a tick so late-mounted inputs are found.
    const focusFrame = window.requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card) return;
      const focusable = card.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        card.focus();
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'Tab') {
        const card = cardRef.current;
        if (!card) return;
        const focusable = Array.from(
          card.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        ).filter((el) => !el.hasAttribute('aria-hidden'));
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !card.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus to the element that had it before the modal opened so
      // screen-reader / keyboard flow returns to where the user triggered from.
      const prev = previouslyFocused.current;
      if (prev && typeof prev.focus === 'function') {
        try {
          prev.focus();
        } catch {
          /* element may be detached */
        }
      }
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black bg-opacity-50" onClick={onClose} />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cardClassName ?? 'relative bg-white rounded-lg shadow-xl max-w-sm w-full p-5'}
      >
        {children}
      </div>
    </div>
  );
}

// Privacy Settings Modal
function PrivacyModal({
  isOpen,
  onClose,
  onLoggingEnabled,
}: {
  isOpen: boolean;
  onClose: () => void;
  onLoggingEnabled?: () => void;
}) {
  // Read current state fresh each time modal opens
  const [loggingEnabled, setLoggingEnabled] = useState(false);
  const [hasAcceptedPrivacy, setHasAcceptedPrivacy] = useState(false);
  const headingId = useId();

  // Sync state when modal opens
  useEffect(() => {
    if (isOpen) {
      setHasAcceptedPrivacy(localStorage.getItem('privacyPolicyAccepted') === 'true');
      // Check actual opt-out value, not isOptedOut() which also checks privacy acceptance
      const isOptedOut = localStorage.getItem('usageLoggingOptOut') === 'true';
      setLoggingEnabled(!isOptedOut);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleToggle = () => {
    const newValue = !loggingEnabled;
    setLoggingEnabled(newValue);
    loggingService.setOptOut(!newValue);
    if (newValue) {
      onLoggingEnabled?.();
    }
  };

  return (
    <AccessibleModal isOpen={isOpen} onClose={onClose} labelledBy={headingId}>
      {/* Close button */}
      <button
        onClick={onClose}
        className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 transition-colors"
        aria-label="Close"
      >
        <XMarkIcon className="w-5 h-5" />
      </button>

      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-blue-100 rounded-full">
          <ShieldCheckIcon className="w-5 h-5 text-blue-600" />
        </div>
        <h3 id={headingId} className="text-lg font-semibold text-gray-900">
          Data & Privacy
        </h3>
      </div>

      {/* Content */}
      {hasAcceptedPrivacy ? (
        <div className="space-y-4">
          <p className="text-sm text-gray-600">
            We collect chat messages, graph edits, and basic session data to improve AI features.
          </p>

          <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
            <span className="text-sm font-medium text-gray-700">Share usage data</span>
            <button
              onClick={handleToggle}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                loggingEnabled ? 'bg-blue-600' : 'bg-gray-300'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  loggingEnabled ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-gray-600">
          Please accept the privacy policy first to manage your data preferences.
        </p>
      )}

      {/* Footer */}
      <div className="mt-4 pt-3 border-t border-gray-100">
        <a
          href="https://docs.google.com/document/d/1rjFIogfs_xGAUmO68Ci1UJOTtpJ2jWvwllJRl7k_sN4/edit?usp=sharing"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-600 hover:text-blue-700"
        >
          View Privacy Policy →
        </a>
      </div>
    </AccessibleModal>
  );
}

// API key management modal. Uses AccessibleModal for role=dialog + Escape
// handling + focus trap + focus restore. Interior is ByokPanel which
// self-renders the add/change/confirm state based on ApiKeyContext.
function ApiKeyModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { hasKey, keyLast4, clearKey } = useApiKey();
  const keyLifetimeSpendUsd = useKeyByokSpendUsd(keyLast4);
  const [clearing, setClearing] = useState(false);
  const headingId = useId();

  const handleClear = async () => {
    setClearing(true);
    try {
      await clearKey();
    } finally {
      setClearing(false);
    }
  };

  return (
    <AccessibleModal
      isOpen={isOpen}
      onClose={onClose}
      labelledBy={headingId}
      cardClassName="relative bg-white rounded-lg shadow-xl max-w-md w-full p-5"
    >
      <button
        onClick={onClose}
        className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 transition-colors"
        aria-label="Close"
      >
        <XMarkIcon className="w-5 h-5" />
      </button>

      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-blue-100 rounded-full">
          <KeyIcon className="w-5 h-5 text-blue-600" />
        </div>
        <h3 id={headingId} className="text-lg font-semibold text-gray-900">
          Anthropic API key
        </h3>
      </div>

      <p className="text-sm text-gray-600 mb-4">
        When a key is set, your messages are billed to your Anthropic account instead of our shared
        free pool.
      </p>

      <ByokPanel />

      {hasKey && (
        <div className="mt-4 pt-3 border-t border-gray-100 space-y-3">
          {/* Lifetime total for the currently-stored key. Counted
              client-side in localStorage as a rough UX signal; Anthropic's
              dashboard is the source of truth for billing. Resets when
              the key is removed. */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">Spent on this key (via this app)</span>
            <span className="font-medium text-gray-900">{formatCostUsd(keyLifetimeSpendUsd)}</span>
          </div>
          <button
            onClick={handleClear}
            disabled={clearing}
            className="inline-flex items-center gap-1.5 text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
          >
            <TrashIcon className="w-4 h-4" />
            {clearing ? 'Removing…' : 'Remove key'}
          </button>
        </div>
      )}
    </AccessibleModal>
  );
}

const AuthButton = ({ onLoggingEnabled }: { onLoggingEnabled?: () => void }) => {
  const { user, isAuthenticated, isLoading, loginWithRedirect, logout } = useAuth0();
  const { clearKey } = useApiKey();
  const [showDropdown, setShowDropdown] = useState(false);
  const [showPrivacyModal, setShowPrivacyModal] = useState(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDropdown]);

  // Listen for a window-level request to open the API-key modal so distant
  // components (e.g. ChatInterface's cap banners) can trigger it without
  // threading state or a context through the tree. Paired with
  // dispatchEvent(new CustomEvent('tocb:openApiKeyModal')) on the caller.
  useEffect(() => {
    const handler = () => setShowApiKeyModal(true);
    window.addEventListener('tocb:openApiKeyModal', handler);
    return () => window.removeEventListener('tocb:openApiKeyModal', handler);
  }, []);

  if (isLoading) {
    return <div className="w-9 h-9 rounded-full bg-gray-200 animate-pulse" />;
  }

  if (isAuthenticated && user) {
    return (
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className="w-9 h-9 rounded-full overflow-hidden hover:ring-2 hover:ring-gray-300 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500"
          title={user.name || 'Account'}
        >
          {user.picture ? (
            <img
              src={user.picture}
              alt={user.name || 'User'}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-blue-600 flex items-center justify-center text-white font-medium">
              {user.name?.charAt(0).toUpperCase() || 'U'}
            </div>
          )}
        </button>

        {showDropdown && (
          <div className="absolute top-full right-0 mt-2 w-72 bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden z-50">
            {/* User info header */}
            <div className="p-4 bg-gray-50 border-b border-gray-200">
              <div className="flex items-center gap-3">
                {user.picture ? (
                  <img
                    src={user.picture}
                    alt={user.name || 'User'}
                    className="w-12 h-12 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center text-white text-lg font-medium">
                    {user.name?.charAt(0).toUpperCase() || 'U'}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 truncate">{user.name}</div>
                  <div className="text-sm text-gray-500 truncate">{user.email}</div>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="p-2 space-y-1">
              <button
                onClick={() => {
                  setShowDropdown(false);
                  setShowApiKeyModal(true);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
              >
                <KeyIcon className="w-4 h-4" />
                Anthropic API key
              </button>
              <button
                onClick={() => {
                  setShowDropdown(false);
                  setShowPrivacyModal(true);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
              >
                <ShieldCheckIcon className="w-4 h-4" />
                Data & Privacy
              </button>
              <button
                onClick={async () => {
                  setShowDropdown(false);
                  // Wipe BYOK state before handing control to Auth0. If the
                  // user signs in as someone else on the same browser we
                  // must not leak the previous account's spend counters or
                  // the `byok_use_for_chat` preference. clearKey() also
                  // calls DELETE /api/byok-key while the Auth0 session is
                  // still valid so the server-side encrypted key is also
                  // removed. clearAllByokLocalState() is belt-and-braces
                  // in case clearKey throws before its localStorage wipe.
                  try {
                    await clearKey();
                  } catch (err) {
                    console.error('[AuthButton] clearKey on logout failed:', err);
                  }
                  clearAllByokLocalState();
                  logout({ logoutParams: { returnTo: window.location.origin } });
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"
                  />
                </svg>
                Sign out
              </button>
            </div>
          </div>
        )}

        <PrivacyModal
          isOpen={showPrivacyModal}
          onClose={() => setShowPrivacyModal(false)}
          onLoggingEnabled={onLoggingEnabled}
        />
        <ApiKeyModal isOpen={showApiKeyModal} onClose={() => setShowApiKeyModal(false)} />
      </div>
    );
  }

  // Anonymous user - show dropdown with sign in and privacy settings
  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className="flex flex-col items-center gap-0.5 text-gray-600 hover:text-gray-900 transition-colors focus:outline-none"
        title="Account"
      >
        <UserCircleIcon className="w-7 h-7" />
        <span className="text-xs">Account</span>
      </button>

      {showDropdown && (
        <div className="absolute top-full right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden z-50">
          <div className="p-2 space-y-1">
            <button
              onClick={() => {
                setShowDropdown(false);
                // Preserve current URL across Auth0 redirect so the user
                // lands back on their chart (localStorage chat history is
                // keyed by URL). Matches Auth0RedirectHandler in App.tsx.
                const returnTo = window.location.pathname + window.location.search;
                localStorage.setItem('auth0_returnTo', returnTo);
                void loginWithRedirect({ appState: { returnTo } });
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1"
                />
              </svg>
              Sign in
            </button>
            <button
              onClick={() => {
                setShowDropdown(false);
                setShowPrivacyModal(true);
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
            >
              <ShieldCheckIcon className="w-4 h-4" />
              Data & Privacy
            </button>
          </div>
        </div>
      )}

      {/* Privacy Modal */}
      <PrivacyModal isOpen={showPrivacyModal} onClose={() => setShowPrivacyModal(false)} />
      {/* API-key modal is rendered here too so the tocb:openApiKeyModal
          event can open it for anon users — ByokPanel shows the Sign-in
          variant inside, so the modal is still useful pre-auth. */}
      <ApiKeyModal isOpen={showApiKeyModal} onClose={() => setShowApiKeyModal(false)} />
    </div>
  );
};

export default AuthButton;
