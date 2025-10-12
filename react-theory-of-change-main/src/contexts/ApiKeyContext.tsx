import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface ApiKeyContextType {
  apiKey: string;
  setApiKey: (key: string) => void;
  isConfigured: boolean;
  clearApiKey: () => void;
}

const ApiKeyContext = createContext<ApiKeyContextType | undefined>(undefined);

const API_KEY_STORAGE_KEY = 'anthropic_api_key';

interface ApiKeyProviderProps {
  children: ReactNode;
}

export function ApiKeyProvider({ children }: ApiKeyProviderProps) {
  const [apiKey, setApiKeyState] = useState<string>('');

  useEffect(() => {
    // Load API key from localStorage on mount
    const storedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (storedKey) {
      setApiKeyState(storedKey);
    }
  }, []);

  const setApiKey = (key: string) => {
    const trimmedKey = key.trim();
    setApiKeyState(trimmedKey);
    
    if (trimmedKey) {
      localStorage.setItem(API_KEY_STORAGE_KEY, trimmedKey);
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
    }
  };

  const clearApiKey = () => {
    setApiKeyState('');
    localStorage.removeItem(API_KEY_STORAGE_KEY);
  };

  // API key is now managed on the backend via edge function, always return true
  const isConfigured = true;

  const value: ApiKeyContextType = {
    apiKey,
    setApiKey,
    isConfigured,
    clearApiKey
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

// Validation helper
export function validateApiKey(key: string): { isValid: boolean; error?: string } {
  const trimmedKey = key.trim();
  
  if (!trimmedKey) {
    return { isValid: false, error: 'API key is required' };
  }
  
  if (!trimmedKey.startsWith('sk-')) {
    return { isValid: false, error: 'API key must start with "sk-"' };
  }
  
  if (trimmedKey.length < 20) {
    return { isValid: false, error: 'API key appears to be too short' };
  }
  
  return { isValid: true };
}