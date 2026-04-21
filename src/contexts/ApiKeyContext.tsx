import React, { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';

// NEW shape (being built by U6 in parallel). The BYOK panel and file-chip
// components expect this interface. The fields below preserve the previous
// localStorage-backed behavior so ChatInterface keeps working until U6 lands
// the real server-backed implementation.
interface ApiKeyContextType {
  // --- NEW shape (U6) -------------------------------------------------------
  hasKey: boolean;
  keyLast4: string | null;
  verified: boolean;
  useForChat: boolean;
  setUseForChat: (v: boolean) => void;
  submitKey: (raw: string) => Promise<{ verified: boolean; last4?: string; error?: string }>;
  clearKey: () => Promise<void>;
  refresh: () => Promise<void>;

  // --- OLD shape (retained for ChatInterface until U6 refactor lands) -------
  apiKey: string;
  setApiKey: (key: string) => void;
  isConfigured: boolean;
  clearApiKey: () => void;
}

const ApiKeyContext = createContext<ApiKeyContextType | undefined>(undefined);

const API_KEY_STORAGE_KEY = 'api_key';
const USE_FOR_CHAT_STORAGE_KEY = 'api_key_use_for_chat';

interface ApiKeyProviderProps {
  children: ReactNode;
}

function extractLast4(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 4) return null;
  return trimmed.slice(-4);
}

export function ApiKeyProvider({ children }: ApiKeyProviderProps) {
  const [apiKey, setApiKeyState] = useState<string>('');
  const [useForChat, setUseForChatState] = useState<boolean>(false);

  useEffect(() => {
    // Load API key from localStorage on mount
    const storedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (storedKey) {
      setApiKeyState(storedKey);
    }
    const storedUseForChat = localStorage.getItem(USE_FOR_CHAT_STORAGE_KEY);
    if (storedUseForChat === 'true') {
      setUseForChatState(true);
    }
  }, []);

  const setApiKey = useCallback((key: string) => {
    const trimmedKey = key.trim();
    setApiKeyState(trimmedKey);

    if (trimmedKey) {
      localStorage.setItem(API_KEY_STORAGE_KEY, trimmedKey);
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
    }
  }, []);

  const clearApiKey = useCallback(() => {
    setApiKeyState('');
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  }, []);

  const setUseForChat = useCallback((v: boolean) => {
    setUseForChatState(v);
    localStorage.setItem(USE_FOR_CHAT_STORAGE_KEY, v ? 'true' : 'false');
  }, []);

  // NEW shape: submitKey returns a verification result. The real implementation
  // will POST to /api/byok-key and receive a server-side encrypted confirmation.
  // Stub verifies the sk-ant- prefix and stores locally so the UI flow works.
  const submitKey = useCallback(async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('sk-ant-')) {
      return { verified: false, error: 'API key must start with "sk-ant-".' };
    }
    if (trimmed.length < 30) {
      return { verified: false, error: 'API key appears to be too short.' };
    }
    setApiKey(trimmed);
    return { verified: true, last4: extractLast4(trimmed) ?? undefined };
  }, [setApiKey]);

  const clearKey = useCallback(async () => {
    clearApiKey();
  }, [clearApiKey]);

  const refresh = useCallback(async () => {
    // Placeholder: real implementation will re-query /api/byok-key status.
    const storedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    setApiKeyState(storedKey ?? '');
  }, []);

  // Derive NEW-shape fields from the stored key.
  const hasKey = apiKey.length > 0;
  const keyLast4 = apiKey ? extractLast4(apiKey) : null;
  const verified = hasKey; // local stub has no separate verification round-trip

  // OLD API key is managed server-side in prior iteration; always report
  // isConfigured=true so existing ChatInterface flow is unchanged.
  const isConfigured = true;

  const value: ApiKeyContextType = {
    hasKey,
    keyLast4,
    verified,
    useForChat,
    setUseForChat,
    submitKey,
    clearKey,
    refresh,
    apiKey,
    setApiKey,
    isConfigured,
    clearApiKey,
  };

  return (
    <ApiKeyContext.Provider value={value}>
      {children}
    </ApiKeyContext.Provider>
  );
}

export function useApiKey(): ApiKeyContextType {
  const context = useContext(ApiKeyContext);
  if (context === undefined) {
    throw new Error('useApiKey must be used within an ApiKeyProvider');
  }
  return context;
}

// Validation helper (retained from prior shape).
export function validateApiKey(key: string): { isValid: boolean; error?: string } {
  const trimmedKey = key.trim();

  if (!trimmedKey) {
    return { isValid: false, error: 'API key is required' };
  }

  if (trimmedKey.length < 30) {
    return { isValid: false, error: 'API key appears to be too short' };
  }

  return { isValid: true };
}
