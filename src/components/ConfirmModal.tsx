// `ConfirmModal` — reusable React confirm dialog.
//
// Replaces `window.confirm()` in two callsites:
//
//   - FileMenu "Delete chart" (PR 1; previously used `window.confirm`).
//   - PR 5 Task 5.3 column/section hover-× delete affordance.
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
//   - Backdrop click and Escape cancel.
//   - Enter (when not in a textarea) confirms.
//   - Focus is auto-moved to the confirm button on open so keyboard
//     users land in a sensible default.
//   - `confirmVariant` controls the confirm button color: `danger`
//     (red, for destructive ops) vs `primary` (indigo, for non-
//     destructive). Defaults to `danger` since both current
//     callsites are destructive.

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
  /** Defaults to "danger" (red button). */
  confirmVariant?: 'danger' | 'primary';
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
  }, [open, onCancel, onConfirm]);

  if (!open) return null;

  const confirmClass =
    confirmVariant === 'danger'
      ? 'bg-red-600 hover:bg-red-700 focus:ring-red-400'
      : 'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-400';

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
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={onCancel}
        aria-hidden="true"
        data-testid="confirm-modal-backdrop"
      />
      {/* Panel */}
      <div className="relative z-10 max-w-sm w-full mx-4 rounded-lg bg-white shadow-xl p-6">
        <h2 id="confirm-modal-title" className="text-lg font-semibold text-gray-900 mb-3">
          {title}
        </h2>
        <div className="text-sm text-gray-700 mb-5">
          {typeof body === 'string' ? <p>{body}</p> : body}
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-gray-300"
            data-testid="confirm-modal-cancel"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmBtnRef}
            onClick={onConfirm}
            className={`px-3 py-1.5 text-sm font-medium text-white rounded focus:outline-none focus:ring-2 ${confirmClass}`}
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
