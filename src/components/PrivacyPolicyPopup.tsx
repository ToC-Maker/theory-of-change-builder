// First-visit privacy-policy gate shown on the editor route. The modal
// mechanics (portal, focus, keyboard handling, layout) come from the
// shared `<ConfirmModal>` primitive; this wrapper owns the route gating,
// localStorage gating, and the logging-opt-in side effects.
//
// Single-action + non-dismissable: the modal has no cancel button, no
// backdrop-dismiss, and no Escape handler. The user must explicitly
// click "I Understand" to acknowledge before the editor unlocks.

import { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ShieldCheckIcon } from '@heroicons/react/24/outline';
import { ConfirmModal } from './ConfirmModal';
import { loggingService } from '../services/loggingService';

interface PrivacyPolicyPopupProps {
  onAccept?: (loggingEnabled: boolean) => void;
}

export function PrivacyPolicyPopup({ onAccept }: PrivacyPolicyPopupProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [shareData, setShareData] = useState(() => {
    // Respect any existing preference (e.g. synced from server on login)
    const stored = localStorage.getItem('usageLoggingOptOut');
    return stored === null ? true : stored !== 'true';
  });
  const location = useLocation();

  useEffect(() => {
    // Only show privacy policy on edit routes (not on view-only chart routes)
    const isChartRoute = location.pathname.includes('/chart/');
    const isViewRoute = location.pathname.includes('/view');

    // Don't show on view-only routes
    if (isChartRoute || isViewRoute) {
      return;
    }

    // Check if user has already accepted the privacy policy AND made a logging choice
    const hasAccepted = localStorage.getItem('privacyPolicyAccepted');
    const hasLoggingPreference = localStorage.getItem('usageLoggingOptOut') !== null;

    // Show popup if: never accepted, OR accepted but never chose logging preference
    if (!hasAccepted || !hasLoggingPreference) {
      // Show popup after a short delay to ensure smooth page load
      const id = setTimeout(() => {
        setIsVisible(true);
      }, 1000);
      return () => clearTimeout(id);
    }
  }, [location]);

  const handleAccept = () => {
    // Store acceptance in localStorage
    localStorage.setItem('privacyPolicyAccepted', 'true');
    localStorage.setItem('privacyPolicyAcceptedDate', new Date().toISOString());

    // Store usage logging preference
    loggingService.setOptOut(!shareData);

    setIsVisible(false);

    // Notify parent to initialize logging if enabled
    onAccept?.(shareData);
  };

  return (
    <ConfirmModal
      open={isVisible}
      title="Privacy & Data Protection"
      body="To improve the AI assistant, we collect usage data such as chat messages and graph edits. You can change this anytime under Account > Data & Privacy."
      confirmLabel="I Understand"
      confirmVariant="blue"
      singleAction
      icon={
        <div className="p-3 bg-blue-100 rounded-full">
          <ShieldCheckIcon className="w-8 h-8 text-blue-600" />
        </div>
      }
      extras={
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={shareData}
              onChange={(e) => setShareData(e.target.checked)}
              className="h-3.5 w-3.5 text-blue-600 rounded border-gray-300 focus:ring-blue-500 focus:ring-offset-0"
            />
            <span className="text-xs text-gray-500">Help improve AI by sharing usage data</span>
          </label>

          <a
            href="https://docs.google.com/document/d/1rjFIogfs_xGAUmO68Ci1UJOTtpJ2jWvwllJRl7k_sN4/edit?usp=sharing"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            View Privacy Policy →
          </a>
        </div>
      }
      onConfirm={handleAccept}
      onCancel={() => {
        // singleAction mode: cancel hooks are never invoked, but the
        // prop is required by the type. Treat as a no-op.
      }}
    />
  );
}
