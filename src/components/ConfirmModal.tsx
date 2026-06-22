// `ConfirmModal` — reusable React confirm dialog.
//
// Replaces `window.confirm()` and bespoke modal implementations across
// the app: FileMenu "Delete chart", PR 5 column/section hover-× delete,
// GeneralAccessSelector "restricted" toggle, ChatInterface "Clear chat"
// and "Replace your Chat?" (Generate flow), PrivacyPolicyPopup
// (singleAction + extras slot).
//
// Closes the red-team L4 "confirm() blocks event loop" Important
// finding from plans/figma-redesign.md:200. `window.confirm()` halts
// the JS event loop synchronously, which is hostile to a11y (screen
// readers see no state change), pointer-capture invariants (in-flight
// gestures get stuck), and React updates (queued microtasks can't run
// until the user dismisses).
//
// Design:
//   - The modal is uncontrolled-by-default: parent passes `open`,
//     `onConfirm`, `onCancel`. No internal lifecycle bookkeeping
//     beyond keyboard handlers.
//   - Backdrop click and Escape cancel (unless `singleAction` is set,
//     in which case the modal is non-dismissable and the user must
//     click the confirm button to proceed).
//   - Enter (when not in a textarea) confirms.
//   - Focus is auto-moved to the confirm button on open so keyboard
//     users land in a sensible default.
//   - `confirmVariant` controls the confirm button color (danger /
//     primary / purple / blue); see the prop docstring.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmModalProps {
  open: boolean;
  title: string;
  /**
   * Body content. Can be a string (rendered as a paragraph) or any
   * ReactNode (for richer copy like "this column has N nodes" with
   * embedded counts).
   */
  body: React.ReactNode;
  /** Defaults to "Confirm". */
  confirmLabel?: string;
  /** Defaults to "Cancel". */
  cancelLabel?: string;
  /**
   * Confirm button color. Defaults to "danger" (red).
   * - "danger" — destructive ops (delete chart, clear chat, etc.)
   * - "primary" — non-destructive default action (indigo)
   * - "purple" — Generate-flow framing (replace Chat with a Generate run)
   * - "blue" — privacy/info framing (PrivacyPolicyPopup)
   */
  confirmVariant?: 'danger' | 'primary' | 'purple' | 'blue';
  /**
   * Optional icon rendered above the title. When provided, the layout
   * switches to a centered presentation (title + body centered, buttons
   * become equal-width). Without an icon, the layout stays left-aligned
   * with right-aligned actions (the original PR 5 layout). This dual
   * mode supports both delete-style confirms and the Generate-flow
   * confirmation (purple + DocumentPlusIcon).
   */
  icon?: React.ReactNode;
  /**
   * Optional supplemental content rendered between the body and the
   * action buttons. Used for the PrivacyPolicyPopup's "Help improve AI"
   * checkbox + policy link row. Kept as a generic slot so other callers
   * can drop in inline form controls or footnotes without forcing a new
   * prop per use-case.
   */
  extras?: React.ReactNode;
  /**
   * Single-action mode: hide the cancel button and treat the modal as
   * non-dismissable. Backdrop clicks and Escape become no-ops; the user
   * must click the confirm button to proceed. Used by PrivacyPolicyPopup
   * where the privacy acknowledgment is a hard gate. Enter still confirms.
   */
  singleAction?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'danger',
  icon,
  extras,
  singleAction = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  // Auto-focus the confirm button when the modal opens. We can't rely
  // on `autoFocus` because the element might not be mounted yet when
  // `open` flips from false to true within the same render.
  useEffect(() => {
    if (open) {
      // Schedule after paint so the focus doesn't race with the React
      // render that mounts the modal subtree.
      const id = requestAnimationFrame(() => {
        confirmBtnRef.current?.focus();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Keyboard handlers — only subscribed while the modal is open so we
  // don't intercept Enter/Escape on the host page.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (singleAction) return;
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        // Don't hijack Enter inside textareas / contentEditables. The
        // target can be `document` (no `tagName`) when the event is
        // dispatched at the document level rather than on a focused
        // element, so guard against the missing property.
        const target = e.target as HTMLElement | null;
        const tag = target && 'tagName' in target ? target.tagName?.toLowerCase() : null;
        if (tag === 'textarea' || target?.isContentEditable) return;
        e.preventDefault();
        onConfirm();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onCancel, onConfirm, singleAction]);

  if (!open) return null;

  const confirmClass =
    confirmVariant === 'danger'
      ? 'bg-red-600 hover:bg-red-700 focus:ring-red-400'
      : confirmVariant === 'purple'
        ? 'bg-purple-600 hover:bg-purple-700 focus:ring-purple-400'
        : confirmVariant === 'blue'
          ? 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-400'
          : 'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-400';

  // Icon presence drives a centered, slightly wider panel layout —
  // matches the original GenerateConfirmDialog's visual treatment. The
  // standard (no-icon) path preserves the original PR 5 layout so the
  // existing FileMenu / ColumnDeleteAffordance / GeneralAccessSelector
  // callsites don't visually shift.
  const hasIcon = icon !== undefined && icon !== null;
  const panelWidth = hasIcon ? 'max-w-md' : 'max-w-sm';
  const titleAlign = hasIcon ? 'text-center' : '';
  const bodyAlign = hasIcon ? 'text-center' : '';
  const actionsLayout = hasIcon ? 'flex gap-3' : 'flex justify-end gap-2';
  const buttonSizing = hasIcon ? 'flex-1 px-4 py-2.5' : 'px-3 py-1.5';

  // The modal is portaled into document.body so it sits above the
  // canvas's transform stack and isn't clipped by zoom/pan.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-modal-title"
      className="fixed inset-0 z-[100] flex items-center justify-center"
      data-testid="confirm-modal"
    >
      {/* Backdrop — inert in singleAction mode (non-dismissable). */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={singleAction ? undefined : onCancel}
        aria-hidden="true"
        data-testid="confirm-modal-backdrop"
      />
      {/* Panel */}
      <div className={`relative z-10 ${panelWidth} w-full mx-4 rounded-lg bg-white shadow-xl p-6`}>
        {hasIcon && <div className="flex justify-center mb-4">{icon}</div>}
        <h2
          id="confirm-modal-title"
          className={`text-lg font-semibold text-gray-900 mb-3 ${titleAlign}`}
        >
          {title}
        </h2>
        <div className={`text-sm text-gray-700 mb-5 ${bodyAlign}`}>
          {typeof body === 'string' ? <p>{body}</p> : body}
        </div>
        {extras && <div className="mb-5">{extras}</div>}
        <div className={actionsLayout}>
          {!singleAction && (
            <button
              type="button"
              onClick={onCancel}
              className={`${buttonSizing} text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300`}
              data-testid="confirm-modal-cancel"
            >
              {cancelLabel}
            </button>
          )}
          <button
            type="button"
            ref={confirmBtnRef}
            onClick={onConfirm}
            className={`${buttonSizing} text-sm font-medium text-white rounded focus:outline-none focus:ring-2 ${confirmClass}`}
            data-testid="confirm-modal-confirm"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
