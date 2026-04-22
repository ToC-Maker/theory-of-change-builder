import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react';
import { useAuth0 } from '@auth0/auth0-react';

// BYOK (Bring Your Own Key) context. Raw keys live server-side (encrypted);
// the client only holds verification state and the last-4 for display.

const USE_FOR_CHAT_STORAGE_KEY = 'byok_use_for_chat';
const LEGACY_API_KEY_STORAGE_KEY = 'api_key';

export interface SubmitKeyResult {
  verified: boolean;
  last4?: string;
  error?: string;
}

export interface ApiKeyContextValue {
  hasKey: boolean;              // server has a stored BYOK key for this user
  keyLast4: string | null;      // for UI display, null if no key
  verified: boolean;            // true after most recent successful validation
  useForChat: boolean;          // user toggle; persisted in localStorage
  setUseForChat: (v: boolean) => void;
  submitKey: (raw: string) => Promise<SubmitKeyResult>;
  clearKey: () => Promise<void>;
  refresh: () => Promise<void>;
}

interface UsageResponse {
  tier?: string;
  // other fields (used_usd, limit_usd, global) exist but aren't needed here
}

interface ByokPostResponse {
  verified?: boolean;
  last4?: string;
  error?: string;
}

const ApiKeyContext = createContext<ApiKeyContextValue | undefined>(undefined);

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
  const { isAuthenticated, getIdTokenClaims } = useAuth0();

  const [hasKey, setHasKey] = useState(false);
  const [keyLast4, setKeyLast4] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [useForChat, setUseForChatState] = useState<boolean>(readUseForChat);

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
    try {
      const claims = await getIdTokenClaims();
      const idToken = claims?.__raw;
      return idToken ? { Authorization: `Bearer ${idToken}` } : {};
    } catch (err) {
      console.error('[ApiKeyContext] Failed to get ID token:', err);
      return {};
    }
  }, [isAuthenticated, getIdTokenClaims]);

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
      if (!isByok) {
        setKeyLast4(null);
        setVerified(false);
      }
      // Note: /api/usage doesn't return last4. keyLast4 is set by submitKey
      // on success; on refresh we preserve whatever submitKey last set, or
      // leave null if the user hasn't submitted in this session.
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
      // Not authenticated: reset local state anyway.
      setHasKey(false);
      setKeyLast4(null);
      setVerified(false);
      return;
    }

    try {
      const response = await fetch('/api/byok-key', {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (response.ok) {
        setHasKey(false);
        setKeyLast4(null);
        setVerified(false);
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
  };

  return <ApiKeyContext.Provider value={value}>{children}</ApiKeyContext.Provider>;
}

export function useApiKey(): ApiKeyContextValue {
  const context = useContext(ApiKeyContext);
  if (context === undefined) {
    throw new Error('useApiKey must be used within an ApiKeyProvider');
  }
  return context;
}

/**
 * @deprecated Transitional export retained until ChatInterface migrates to
 * server-side BYOK validation. New code should POST the key to /api/byok-key
 * and let the server validate via count_tokens. Remove this once ChatInterface
 * no longer imports it.
 */
export function validateApiKey(key: string): { isValid: boolean; error?: string } {
  const trimmedKey = key.trim();
  if (!trimmedKey) return { isValid: false, error: 'API key is required' };
  if (trimmedKey.length < 30) return { isValid: false, error: 'API key appears to be too short' };
  return { isValid: true };
}
