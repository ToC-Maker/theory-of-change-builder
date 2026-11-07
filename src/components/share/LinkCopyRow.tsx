// LinkCopyRow — one shareable link in the Share dialog: a label with a
// line saying what the link is for, a read-only URL field with a copy
// button, and a status line saying who can open the link.
//
// The status line is about access only and is left out when the level is
// unknown (`null`), since a claim made without knowing it could be wrong.
// The edit link's "Anyone with this link can edit" warning appears only at
// level 'editor', the one level where the edit link needs no approval.
import { useEffect, useId, useRef, useState } from 'react';
import type { LinkSharingLevel } from '../../../shared/permissions';
import { CopyButton } from './CopyButton';

export type { LinkSharingLevel } from '../../../shared/permissions';

export interface LinkCopyRowProps {
  variant: 'view' | 'edit';
  url: string;
  /** The chart's link-sharing level, or null when the client doesn't know it (no status line is shown). */
  linkSharingLevel: LinkSharingLevel | null;
}

// Why the two links differ: the view link is for audiences, the edit link
// for co-builders. Kept beside the label so the status line below the
// field stays a statement about access only.
const PURPOSE: Record<'view' | 'edit', string> = {
  view: 'Share this to show or embed the chart.',
  edit: 'Share this with people helping you build it.',
};

function subtextFor(
  variant: 'view' | 'edit',
  level: LinkSharingLevel | null,
): { text: string; tone: 'neutral' | 'warning' } | null {
  if (level === null) return null;
  if (variant === 'view') {
    if (level === 'restricted') {
      return { text: 'Approved viewers only.', tone: 'neutral' };
    }
    return { text: 'Anyone with this link can view.', tone: 'neutral' };
  }

  // edit variant
  if (level === 'editor') {
    return { text: 'Anyone with this link can edit.', tone: 'warning' };
  }
  if (level === 'viewer') {
    return { text: 'Editors must be approved.', tone: 'neutral' };
  }
  return { text: 'Approval required to edit.', tone: 'neutral' };
}

export function LinkCopyRow({ variant, url, linkSharingLevel }: LinkCopyRowProps) {
  const [copied, setCopied] = useState(false);
  const inputId = useId();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const label = variant === 'view' ? 'View link' : 'Edit link';
  const subtext = subtextFor(variant, linkSharingLevel);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      // Clipboard failure is non-fatal; the user can fall back to
      // manual selection of the readonly input below.
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-2 mb-1">
        <label htmlFor={inputId} className="text-xs font-medium text-gray-700">
          {label}
        </label>
        <span className="text-xs text-gray-500">{PURPOSE[variant]}</span>
      </div>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          type="text"
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className={`flex-1 px-2 py-1 border border-gray-300 rounded text-xs ${
            variant === 'view' ? 'bg-gray-50' : 'bg-blue-50'
          }`}
        />
        <CopyButton onClick={handleCopy} copied={copied} label={`Copy ${label.toLowerCase()}`} />
      </div>
      {subtext && (
        <p
          className={`text-xs mt-1 ${
            subtext.tone === 'warning' ? 'text-amber-700' : 'text-gray-500'
          }`}
        >
          {subtext.text}
        </p>
      )}
    </div>
  );
}
