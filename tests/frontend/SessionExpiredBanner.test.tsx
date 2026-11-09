// Tests for SessionExpiredBanner + authSessionHealth — PR #34 round-4.
//
// Field report: Auth0's refresh-token grant died ("Unknown or invalid
// refresh token", invalid_grant family — rotation reuse-detection or
// absolute-lifetime expiry). `isAuthenticated` stayed true from the
// localstorage cache while every request-time token resolution returned
// null, so the app silently demoted to anonymous: recent charts 401'd,
// autosaves went out unauthenticated, and nothing on screen said why.
// Log-out/in fixes it (new grant) — but the user had no way to know.
//
// Contract under test:
//   - a definitive Auth0 failure (invalid_grant family) shows the banner
//     immediately — this class never self-heals, no point debouncing;
//   - a single transient failure (network blip) does NOT show it;
//   - AUTH_SESSION_FAILURE_THRESHOLD consecutive transient failures do;
//   - a success between transient failures resets the counter;
//   - the banner never renders for anonymous users, whatever the store
//     says (gate on isAuthenticated);
//   - a token resolving clears the banner (recovery);
//   - "Sign in again" routes through loginWithRedirect with the same
//     returnTo appState the ByokPanel sign-in uses, so the user lands
//     back on the chart they were editing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SessionExpiredBanner } from '../../src/components/SessionExpiredBanner';
import {
  AUTH_SESSION_FAILURE_THRESHOLD,
  reportAuthTokenFailure,
  reportAuthTokenSuccess,
  resetAuthSessionHealth,
} from '../../src/services/authSessionHealth';

const mockUseAuth0 = vi.fn();
vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => mockUseAuth0(),
}));

const auth0State = (isAuthenticated: boolean) => ({
  isAuthenticated,
  loginWithRedirect: vi.fn(),
});

// Shape auth0-spa-js throws: GenericError with an `error` code property.
const invalidGrantError = () =>
  Object.assign(new Error('Unknown or invalid refresh token.'), {
    error: 'invalid_grant',
  });

const transientError = () => new Error('Failed to fetch');

beforeEach(() => {
  resetAuthSessionHealth();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SessionExpiredBanner', () => {
  it('shows after a definitive auth failure and re-login goes through loginWithRedirect', async () => {
    const state = auth0State(true);
    mockUseAuth0.mockReturnValue(state);
    render(<SessionExpiredBanner />);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    act(() => {
      reportAuthTokenFailure(invalidGrantError());
    });

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(/session has expired/i);

    await userEvent.click(screen.getByRole('button', { name: /sign in again/i }));
    expect(state.loginWithRedirect).toHaveBeenCalledTimes(1);
    // Same returnTo contract as ByokPanel's sign-in: land back on the
    // chart being edited, not at `/`.
    expect(state.loginWithRedirect).toHaveBeenCalledWith({
      appState: { returnTo: window.location.pathname + window.location.search },
    });
    expect(localStorage.getItem('auth0_returnTo')).toBe(
      window.location.pathname + window.location.search,
    );
  });

  it('does not show on a single transient failure', () => {
    mockUseAuth0.mockReturnValue(auth0State(true));
    render(<SessionExpiredBanner />);

    act(() => {
      reportAuthTokenFailure(transientError());
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows after AUTH_SESSION_FAILURE_THRESHOLD consecutive transient failures', () => {
    mockUseAuth0.mockReturnValue(auth0State(true));
    render(<SessionExpiredBanner />);

    act(() => {
      for (let i = 0; i < AUTH_SESSION_FAILURE_THRESHOLD; i++) {
        reportAuthTokenFailure(transientError());
      }
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('a success between transient failures resets the counter', () => {
    mockUseAuth0.mockReturnValue(auth0State(true));
    render(<SessionExpiredBanner />);

    act(() => {
      for (let i = 0; i < AUTH_SESSION_FAILURE_THRESHOLD - 1; i++) {
        reportAuthTokenFailure(transientError());
      }
      reportAuthTokenSuccess();
      for (let i = 0; i < AUTH_SESSION_FAILURE_THRESHOLD - 1; i++) {
        reportAuthTokenFailure(transientError());
      }
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('never shows for anonymous users, even if the store reports failures', () => {
    mockUseAuth0.mockReturnValue(auth0State(false));
    render(<SessionExpiredBanner />);

    act(() => {
      reportAuthTokenFailure(invalidGrantError());
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears once a token resolves again', () => {
    mockUseAuth0.mockReturnValue(auth0State(true));
    render(<SessionExpiredBanner />);

    act(() => {
      reportAuthTokenFailure(invalidGrantError());
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => {
      reportAuthTokenSuccess();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
