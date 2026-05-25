import { createContext, useContext } from 'react';

// BYOK (Bring Your Own Key) context hook + associated types. The component
// implementation lives in ApiKeyContext.tsx. Split out so the context module
// only exports components, which is required for React Fast Refresh.

export interface SubmitKeyResult {
  verified: boolean;
  last4?: string;
  error?: string;
}

export interface ApiKeyContextValue {
  hasKey: boolean; // server has a stored BYOK key for this user
  keyLast4: string | null; // for UI display, null if no key
  verified: boolean; // true after most recent successful validation
  useForChat: boolean; // user toggle; persisted in localStorage
  setUseForChat: (v: boolean) => void;
  submitKey: (raw: string) => Promise<SubmitKeyResult>;
  clearKey: () => Promise<void>;
  refresh: () => Promise<void>;
  /**
   * Monotonically increasing counter that bumps on every key change (submit
   * success or clear). Consumers that depend on server-side tier changes
   * (e.g. ChatInterface's /api/usage fetch) can add this to a useEffect
   * dependency list to re-query after the user flips BYOK state.
   */
  keyVersion: number;
}

export const ApiKeyContext = createContext<ApiKeyContextValue | undefined>(undefined);

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
