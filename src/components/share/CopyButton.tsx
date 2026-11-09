// CopyButton — the one copy affordance shared by every row of the Share
// dialog (view link, edit link, embed code): icon plus a "Copy" label that
// flips to "Copied" while the parent's copied flag is set.
import { ClipboardDocumentIcon, CheckIcon } from '@heroicons/react/24/outline';

export interface CopyButtonProps {
  onClick: () => void;
  /** True for the moment after a successful copy; shows "Copied". */
  copied: boolean;
  /** Accessible name while idle, for rows whose target isn't obvious from "Copy". */
  label?: string;
}

export function CopyButton({ onClick, copied, label = 'Copy' }: CopyButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={copied ? 'Copied' : label}
      className="px-2 py-1 text-xs font-medium rounded transition-colors inline-flex items-center gap-1 flex-shrink-0 bg-gray-100 text-gray-700 hover:bg-gray-200"
    >
      {copied ? (
        <>
          <CheckIcon className="w-3 h-3" />
          Copied
        </>
      ) : (
        <>
          <ClipboardDocumentIcon className="w-3 h-3" />
          Copy
        </>
      )}
    </button>
  );
}
