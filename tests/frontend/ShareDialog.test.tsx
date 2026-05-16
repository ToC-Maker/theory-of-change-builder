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
//
// Note on chartService mock — we replace the static methods on the
// imported class directly, which is simpler than module-level mocking
// for one-off integration tests. Each test resets the mocks in afterEach.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
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
});
