// GeneralAccessSelector — 3-mode access picker rendered as a radio
// group (always inline, no dropdown collapse).
//
// Labels and subtexts are user-direction-fixed; do not paraphrase:
//   - Restricted        — "Only approved people can view or edit."
//   - Anyone can view   — "Public view link. Editors must be approved."
//   - Anyone can edit   — "Public view and edit links. No approval needed."
//
// Embed-break guard (plan §170 Critical, §727 Task 2.2):
// When the user changes FROM a non-restricted mode TO 'restricted', we
// prompt for confirmation because the switch silently breaks any
// existing iframe embeds (which start returning 403 to anonymous
// viewers). All other transitions commit immediately.
//
// The prompt uses the shared `ConfirmModal` primitive (PR 5 red-team
// L4 closure). Same pattern as `FileMenu`'s delete-chart retrofit:
// state-driven open flag, onConfirm proceeds with the transition,
// onCancel reverts.
import { useState } from 'react';
import {
  ExclamationTriangleIcon,
  GlobeAltIcon,
  LockClosedIcon,
  PencilSquareIcon,
} from '@heroicons/react/24/outline';
import type { LinkSharingLevel } from '../../../shared/permissions';
import { ConfirmModal } from '../ConfirmModal';

export type { LinkSharingLevel } from '../../../shared/permissions';

interface ModeDescriptor {
  value: LinkSharingLevel;
  label: string;
  subtext: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const MODES: ReadonlyArray<ModeDescriptor> = [
  {
    value: 'restricted',
    label: 'Restricted',
    subtext: 'Only approved people can view or edit.',
    Icon: LockClosedIcon,
  },
  {
    value: 'viewer',
    label: 'Anyone can view',
    subtext: 'Public view link. Editors must be approved.',
    Icon: GlobeAltIcon,
  },
  {
    value: 'editor',
    label: 'Anyone can edit',
    subtext: 'Public view and edit links. No approval needed.',
    Icon: PencilSquareIcon,
  },
];

const RESTRICT_CONFIRM_MESSAGE =
  'Changing to Restricted will stop any existing embeds from loading. Continue?';

export interface GeneralAccessSelectorProps {
  value: LinkSharingLevel;
  onChange: (next: LinkSharingLevel) => void;
  disabled?: boolean;
}

export function GeneralAccessSelector({
  value,
  onChange,
  disabled = false,
}: GeneralAccessSelectorProps) {
  const [pendingRestrict, setPendingRestrict] = useState(false);

  const handleSelect = (next: LinkSharingLevel) => {
    if (next === value) return;
    // Embed-break confirmation gate only fires when *going* to restricted
    // from a non-restricted mode (the lossy direction).
    const movingToRestricted = next === 'restricted' && value !== 'restricted';
    if (movingToRestricted) {
      setPendingRestrict(true);
      return;
    }
    onChange(next);
  };

  const confirmRestrict = () => {
    setPendingRestrict(false);
    onChange('restricted');
  };

  const cancelRestrict = () => {
    setPendingRestrict(false);
  };

  return (
    <div role="radiogroup" aria-label="General access" className="space-y-2">
      {MODES.map((mode) => {
        const selected = mode.value === value;
        const Icon = mode.Icon;
        return (
          <button
            key={mode.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={mode.label}
            disabled={disabled}
            onClick={() => handleSelect(mode.value)}
            className={`w-full flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
              selected ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white hover:bg-gray-50'
            } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
          >
            <div
              className={`w-9 h-9 flex-shrink-0 rounded-full flex items-center justify-center ${
                selected ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
              }`}
              aria-hidden
            >
              <Icon className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-900 flex items-center gap-2">
                {mode.label}
                {mode.value === 'editor' && (
                  <ExclamationTriangleIcon
                    className="w-4 h-4 text-amber-500"
                    aria-label="Public edit warning"
                  />
                )}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">{mode.subtext}</div>
            </div>
            <div
              className={`w-4 h-4 flex-shrink-0 mt-1 rounded-full border-2 ${
                selected ? 'border-blue-600' : 'border-gray-300'
              }`}
              aria-hidden
            >
              {selected && <div className="w-2 h-2 bg-blue-600 rounded-full m-auto mt-0.5" />}
            </div>
          </button>
        );
      })}
      <ConfirmModal
        open={pendingRestrict}
        title="Change to Restricted?"
        body={RESTRICT_CONFIRM_MESSAGE}
        confirmLabel="Change to Restricted"
        confirmVariant="danger"
        onConfirm={confirmRestrict}
        onCancel={cancelRestrict}
      />
    </div>
  );
}
