// Modal confirmation before Generate destroys the current Chat history.
//
// startGeneration replaces `messages` with a single generation prompt
// (setMessages([generationMessage]) at the start of the Generate flow),
// which destructively wipes any in-progress chat. Without confirmation, a
// user with chat history who clicks Generate loses it silently. This modal
// makes the destruction explicit.
//
// Two-phase callback pattern (see startGeneration):
//   1. setShowGenerateConfirm(true) opens this modal.
//   2. User clicks Confirm → onConfirm fires → caller closes the modal +
//      calls startGenerationInternal() (the body of startGeneration after
//      the confirm gate).
//   3. User clicks Cancel → onCancel fires → caller closes the modal. No
//      state was mutated, so no cleanup needed.
//
// Modeled on PrivacyPolicyPopup (fixed inset, backdrop, animated fade-in).
import { useEffect } from 'react';
import { DocumentPlusIcon } from '@heroicons/react/24/outline';

interface GenerateConfirmDialogProps {
  open: boolean;
  /** Number of messages currently in Chat — shown to the user so they know
   *  what they're about to lose. Caller passes `messages.length`. */
  chatMessageCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function GenerateConfirmDialog({
  open,
  chatMessageCount,
  onConfirm,
  onCancel,
}: GenerateConfirmDialogProps) {
  // Inject fade-in animation style once. Matches PrivacyPolicyPopup.
  useEffect(() => {
    const styleId = 'generate-confirm-animation';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes generateConfirmFadeIn {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }
      .animate-generateConfirmFadeIn { animation: generateConfirmFadeIn 0.2s ease-out; }
    `;
    document.head.appendChild(style);
    return () => {
      document.getElementById(styleId)?.remove();
    };
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      {/* Backdrop — clicking it cancels (same as the Cancel button) so
          users have a familiar "click outside to dismiss" affordance. */}
      <div
        className="absolute inset-0 bg-black bg-opacity-50"
        onClick={onCancel}
        aria-label="Cancel"
      />

      {/* Modal */}
      <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6 animate-generateConfirmFadeIn">
        {/* Icon */}
        <div className="flex justify-center mb-4">
          <div className="p-3 bg-purple-100 rounded-full">
            <DocumentPlusIcon className="w-8 h-8 text-purple-600" />
          </div>
        </div>

        {/* Title */}
        <h2 className="text-xl font-semibold text-gray-900 text-center mb-3">Replace your Chat?</h2>

        {/* Body */}
        <p className="text-sm text-gray-600 text-center mb-5">
          Generating a new Theory of Change will replace your current Chat (
          {chatMessageCount === 1 ? '1 message' : `${chatMessageCount} messages`}) with a fresh
          generation conversation. Your existing chart isn&apos;t affected.
        </p>

        {/* Actions */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 px-4 py-2.5 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors text-sm font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 px-4 py-2.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-sm font-medium"
          >
            Generate
          </button>
        </div>
      </div>
    </div>
  );
}
