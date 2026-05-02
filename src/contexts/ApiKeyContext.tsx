import { useCallback, useEffect, useState, ReactNode } from 'react';
import { useAuth0 } from '@auth0/auth0-react';
import { clearKeySpend, clearAllByokLocalState } from '../utils/byokSpend';
import { getFreshIdToken } from '../utils/auth';
import { ApiKeyContext, ApiKeyContextValue, SubmitKeyResult } from './useApiKey';

// BYOK (Bring Your Own Key) context. Raw keys live server-side (encrypted);
// the client only holds verification state and the last-4 for display.

const USE_FOR_CHAT_STORAGE_KEY = 'byok_use_for_chat';
const LEGACY_API_KEY_STORAGE_KEY = 'api_key';

interface UsageResponse {
  tier?: string;
  // Last-4 of the user's stored BYOK key when tier === 'byok'. Round-tripped
  // so a page reload can rehydrate the byok-spend-key-<last4> localStorage
  // bucket without requiring the user to re-submit the key.
  byok_last4?: string | null;
  // other fields (used_usd, limit_usd, global) exist but aren't needed here
}

interface ByokPostResponse {
  verified?: boolean;
  last4?: string;
  error?: string;
}

function readUseForChat(): boolean {
  try {
    return localStorage.getItem(USE_FOR_CHAT_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

interface ApiKeyProviderProps {
  children: ReactNode;
}

export function ApiKeyProvider({ children }: ApiKeyProviderProps) {
  const { isAuthenticated, getIdTokenClaims, getAccessTokenSilently } = useAuth0();

  const [hasKey, setHasKey] = useState(false);
  const [keyLast4, setKeyLast4] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [useForChat, setUseForChatState] = useState<boolean>(readUseForChat);
  const [keyVersion, setKeyVersion] = useState(0);

  // One-time migration: retire the old client-stored raw key scheme. We don't
  // migrate the value; user re-enters via the new flow so the key lands in
  // the server-side encrypted store.
  useEffect(() => {
    try {
      if (localStorage.getItem(LEGACY_API_KEY_STORAGE_KEY) !== null) {
        localStorage.removeItem(LEGACY_API_KEY_STORAGE_KEY);
      }
    } catch {
      // localStorage unavailable (SSR, privacy mode); ignore
    }
  }, []);

  const getAuthHeader = useCallback(async (): Promise<Record<string, string>> => {
    if (!isAuthenticated) return {};
    const idToken = await getFreshIdToken(getAccessTokenSilently, getIdTokenClaims);
    return idToken ? { Authorization: `Bearer ${idToken}` } : {};
  }, [isAuthenticated, getIdTokenClaims, getAccessTokenSilently]);

  const refresh = useCallback(async (): Promise<void> => {
    if (!isAuthenticated) {
      setHasKey(false);
      setKeyLast4(null);
      setVerified(false);
      return;
    }

    try {
      const authHeaders = await getAuthHeader();
      const response = await fetch('/api/usage', { headers: authHeaders });
      if (!response.ok) {
        // Don't clobber known state on transient failures (e.g. 503).
        return;
      }
      const data: UsageResponse = await response.json();
      const isByok = data.tier === 'byok';
      setHasKey(isByok);
      // Server-stored keys are validated at POST /api/byok-key time — a
      // tier of 'byok' here means the key survived that probe, so
      // `verified` should flip true. Previously only submitKey set this;
      // a post-login refresh left `verified=false` even though the key
      // had been submitted on a prior session, so the UI kept gating
      // Generate behind "Add your Anthropic API key" until the user
      // re-submitted.
      setVerified(isByok);
      if (!isByok) {
        setKeyLast4(null);
      } else if (data.byok_last4) {
        // /api/usage now round-trips key_last4 from user_byok_keys so a
        // page reload (or post-login refresh) restores it without needing
        // the user to re-submit. Without this the byok-spend-key-<last4>
        // bucket couldn't be rehydrated and per-key spend tracking
        // silently broke for any session that didn't go through submitKey.
        setKeyLast4(data.byok_last4);
      }
    } catch (err) {
      console.error('[ApiKeyContext] refresh failed:', err);
    }
  }, [isAuthenticated, getAuthHeader]);

  // Discipline: `raw` is never logged and never stored in component state. It
  // lives in this closure only until the POST completes, then goes out of scope.
  const submitKey = useCallback(
    async (raw: string): Promise<SubmitKeyResult> => {
      const authHeaders = await getAuthHeader();
      if (!authHeaders.Authorization) {
        return { verified: false, error: 'Authentication required' };
      }

      try {
        const response = await fetch('/api/byok-key', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...authHeaders,
          },
          body: JSON.stringify({ key: raw }),
        });
        const data: ByokPostResponse = await response.json();

        if (response.ok && data.verified) {
          setHasKey(true);
          setKeyLast4(data.last4 ?? null);
          setVerified(true);
          setKeyVersion((v) => v + 1);
          return { verified: true, last4: data.last4 };
        }

        return {
          verified: false,
          error: data.error ?? `Verification failed (${response.status})`,
        };
      } catch (err) {
        console.error('[ApiKeyContext] submitKey failed:', err);
        return { verified: false, error: 'Network error' };
      }
    },
    [getAuthHeader],
  );

  const clearKey = useCallback(async (): Promise<void> => {
    const authHeaders = await getAuthHeader();
    if (!authHeaders.Authorization) {
      // Not authenticated: reset in-memory state AND wipe any BYOK
      // localStorage the user may have accumulated before logging in. The
      // server DELETE requires auth, but the local counters/toggle don't —
      // guarding them would leak state across users sharing a browser.
      setHasKey(false);
      setKeyLast4((prev) => {
        if (prev) clearKeySpend(prev);
        return null;
      });
      setVerified(false);
      setUseForChatState(false);
      clearAllByokLocalState();
      setKeyVersion((v) => v + 1);
      return;
    }

    try {
      const response = await fetch('/api/byok-key', {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (response.ok) {
        setHasKey(false);
        // Clean up the per-key spend counter for the key being removed.
        // Use the state updater to capture the current last4 (closure would
        // otherwise be stale). Returns null to clear the state after the
        // side effect.
        setKeyLast4((prev) => {
          if (prev) clearKeySpend(prev);
          return null;
        });
        setVerified(false);
        setUseForChatState(false);
        clearAllByokLocalState();
        setKeyVersion((v) => v + 1);
      }
    } catch (err) {
      console.error('[ApiKeyContext] clearKey failed:', err);
    }
  }, [getAuthHeader]);

  const setUseForChat = useCallback((v: boolean) => {
    setUseForChatState(v);
    try {
      localStorage.setItem(USE_FOR_CHAT_STORAGE_KEY, v ? 'true' : 'false');
    } catch {
      // localStorage unavailable; in-memory state still updated
    }
  }, []);

  // Populate initial state. Re-run when auth state flips.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value: ApiKeyContextValue = {
    hasKey,
    keyLast4,
    verified,
    useForChat,
    setUseForChat,
    submitKey,
    clearKey,
    refresh,
    keyVersion,
  };

  return <ApiKeyContext.Provider value={value}>{children}</ApiKeyContext.Provider>;
}
