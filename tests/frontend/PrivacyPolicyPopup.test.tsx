// Tests for `PrivacyPolicyPopup` — the first-visit privacy gate on the
// editor route. Pins the contract that survives the unification with
// the shared `<ConfirmModal>` primitive (PR 7):
//
//   - Single-action UX: only one button ("I Understand"); no cancel
//     button is rendered.
//   - Non-dismissable: backdrop click does not close the popup.
//   - Route gating: renders on the editor route (`/`), not on the
//     view-only `/chart/{id}` route.
//   - localStorage gating: when `privacyPolicyAccepted` AND
//     `usageLoggingOptOut` are both already set, the popup stays hidden.
//   - "I Understand" persists the acknowledgment + logging preference
//     and fires the onAccept callback.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PrivacyPolicyPopup } from '../../src/components/PrivacyPolicyPopup';

// `loggingService.setOptOut` performs a fire-and-forget fetch to sync
// the preference to the server. The fetch is fine to leave alone in
// jsdom (it 404s harmlessly), but mocking the method is cleaner so we
// can assert on its arguments.
vi.mock('../../src/services/loggingService', () => ({
  loggingService: {
    setOptOut: vi.fn(),
  },
}));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function renderAt(path: string, onAccept?: (loggingEnabled: boolean) => void) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <PrivacyPolicyPopup onAccept={onAccept} />
    </MemoryRouter>,
  );
}

describe('PrivacyPolicyPopup', () => {
  it('renders the popup on the editor route when never accepted', () => {
    renderAt('/');
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByTestId('confirm-modal')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /privacy & data protection/i })).toBeInTheDocument();
  });

  it('renders only a single action button (no cancel)', () => {
    renderAt('/');
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByTestId('confirm-modal-confirm').textContent).toMatch(/i understand/i);
    expect(screen.queryByTestId('confirm-modal-cancel')).toBeNull();
  });

  it('backdrop click does NOT close the popup (non-dismissable)', () => {
    renderAt('/');
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    fireEvent.click(screen.getByTestId('confirm-modal-backdrop'));
    // Still mounted.
    expect(screen.getByTestId('confirm-modal')).toBeInTheDocument();
  });

  it('Escape key does NOT close the popup (non-dismissable)', () => {
    renderAt('/');
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByTestId('confirm-modal')).toBeInTheDocument();
  });

  it('does not render on /chart/{id} view-only routes', () => {
    renderAt('/chart/abc-123');
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByTestId('confirm-modal')).toBeNull();
  });

  it('does not render when privacyPolicyAccepted + usageLoggingOptOut are both set', () => {
    localStorage.setItem('privacyPolicyAccepted', 'true');
    localStorage.setItem('usageLoggingOptOut', 'false');
    renderAt('/');
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.queryByTestId('confirm-modal')).toBeNull();
  });

  it('clicking "I Understand" persists acknowledgment and fires onAccept', async () => {
    const { loggingService } = await import('../../src/services/loggingService');
    const onAccept = vi.fn();
    renderAt('/', onAccept);
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    fireEvent.click(screen.getByTestId('confirm-modal-confirm'));
    expect(localStorage.getItem('privacyPolicyAccepted')).toBe('true');
    expect(localStorage.getItem('privacyPolicyAcceptedDate')).not.toBeNull();
    // Default share-data checkbox is checked → setOptOut(false).
    expect(loggingService.setOptOut).toHaveBeenCalledWith(false);
    expect(onAccept).toHaveBeenCalledWith(true);
  });

  it('renders the opt-in checkbox and policy link as extras', () => {
    renderAt('/');
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /privacy policy/i })).toBeInTheDocument();
  });

  it('unchecking the share-data box flips the logging preference', async () => {
    const { loggingService } = await import('../../src/services/loggingService');
    vi.mocked(loggingService.setOptOut).mockClear();
    renderAt('/');
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
    fireEvent.click(screen.getByTestId('confirm-modal-confirm'));
    expect(loggingService.setOptOut).toHaveBeenCalledWith(true);
  });
});
