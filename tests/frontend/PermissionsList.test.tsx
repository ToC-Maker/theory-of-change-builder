// Tests for PermissionsList — inline (no dropdown collapse) listing of
// pending + approved permissions with approve/reject controls for the
// owner (plan §PR 2 + user-direction "Permissions list always inline").
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PermissionsList } from '../../src/components/share/PermissionsList';

const examplePermissions = [
  {
    user_id: 'u-owner',
    user_email: 'owner@example.test',
    permission_level: 'owner' as const,
    granted_at: '2026-01-01',
  },
  {
    user_id: 'u-pending',
    user_email: 'alice@example.test',
    permission_level: 'edit' as const,
    status: 'pending',
    granted_at: '2026-01-02',
  },
  {
    user_id: 'u-approved',
    user_email: 'bob@example.test',
    permission_level: 'edit' as const,
    status: 'approved',
    granted_at: '2026-01-03',
  },
];

afterEach(() => {
  cleanup();
});

describe('PermissionsList', () => {
  it('renders inline (no toggle collapse) when isOwner', () => {
    render(
      <PermissionsList
        permissions={examplePermissions}
        isOwner
        currentUserEmail="owner@example.test"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRemove={vi.fn()}
        onUpdateLevel={vi.fn()}
      />,
    );

    // Headings are visible without clicking anything.
    expect(screen.getByText(/pending requests/i)).toBeInTheDocument();
    expect(screen.getByText(/people with access/i)).toBeInTheDocument();
    // The collapse toggle is gone.
    expect(screen.queryByRole('button', { name: /manage permissions/i })).toBeNull();
  });

  it('lists pending requests with Approve and Reject buttons', () => {
    render(
      <PermissionsList
        permissions={examplePermissions}
        isOwner
        currentUserEmail="owner@example.test"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRemove={vi.fn()}
        onUpdateLevel={vi.fn()}
      />,
    );

    expect(screen.getByText('alice@example.test')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject/i })).toBeInTheDocument();
  });

  it('fires onApprove with the pending user id', async () => {
    const onApprove = vi.fn();
    const user = userEvent.setup();
    render(
      <PermissionsList
        permissions={examplePermissions}
        isOwner
        currentUserEmail="owner@example.test"
        onApprove={onApprove}
        onReject={vi.fn()}
        onRemove={vi.fn()}
        onUpdateLevel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /approve/i }));
    expect(onApprove).toHaveBeenCalledWith('u-pending');
  });

  it('fires onReject with the pending user id', async () => {
    const onReject = vi.fn();
    const user = userEvent.setup();
    render(
      <PermissionsList
        permissions={examplePermissions}
        isOwner
        currentUserEmail="owner@example.test"
        onApprove={vi.fn()}
        onReject={onReject}
        onRemove={vi.fn()}
        onUpdateLevel={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /reject/i }));
    expect(onReject).toHaveBeenCalledWith('u-pending');
  });

  it('marks the current user as "(you)"', () => {
    render(
      <PermissionsList
        permissions={examplePermissions}
        isOwner
        currentUserEmail="owner@example.test"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRemove={vi.fn()}
        onUpdateLevel={vi.fn()}
      />,
    );
    // The owner row has "(you)" suffix.
    expect(screen.getByText(/\(you\)/i)).toBeInTheDocument();
  });

  it('shows an empty-state when no collaborators', () => {
    render(
      <PermissionsList
        permissions={[]}
        isOwner
        currentUserEmail="owner@example.test"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onRemove={vi.fn()}
        onUpdateLevel={vi.fn()}
      />,
    );
    expect(screen.getByText(/no collaborators yet/i)).toBeInTheDocument();
  });
});
