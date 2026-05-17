// Integration tests for ShareDialog — the redesigned share modal.
//
// These tests stub ChartService (no real network) and Auth0 (no real
// session) so the dialog can be exercised end-to-end in jsdom. The
// assertions are layered:
//   - Layout: header, 3-mode selector, two LinkCopyRows, conditional
//     embed expander, inline PermissionsList for owners.
//   - Restricted gate: embed expander hidden when level=restricted.
//   - Wiring: clicking "Anyone can edit" calls
//     ChartService.updateLinkSharing(chartId, 'editor').
//   - Rollback: a rejected updateLinkSharing rolls back to the previous
//     level and surfaces the error.
//   - Confirm cancel: when window.confirm returns false, the dialog
//     does NOT call updateLinkSharing and the local level is unchanged.
//   - Divergence banner: persists until the user acknowledges it
//     (regression for the one-frame banner-flash bug).
//
// Note on chartService mock — we replace the static methods on the
// imported class directly, which is simpler than module-level mocking
// for one-off integration tests. Each test resets the mocks in afterEach.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ChartService } from '../../src/services/chartService';
import { ShareDialog } from '../../src/components/share/ShareDialog';

// Auth0 stub. We only need useAuth0().{user, isAuthenticated, isLoading}
// for ShareDialog; we don't exercise the Auth0Provider lifecycle.
vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    user: { email: 'owner@example.test', sub: 'auth0|abc' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

const baseProps = {
  open: true,
  onClose: vi.fn(),
  data: { sections: [], title: 'My ToC' } as never,
  currentEditToken: 'tok-abc' as string | null,
  containerSize: { width: 1024, height: 768 },
  onChartCreated: vi.fn(),
};

beforeEach(() => {
  vi.spyOn(ChartService, 'getChartByEditToken').mockResolvedValue({
    chartId: 'chart-xyz',
    chartData: { sections: [] } as never,
    canEdit: true,
    isOwner: true,
  });
  vi.spyOn(ChartService, 'getChartPermissions').mockResolvedValue({
    permissions: [
      {
        user_id: 'auth0|abc',
        user_email: 'owner@example.test',
        permission_level: 'owner',
        granted_at: '2026-01-01',
        granted_by: 'auth0|abc',
      },
      {
        user_id: 'auth0|pending',
        user_email: 'alice@example.test',
        permission_level: 'edit',
        granted_at: '2026-01-02',
        granted_by: 'auth0|abc',
        // chartService's response shape doesn't expose status in the
        // typed interface but the runtime does — cast through any.
      } as never,
    ],
    linkSharingLevel: 'restricted',
  });
  vi.spyOn(ChartService, 'updateLinkSharing').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const renderDialog = (props: Partial<typeof baseProps> = {}) =>
  render(
    <MemoryRouter>
      <ShareDialog {...baseProps} {...props} />
    </MemoryRouter>,
  );

describe('ShareDialog', () => {
  it('renders the dialog header and bootstraps share data on open', async () => {
    renderDialog();
    expect(screen.getByRole('dialog', { name: /share chart/i })).toBeInTheDocument();
    expect(screen.getByText('Share chart')).toBeInTheDocument();

    await waitFor(() => {
      expect(ChartService.getChartByEditToken).toHaveBeenCalledWith('tok-abc');
    });
    // View + Edit link rows rendered after bootstrap.
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
      expect(screen.getByText('Edit link')).toBeInTheDocument();
    });
  });

  it('shows the 3-mode selector for an authenticated owner', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });
    expect(screen.getByText('Restricted')).toBeInTheDocument();
    expect(screen.getByText('Anyone can view')).toBeInTheDocument();
    expect(screen.getByText('Anyone can edit')).toBeInTheDocument();
  });

  it('hides the embed expander when mode is restricted (Task 2.2)', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });
    expect(screen.queryByText(/embed code/i)).toBeNull();
  });

  it('shows the embed expander when mode flips to viewer or editor', async () => {
    // Boot with mode=viewer from the server.
    (ChartService.getChartPermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
      permissions: [
        {
          user_id: 'auth0|abc',
          user_email: 'owner@example.test',
          permission_level: 'owner',
          granted_at: '2026-01-01',
          granted_by: 'auth0|abc',
        },
      ],
      linkSharingLevel: 'viewer',
    });

    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/embed code/i)).toBeInTheDocument();
    });
  });

  it('renders the inline permissions list (no collapse toggle)', async () => {
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('owner@example.test')).toBeInTheDocument();
    });
    // No "Manage Permissions" toggle button — the list is always inline.
    expect(screen.queryByRole('button', { name: /manage permissions/i })).toBeNull();
  });

  it('closes when the user clicks the close button', async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });
    act(() => {
      screen.getByLabelText(/close share dialog/i).click();
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when Escape is pressed', async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
  });

  // Wiring assertion the test-file header promises: clicking a mode
  // radio invokes ChartService.updateLinkSharing with the new mode.
  it('calls ChartService.updateLinkSharing when the owner picks a different mode', async () => {
    // Boot with mode=viewer so picking "Anyone can edit" doesn't trip
    // the restricted-confirm prompt.
    (ChartService.getChartPermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
      permissions: [
        {
          user_id: 'auth0|abc',
          user_email: 'owner@example.test',
          permission_level: 'owner',
          granted_at: '2026-01-01',
          granted_by: 'auth0|abc',
        },
      ],
      linkSharingLevel: 'viewer',
    });
    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('radio', { name: /anyone can edit/i }));
    await waitFor(() => {
      expect(ChartService.updateLinkSharing).toHaveBeenCalledWith('chart-xyz', 'editor');
    });
  });

  it('rolls back the optimistic local update when updateLinkSharing rejects', async () => {
    // Boot with mode=viewer.
    (ChartService.getChartPermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
      permissions: [
        {
          user_id: 'auth0|abc',
          user_email: 'owner@example.test',
          permission_level: 'owner',
          granted_at: '2026-01-01',
          granted_by: 'auth0|abc',
        },
      ],
      linkSharingLevel: 'viewer',
    });
    (ChartService.updateLinkSharing as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('network down'),
    );

    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });

    // Pre-click: viewer is selected (server level folded into local).
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /anyone can view/i })).toHaveAttribute(
        'aria-checked',
        'true',
      );
    });

    await user.click(screen.getByRole('radio', { name: /anyone can edit/i }));

    // After rejection: error surfaces AND viewer is selected again
    // (the optimistic update was rolled back).
    await waitFor(() => {
      expect(screen.getByText(/network down/i)).toBeInTheDocument();
    });
    expect(screen.getByRole('radio', { name: /anyone can view/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: /anyone can edit/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('does not call updateLinkSharing when the embed-break confirm is cancelled', async () => {
    // Boot with mode=viewer. Going viewer → restricted prompts confirm.
    (ChartService.getChartPermissions as ReturnType<typeof vi.fn>).mockResolvedValue({
      permissions: [
        {
          user_id: 'auth0|abc',
          user_email: 'owner@example.test',
          permission_level: 'owner',
          granted_at: '2026-01-01',
          granted_by: 'auth0|abc',
        },
      ],
      linkSharingLevel: 'viewer',
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const user = userEvent.setup();
    renderDialog();
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('radio', { name: /^restricted$/i }));

    // Confirm was prompted, but the user said no.
    expect(confirmSpy).toHaveBeenCalled();
    // No write.
    expect(ChartService.updateLinkSharing).not.toHaveBeenCalled();
    // Selector still shows the previous mode.
    expect(screen.getByRole('radio', { name: /anyone can view/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('keeps the divergence banner visible until the user acks it (regression)', async () => {
    // Scenario the L1 mitigation guards: dialog has already booted at
    // one level (initial load); a cross-tab event triggers the refresh
    // hook, which then sees a different level. We use a closure flag
    // that flips AFTER initial load so the storage-triggered fetches
    // see the new ('editor') level; closure makes this robust to
    // race ordering between loadPermissions and the L1 hook's adapter.
    const ownerRow = {
      user_id: 'auth0|abc',
      user_email: 'owner@example.test',
      permission_level: 'owner' as const,
      granted_at: '2026-01-01',
      granted_by: 'auth0|abc',
    };
    let serverLevel: 'restricted' | 'editor' = 'restricted';
    (ChartService.getChartPermissions as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return {
        permissions: [ownerRow],
        linkSharingLevel: serverLevel,
      };
    });

    const user = userEvent.setup();
    renderDialog();

    // Wait for the initial load to settle.
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });

    // Flip the server-side level under our feet, then fire a storage
    // event to trigger the L1 hook to re-fetch.
    serverLevel = 'editor';
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'toc:permissions' }));
    });

    // Banner shows up after the storage-triggered fetch resolves.
    const banner = await screen.findByText(/changed by another tab/i);
    expect(banner).toBeInTheDocument();

    // Wait through a couple of microtasks — banner must NOT auto-dismiss
    // (was previously gone in the same render after the auto-fold).
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/changed by another tab/i)).toBeInTheDocument();

    // User acks via the Got it button.
    const ackButton = screen.getByRole('button', { name: /got it/i });
    await user.click(ackButton);

    // Banner is gone.
    await waitFor(() => {
      expect(screen.queryByText(/changed by another tab/i)).toBeNull();
    });
  });

  it('shows the fetch-error warning when the L1 hook fetch rejects', async () => {
    // Initial loads succeed; after the storage-triggered re-fetch, the
    // mock starts rejecting. Use a closure flag to be robust to race
    // ordering between loadPermissions and the L1 hook's adapter.
    const ownerRow = {
      user_id: 'auth0|abc',
      user_email: 'owner@example.test',
      permission_level: 'owner' as const,
      granted_at: '2026-01-01',
      granted_by: 'auth0|abc',
    };
    let shouldFail = false;
    (ChartService.getChartPermissions as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (shouldFail) {
        throw new Error('hook fetch failed');
      }
      return {
        permissions: [ownerRow],
        linkSharingLevel: 'restricted',
      };
    });

    renderDialog();

    // Wait for the initial load to settle.
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });

    // Flip to failing, then trigger the L1 hook to re-fetch.
    shouldFail = true;
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'toc:permissions' }));
    });

    await waitFor(() => {
      expect(screen.getByText(/couldn't verify current sharing level/i)).toBeInTheDocument();
    });
  });
});
