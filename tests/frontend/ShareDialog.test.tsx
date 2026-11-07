// Integration tests for ShareDialog — the redesigned share modal.
//
// As of the App-owns-permissions refactor, ShareDialog is a
// presentational consumer: it receives `permissions`,
// `linkSharingLevel`, `permissionsLoading`, and
// `permissionsFetchError` as props. It still owns the chart-create
// bootstrap (`getChartByEditToken` / `createChart`) and the
// optimistic-update + rollback flow for `updateLinkSharing`. These
// tests cover:
//   - Layout: header, 3-mode selector, two LinkCopyRows, conditional
//     embed expander, inline PermissionsList for owners.
//   - Restricted gate: embed expander hidden when level=restricted.
//   - Wiring: clicking "Anyone can edit" calls
//     ChartService.updateLinkSharing(chartId, 'editor') and bumps the
//     parent's level via `onOptimisticLinkSharingLevel`.
//   - Rollback: a rejected updateLinkSharing rolls back the optimistic
//     level via the same channel and surfaces the error.
//   - Confirm cancel: when window.confirm returns false, the dialog
//     does NOT call updateLinkSharing and the local level is unchanged.
//   - Divergence banner: persists until the user acknowledges it
//     (regression for the one-frame banner-flash bug).
//
// chartService is stubbed via per-test spies (no real network). Each
// test resets mocks in afterEach.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ChartApiError, ChartService } from '../../src/services/chartService';
import { ShareDialog, type ShareDialogProps } from '../../src/components/share/ShareDialog';
import type { Permission, LinkSharingLevel } from '../../shared/permissions';

// Auth0 stub. We only need useAuth0().{user, isAuthenticated, isLoading}
// for ShareDialog; we don't exercise the Auth0Provider lifecycle.
const auth = vi.hoisted(() => ({ isAuthenticated: true }));
vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    user: { email: 'owner@example.test', sub: 'auth0|abc' },
    isAuthenticated: auth.isAuthenticated,
    isLoading: false,
  }),
}));

const ownerRow: Permission = {
  user_id: 'auth0|abc',
  user_email: 'owner@example.test',
  permission_level: 'owner',
  granted_at: '2026-01-01',
  granted_by: 'auth0|abc',
};

const baseProps: ShareDialogProps = {
  open: true,
  onClose: vi.fn(),
  data: { sections: [], title: 'My ToC' } as never,
  currentEditToken: 'tok-abc' as string | null,
  containerSize: { width: 1024, height: 768 },
  onChartCreated: vi.fn(),
  permissions: [ownerRow],
  linkSharingLevel: 'restricted',
  permissionsLoading: false,
  permissionsFetchError: null,
  onPermissionsChanged: vi.fn(),
  onOptimisticLinkSharingLevel: vi.fn(),
};

beforeEach(() => {
  auth.isAuthenticated = true;
  vi.spyOn(ChartService, 'getChartByEditToken').mockResolvedValue({
    chartId: 'chart-xyz',
    chartData: { sections: [] } as never,
    canEdit: true,
    isOwner: true,
  });
  vi.spyOn(ChartService, 'updateLinkSharing').mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const mockOwnership = (isOwner: boolean) =>
  vi.spyOn(ChartService, 'getChartByEditToken').mockResolvedValue({
    chartId: 'chart-xyz',
    chartData: { sections: [] } as never,
    canEdit: true,
    isOwner,
  });

const renderDialog = (props: Partial<ShareDialogProps> = {}) =>
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

  it('shows the embed expander when mode is viewer or editor', async () => {
    renderDialog({ linkSharingLevel: 'viewer' });
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/embed code/i)).toBeInTheDocument();
    });
  });

  describe('embed code gate', () => {
    // App's level is 'restricted' for everyone who does not own the chart,
    // so the gate has to follow what the dialog tells the visitor instead.
    it('offers embed code to an anonymous visitor, whose links are open to anyone', async () => {
      auth.isAuthenticated = false;
      mockOwnership(false);
      renderDialog({ linkSharingLevel: 'restricted' });

      expect(await screen.findByText('Anyone with this link can view.')).toBeInTheDocument();
      expect(screen.getByText(/embed code/i)).toBeInTheDocument();
    });

    it('offers no embed code to a signed-in non-owner, whose level the client does not know', async () => {
      mockOwnership(false);
      renderDialog({ linkSharingLevel: 'restricted' });

      await waitFor(() => {
        expect(screen.getByText('View link')).toBeInTheDocument();
      });
      expect(screen.queryByText(/embed code/i)).toBeNull();
    });
  });

  describe('creating the chart on first share', () => {
    const created = {
      chartId: 'chart-new',
      editToken: 'tok-new',
      viewUrl: 'https://x.test/chart/chart-new',
      editUrl: 'https://x.test/edit/tok-new',
      version: 1,
    };

    it('hands the version, and exactly the chart that was sent, to the app', async () => {
      const onChartCreated = vi.fn();
      const createChart = vi.spyOn(ChartService, 'createChart').mockResolvedValue(created);
      vi.spyOn(ChartService, 'saveEditToken').mockImplementation(() => {});
      renderDialog({ currentEditToken: null, onChartCreated });

      await waitFor(() => expect(onChartCreated).toHaveBeenCalledTimes(1));
      expect(onChartCreated).toHaveBeenCalledWith({
        editToken: 'tok-new',
        chartId: 'chart-new',
        version: 1,
        chart: createChart.mock.calls[0][0],
      });
      expect(createChart.mock.calls[0][0]).toBe(baseProps.data);
    });

    it('follows the chart the document holds when another create attached first', async () => {
      // Chat and Share created a chart at once: the app keeps the first, so the
      // URL and the links shown must be that chart's, not the one just created.
      vi.spyOn(ChartService, 'createChart').mockResolvedValue(created);
      vi.spyOn(ChartService, 'saveEditToken').mockImplementation(() => {});
      const onChartCreated = vi
        .fn()
        .mockReturnValue({ editToken: 'tok-doc', chartId: 'chart-doc' });
      function Pathname() {
        return <output data-testid="pathname">{useLocation().pathname}</output>;
      }
      render(
        <MemoryRouter initialEntries={['/']}>
          <ShareDialog {...baseProps} currentEditToken={null} onChartCreated={onChartCreated} />
          <Pathname />
        </MemoryRouter>,
      );

      expect(
        await screen.findByDisplayValue(`${window.location.origin}/edit/tok-doc`),
      ).toBeInTheDocument();
      expect(
        screen.getByDisplayValue(`${window.location.origin}/chart/chart-doc`),
      ).toBeInTheDocument();
      expect(screen.queryByDisplayValue(/tok-new/)).toBeNull();
      await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/edit/tok-doc'));
    });

    it('shows the failure when the server answers without a chart version', async () => {
      const onChartCreated = vi.fn();
      vi.spyOn(ChartService, 'createChart').mockRejectedValue(
        new ChartApiError('The server did not return a chart version', 200),
      );
      renderDialog({ currentEditToken: null, onChartCreated });

      expect(await screen.findByText(/did not return a chart version/i)).toBeInTheDocument();
      expect(onChartCreated).not.toHaveBeenCalled();
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

  it('calls ChartService.updateLinkSharing and the optimistic channel when the owner picks a different mode', async () => {
    const onOptimisticLinkSharingLevel = vi.fn();
    const onPermissionsChanged = vi.fn();
    const user = userEvent.setup();
    renderDialog({
      linkSharingLevel: 'viewer',
      onOptimisticLinkSharingLevel,
      onPermissionsChanged,
    });
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });
    await user.click(screen.getByRole('radio', { name: /anyone can edit/i }));
    await waitFor(() => {
      expect(ChartService.updateLinkSharing).toHaveBeenCalledWith('chart-xyz', 'editor');
    });
    // Optimistic push happens before the API call resolves; the parent
    // gets the new level immediately, then a refetch after success.
    expect(onOptimisticLinkSharingLevel).toHaveBeenCalledWith('editor');
    await waitFor(() => {
      expect(onPermissionsChanged).toHaveBeenCalled();
    });
  });

  it('does not fetch permissions itself — the array comes from props', async () => {
    const getPermsSpy = vi.spyOn(ChartService, 'getChartPermissions');
    renderDialog({ linkSharingLevel: 'viewer' });
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });
    // Give any latent polling effects a chance to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(getPermsSpy).not.toHaveBeenCalled();
  });

  it('rolls back the optimistic update via the parent channel when updateLinkSharing rejects', async () => {
    const onOptimisticLinkSharingLevel = vi.fn();
    (ChartService.updateLinkSharing as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('network down'),
    );

    const user = userEvent.setup();
    renderDialog({
      linkSharingLevel: 'viewer',
      onOptimisticLinkSharingLevel,
    });
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });

    // Pre-click: viewer is selected (the prop drives the selector).
    expect(screen.getByRole('radio', { name: /anyone can view/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await user.click(screen.getByRole('radio', { name: /anyone can edit/i }));

    // Optimistic forward call: 'editor'.
    await waitFor(() => {
      expect(onOptimisticLinkSharingLevel).toHaveBeenCalledWith('editor');
    });
    // Rollback call: back to 'viewer'.
    await waitFor(() => {
      expect(onOptimisticLinkSharingLevel).toHaveBeenLastCalledWith('viewer');
    });
    // Error surfaces.
    await waitFor(() => {
      expect(screen.getByText(/network down/i)).toBeInTheDocument();
    });
  });

  it('does not call updateLinkSharing when the embed-break confirm is cancelled', async () => {
    const user = userEvent.setup();
    renderDialog({ linkSharingLevel: 'viewer' });
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('radio', { name: /^restricted$/i }));

    // PR 5: GeneralAccessSelector migrated from window.confirm to the
    // shared ConfirmModal primitive (red-team L4). The modal opens
    // with a testid; cancelling it aborts the level change.
    const modal = await screen.findByTestId('confirm-modal');
    expect(modal).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-modal-cancel'));

    // No write.
    expect(ChartService.updateLinkSharing).not.toHaveBeenCalled();
    // Selector still shows the previous mode.
    expect(screen.getByRole('radio', { name: /anyone can view/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('shows the divergence banner when the prop level changes under our feet, and persists it until acked', async () => {
    const Wrapper = ({ level }: { level: LinkSharingLevel }) => (
      <MemoryRouter>
        <ShareDialog {...baseProps} linkSharingLevel={level} />
      </MemoryRouter>
    );

    const { rerender } = render(<Wrapper level="restricted" />);
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });

    // Sibling-tab effect: prop flips to 'editor' while dialog is open.
    rerender(<Wrapper level="editor" />);

    const banner = await screen.findByText(/changed by another tab/i);
    expect(banner).toBeInTheDocument();

    // Wait through a couple of microtasks — banner must NOT auto-dismiss.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/changed by another tab/i)).toBeInTheDocument();

    // User acks via the Got it button.
    const user = userEvent.setup();
    const ackButton = screen.getByRole('button', { name: /got it/i });
    await user.click(ackButton);

    await waitFor(() => {
      expect(screen.queryByText(/changed by another tab/i)).toBeNull();
    });
  });

  it('shows the fetch-error warning when permissionsFetchError prop is set', async () => {
    renderDialog({ permissionsFetchError: 'hook fetch failed' });
    await waitFor(() => {
      expect(screen.getByText(/couldn't verify current sharing level/i)).toBeInTheDocument();
    });
  });

  it('uses one copy-button style for the view link, the edit link and the embed code', async () => {
    const user = userEvent.setup();
    renderDialog({ linkSharingLevel: 'viewer' });
    await waitFor(() => {
      expect(screen.getByText('View link')).toBeInTheDocument();
    });
    await user.click(await screen.findByRole('button', { name: /embed code/i }));

    const buttons = [
      screen.getByRole('button', { name: /^copy view link$/i }),
      screen.getByRole('button', { name: /^copy edit link$/i }),
      screen.getByRole('button', { name: /^copy embed code$/i }),
    ];
    expect(buttons).toHaveLength(3);
    const styles = new Set(buttons.map((b) => b.className));
    expect(styles.size).toBe(1);
    for (const b of buttons) expect(b).toHaveTextContent(/^Copy$/);
  });

  describe('link status lines', () => {
    const restrictedClaims =
      /Approved viewers only|Approval required to edit|Editors must be approved/;

    it('tells an anonymous visitor that anyone with the links can view and edit, whatever level App holds', async () => {
      auth.isAuthenticated = false;
      mockOwnership(false);
      // App's default for a non-owner is 'restricted'; it says nothing about this chart.
      renderDialog({ linkSharingLevel: 'restricted' });
      await waitFor(() => {
        expect(screen.getByText('View link')).toBeInTheDocument();
      });
      expect(screen.getByText('Anyone with this link can view.')).toBeInTheDocument();
      expect(screen.getByText('Anyone with this link can edit.')).toBeInTheDocument();
      expect(screen.queryByText(restrictedClaims)).toBeNull();
    });

    it('states nothing about access for a signed-in non-owner, whose level the client does not know', async () => {
      mockOwnership(false);
      renderDialog({ linkSharingLevel: 'restricted' });
      await waitFor(() => {
        expect(screen.getByText('View link')).toBeInTheDocument();
      });
      expect(screen.queryByText(restrictedClaims)).toBeNull();
      expect(screen.queryByText(/Anyone with this link/)).toBeNull();
    });

    it('reports the stored level to the owner', async () => {
      renderDialog({ linkSharingLevel: 'restricted' });
      await waitFor(() => {
        expect(screen.getByText('Approved viewers only.')).toBeInTheDocument();
      });
      expect(screen.getByText('Approval required to edit.')).toBeInTheDocument();
    });
  });
});
