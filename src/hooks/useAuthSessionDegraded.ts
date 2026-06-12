import { useSyncExternalStore } from 'react';
import { isAuthSessionDegraded, subscribeAuthSessionHealth } from '../services/authSessionHealth';

/**
 * True while the signed-in session can no longer mint API tokens (see
 * authSessionHealth.ts). Re-renders on store transitions only.
 */
export function useAuthSessionDegraded(): boolean {
  return useSyncExternalStore(subscribeAuthSessionHealth, isAuthSessionDegraded);
}
