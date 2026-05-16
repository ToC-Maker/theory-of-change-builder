// Tests for FileMenu — File dropdown in the new TopBar.
//
// Two main concerns:
//   1. The "Delete chart" item is owner-gated. For anonymous edits
//      (no auth, but possessing the edit token) it is still shown
//      because anyone with the edit token is the de-facto owner. For
//      authenticated callers it shows only when `isOwner=true`.
//   2. Static items are always present: New ToC, Open recent, Import,
//      Export, all in that order. Import/Export sub-actions are
//      placeholders in PR 1 (PR 6 wires the real implementations).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FileMenu } from '../../src/components/top-bar/FileMenu';
import { ChartService } from '../../src/services/chartService';

// Auth0 normally returns `{user: undefined}` outside a provider; the
// auth-path tests need a user.sub to hit the `getUserCharts` branch.
vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    user: { sub: 'auth0|test-user' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

const baseProps = {
  isAuthenticated: false,
  isOwner: false,
  currentEditToken: 'tok-abc' as string | null,
  currentChartId: 'chart-xyz' as string | null,
  onDeleteChart: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

const renderMenu = (props: Partial<typeof baseProps> = {}) =>
  render(
    <MemoryRouter>
      <FileMenu {...baseProps} {...props} />
    </MemoryRouter>,
  );

describe('FileMenu', () => {
  it('renders a File trigger button', () => {
    renderMenu();
    expect(screen.getByRole('button', { name: /file/i })).toBeInTheDocument();
  });

  it('opens the dropdown on click and lists the expected items', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: /file/i }));

    expect(screen.getByText(/new toc/i)).toBeInTheDocument();
    expect(screen.getByText(/open recent/i)).toBeInTheDocument();
    expect(screen.getByText(/^import$/i)).toBeInTheDocument();
    expect(screen.getByText(/^export$/i)).toBeInTheDocument();
  });

  it('hides Delete chart for anonymous viewers without an edit token', async () => {
    const user = userEvent.setup();
    renderMenu({ currentEditToken: null });
    await user.click(screen.getByRole('button', { name: /file/i }));
    expect(screen.queryByText(/delete chart/i)).toBeNull();
  });

  it('shows Delete chart for anonymous edits (edit token, not authenticated)', async () => {
    const user = userEvent.setup();
    renderMenu({ isAuthenticated: false, currentEditToken: 'tok-abc', isOwner: false });
    await user.click(screen.getByRole('button', { name: /file/i }));
    expect(screen.getByText(/delete chart/i)).toBeInTheDocument();
  });

  it('hides Delete chart for authenticated non-owners', async () => {
    const user = userEvent.setup();
    renderMenu({ isAuthenticated: true, isOwner: false, currentEditToken: 'tok-abc' });
    await user.click(screen.getByRole('button', { name: /file/i }));
    expect(screen.queryByText(/delete chart/i)).toBeNull();
  });

  it('shows Delete chart for authenticated owners', async () => {
    const user = userEvent.setup();
    renderMenu({ isAuthenticated: true, isOwner: true, currentEditToken: 'tok-abc' });
    await user.click(screen.getByRole('button', { name: /file/i }));
    expect(screen.getByText(/delete chart/i)).toBeInTheDocument();
  });

  it('calls onDeleteChart with the chart ID when Delete is confirmed via ConfirmModal', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderMenu({
      isAuthenticated: true,
      isOwner: true,
      currentEditToken: 'tok-abc',
      onDeleteChart: onDelete,
    });

    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/delete chart/i));

    // PR 5: confirm prompt is now a React modal, not window.confirm.
    const modal = await screen.findByTestId('confirm-modal');
    expect(modal).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    expect(onDelete).toHaveBeenCalledWith('chart-xyz');
  });

  it('does NOT call onDeleteChart when the user cancels the ConfirmModal', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderMenu({
      isAuthenticated: true,
      isOwner: true,
      currentEditToken: 'tok-abc',
      onDeleteChart: onDelete,
    });

    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/delete chart/i));

    const modal = await screen.findByTestId('confirm-modal');
    expect(modal).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-modal-cancel'));

    expect(onDelete).not.toHaveBeenCalled();
    // Modal closes after cancel.
    expect(screen.queryByTestId('confirm-modal')).toBeNull();
  });

  it('shows a distinct error row when the anon Open recent localStorage read throws', async () => {
    const user = userEvent.setup();
    // Force localStorage.getItem to throw — same shape as Brave Shields
    // / Safari ITP / corrupt-blob failures.
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: localStorage disabled');
    });
    // Silence the console.error so the test output stays clean.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderMenu({ isAuthenticated: false, currentEditToken: 'tok-abc' });
    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/open recent/i));

    // The error row must be visible and distinct from the empty-state
    // copy ("No local charts found.") — otherwise the user sees a
    // misleading "empty" state and concludes data was lost.
    await waitFor(() => {
      expect(screen.getByText(/couldn.t load recent charts/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/no local charts found/i)).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

    getItemSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('shows a distinct error row when getUserCharts throws (auth path)', async () => {
    const user = userEvent.setup();
    const getUserChartsSpy = vi
      .spyOn(ChartService, 'getUserCharts')
      .mockRejectedValueOnce(new Error('HTTP 503: upstream timeout'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderMenu({ isAuthenticated: true, isOwner: false, currentEditToken: 'tok-abc' });
    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/open recent/i));

    await waitFor(() => {
      expect(screen.getByText(/couldn.t load recent charts/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/no saved charts yet/i)).toBeNull();

    getUserChartsSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
