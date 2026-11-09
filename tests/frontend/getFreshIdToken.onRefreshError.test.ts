// getFreshIdToken's onRefreshError callback — PR #34 round-4.
//
// getFreshIdToken deliberately swallows silent-refresh errors and returns
// null ("not authenticated right now"). That's right for callers, but it
// also erased the error CLASS — the App-level token provider couldn't
// distinguish "network blip, retry will fix it" from "Unknown or invalid
// refresh token" (invalid_grant — grant revoked, never self-heals, needs a
// re-login). The optional onRefreshError callback hands the raw SDK error
// to the caller so authSessionHealth can classify it, without changing the
// null-return contract for existing callers.

import { describe, it, expect, vi } from 'vitest';
import { getFreshIdToken } from '../../src/utils/auth';

type GetToken = Parameters<typeof getFreshIdToken>[0];
type GetClaims = Parameters<typeof getFreshIdToken>[1];

describe('getFreshIdToken onRefreshError', () => {
  it('fires the callback with the SDK error when silent refresh throws, and still returns null', async () => {
    const sdkError = Object.assign(new Error('Unknown or invalid refresh token.'), {
      error: 'invalid_grant',
    });
    // No cached claims -> refresh required.
    const getClaims = vi.fn().mockResolvedValue(undefined) as unknown as GetClaims;
    const getToken = vi.fn().mockRejectedValue(sdkError) as unknown as GetToken;
    const onRefreshError = vi.fn();
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const token = await getFreshIdToken(getToken, getClaims, onRefreshError);

    expect(token).toBeNull();
    expect(onRefreshError).toHaveBeenCalledTimes(1);
    expect(onRefreshError).toHaveBeenCalledWith(sdkError);
    consoleWarn.mockRestore();
  });

  it('does not fire the callback when the cached token is still fresh', async () => {
    const raw = 'header.payload.sig';
    const getClaims = vi.fn().mockResolvedValue({
      __raw: raw,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }) as unknown as GetClaims;
    const getToken = vi.fn() as unknown as GetToken;
    const onRefreshError = vi.fn();

    const token = await getFreshIdToken(getToken, getClaims, onRefreshError);

    expect(token).toBe(raw);
    expect(onRefreshError).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });
});
