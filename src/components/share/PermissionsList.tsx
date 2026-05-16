// PermissionsList — inline list of pending + approved permissions for
// owners. Plan §user-direction sticky: "Permissions list always inline
// (no dropdown collapse)."
//
// Two visual buckets:
//   - Pending: shown first when there are pending rows, with Approve /
//     Reject affordances per row.
//   - People with access: owner + approved editors. Owner row is
//     non-editable; everyone else gets level/remove controls.
//
// Permission row shape mirrors the chartService.getChartPermissions
// response (the API existed in PR 1's shim; we keep the same shape so
// callers don't transform).
import { XMarkIcon } from '@heroicons/react/24/outline';

export interface PermissionRow {
  user_id: string;
  user_email: string;
  permission_level: 'owner' | 'edit';
  status?: 'pending' | 'approved' | 'rejected';
  granted_at: string;
}

export interface PermissionsListProps {
  permissions: PermissionRow[];
  isOwner: boolean;
  currentUserEmail?: string;
  onApprove: (userId: string) => void;
  onReject: (userId: string) => void;
  onRemove: (userId: string) => void;
  onUpdateLevel: (userId: string, level: 'owner' | 'edit') => void;
  /** Optional error message rendered above the list (e.g. last action failed). */
  errorMessage?: string | null;
  /** When true, render a spinner instead of the lists. */
  loading?: boolean;
}

function initials(email: string): string {
  return email ? email.substring(0, 2).toUpperCase() : '?';
}

export function PermissionsList({
  permissions,
  isOwner,
  currentUserEmail,
  onApprove,
  onReject,
  onRemove,
  onUpdateLevel,
  errorMessage,
  loading = false,
}: PermissionsListProps) {
  if (!isOwner) {
    // Non-owners shouldn't see the manage UI at all; return nothing so
    // callers can skip an outer wrapper.
    return null;
  }

  const pending = permissions.filter((p) => p.status === 'pending');
  const accepted = permissions.filter((p) => p.status === 'approved' || !p.status);
  const isEmpty = !loading && pending.length === 0 && accepted.length === 0;

  return (
    <div className="space-y-4">
      {errorMessage && (
        <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          {errorMessage}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-4">
          <div className="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-gray-600" />
        </div>
      ) : isEmpty ? (
        <p className="text-sm text-gray-500 py-2">No collaborators yet</p>
      ) : (
        <>
          {pending.length > 0 && (
            <div>
              <h3 className="block text-sm font-medium text-gray-900 mb-2">Pending requests</h3>
              <ul className="space-y-2">
                {pending.map((perm) => (
                  <li
                    key={perm.user_id}
                    className="flex items-center justify-between py-2 px-3 bg-yellow-50 border border-yellow-200 rounded-md"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-yellow-600 text-white flex items-center justify-center text-xs font-medium flex-shrink-0">
                        {initials(perm.user_email)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {perm.user_email}
                        </div>
                        <div className="text-xs text-yellow-700">Requesting access</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onApprove(perm.user_id)}
                        className="px-3 py-1 text-xs font-medium text-green-700 bg-green-100 rounded hover:bg-green-200 transition-colors"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => onReject(perm.user_id)}
                        className="px-3 py-1 text-xs font-medium text-red-700 bg-red-100 rounded hover:bg-red-200 transition-colors"
                      >
                        Reject
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {accepted.length > 0 && (
            <div>
              <h3 className="block text-sm font-medium text-gray-900 mb-2">People with access</h3>
              <ul className="divide-y divide-gray-100">
                {accepted.map((perm) => {
                  const isPermOwner = perm.permission_level === 'owner';
                  const isYou = currentUserEmail && currentUserEmail === perm.user_email;
                  return (
                    <li key={perm.user_id} className="flex items-center justify-between py-2">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-medium flex-shrink-0">
                          {initials(perm.user_email)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-gray-900 truncate">
                            {perm.user_email}
                            {isYou && <span className="text-gray-500 font-normal"> (you)</span>}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {isPermOwner ? (
                          <span className="text-sm text-gray-700 px-3 py-1">Owner</span>
                        ) : (
                          <>
                            <select
                              value={perm.permission_level}
                              aria-label={`Permission level for ${perm.user_email}`}
                              onChange={(e) =>
                                onUpdateLevel(perm.user_id, e.target.value as 'owner' | 'edit')
                              }
                              className="text-sm border-0 bg-transparent text-gray-700 focus:ring-0 pr-8 cursor-pointer"
                            >
                              <option value="edit">Editor</option>
                              <option value="owner">Owner</option>
                            </select>
                            <button
                              type="button"
                              onClick={() => onRemove(perm.user_id)}
                              aria-label={`Remove ${perm.user_email}`}
                              className="text-gray-400 hover:text-red-600 transition-colors"
                            >
                              <XMarkIcon className="w-5 h-5" />
                            </button>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
