// PR 5 Task 5.3: hover-`×` delete affordance for columns and sections.
//
// Replaces the layoutMode red-state "click to delete" path from
// before PR 5. The × button:
//   - Sits in the top-right corner of the column / section.
//   - Is hidden by default, revealed when the surrounding column /
//     section is hovered (CSS `:group-hover` — no JS hover tracking).
//   - Click opens a `ConfirmModal` describing what will be deleted,
//     including the affected node count for non-empty targets.
//   - Confirm → fires `onDelete()`. Cancel → modal closes, no-op.
//
// `window.confirm()` is intentionally not used (red-team L4) — the
// React modal keeps the event loop responsive, gives screen-reader
// announcements, and is keyboard-navigable.

import { useState } from 'react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { ConfirmModal } from '../ConfirmModal';

export interface ColumnDeleteAffordanceProps {
  /** Number of nodes the column / section currently contains. */
  nodeCount: number;
  /** Label noun used in the modal copy. `"column"` or `"section"`. */
  scope: 'column' | 'section';
  /**
   * Called when the user confirms the deletion. Implementations should
   * write through `useGraphMutation.mutate` so the delete is a single
   * undo entry.
   */
  onDelete: () => void;
  /**
   * Optional data-testid suffix to disambiguate multiple affordances
   * in tests (e.g. `column-0-1`, `section-2`).
   */
  testIdSuffix?: string;
}

export function ColumnDeleteAffordance({
  nodeCount,
  scope,
  onDelete,
  testIdSuffix,
}: ColumnDeleteAffordanceProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const body =
    nodeCount === 0
      ? `Delete this empty ${scope}? You can undo this with Ctrl+Z.`
      : `This ${scope} contains ${nodeCount} node${nodeCount === 1 ? '' : 's'}. Deleting it will remove ${nodeCount === 1 ? 'that node' : 'all of them'}. You can undo with Ctrl+Z.`;

  const testIdBase = testIdSuffix ? `${scope}-delete-${testIdSuffix}` : `${scope}-delete`;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmOpen(true);
  };

  return (
    <>
      <button
        type="button"
        // The × button is hidden by default and revealed via the
        // surrounding column/section's `group` class. Parent must
        // carry `group` for this to work.
        className="opacity-0 group-hover:opacity-100 transition-opacity absolute top-1 right-1 z-30 flex items-center justify-center w-6 h-6 rounded-full bg-white border border-gray-300 text-gray-500 hover:text-red-600 hover:border-red-300 hover:bg-red-50 shadow-sm"
        aria-label={`Delete ${scope}`}
        title={`Delete ${scope}`}
        onClick={handleClick}
        data-testid={testIdBase}
      >
        <XMarkIcon className="w-4 h-4" />
      </button>
      <ConfirmModal
        open={confirmOpen}
        title={`Delete ${scope}?`}
        body={body}
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => {
          onDelete();
          setConfirmOpen(false);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
