import React, { useState, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { XMarkIcon, ShieldCheckIcon } from '@heroicons/react/24/outline';
import { loggingService } from '../services/loggingService';

interface PrivacyPolicyPopupProps {
  onAccept?: (loggingEnabled: boolean) => void;
}

export function PrivacyPolicyPopup({ onAccept }: PrivacyPolicyPopupProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [allowLogging, setAllowLogging] = useState(true); // Default to opted-in
  const location = useLocation();

  useEffect(() => {
    // Only show privacy policy on edit routes (not on view-only chart routes)
    const isChartRoute = location.pathname.includes('/chart/');
    const isViewRoute = location.pathname.includes('/view');

    // Don't show on view-only routes
    if (isChartRoute || isViewRoute) {
      return;
    }

    // Check if user has already accepted the privacy policy
    const hasAccepted = localStorage.getItem('privacyPolicyAccepted');
    if (!hasAccepted) {
      // Show popup after a short delay to ensure smooth page load
      setTimeout(() => {
        setIsVisible(true);
      }, 1000);
    }
  }, [location]);

  const handleAccept = () => {
    // Store acceptance in localStorage
    localStorage.setItem('privacyPolicyAccepted', 'true');
    localStorage.setItem('privacyPolicyAcceptedDate', new Date().toISOString());

    // Store usage logging preference (opt-out if unchecked)
    loggingService.setOptOut(!allowLogging);

    setIsVisible(false);

    // Notify parent to initialize logging if enabled
    onAccept?.(allowLogging);
  };

  const handleClose = () => {
    // For now, closing is the same as accepting
    // You could implement different behavior if needed
    handleAccept();
  };

  if (!isVisible) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black bg-opacity-50" />

      {/* Modal */}
      <div className="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6 animate-fadeIn">
        {/* Close button */}
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 transition-colors"
          aria-label="Close"
        >
          <XMarkIcon className="w-5 h-5" />
        </button>

        {/* Icon */}
        <div className="flex justify-center mb-4">
          <div className="p-3 bg-blue-100 rounded-full">
            <ShieldCheckIcon className="w-8 h-8 text-blue-600" />
          </div>
        </div>

        {/* Title */}
        <h2 className="text-xl font-semibold text-gray-900 text-center mb-4">
          Privacy & Data Protection
        </h2>

        {/* Content */}
        <p className="text-sm text-gray-600 text-center mb-5">
          We value your privacy and are committed to protecting your data.
          By using this application, you agree to our privacy practices.
        </p>

        {/* Actions */}
        <div className="space-y-3">
          <button
            onClick={handleAccept}
            className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-medium"
          >
            I Understand
          </button>

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={allowLogging}
                onChange={(e) => setAllowLogging(e.target.checked)}
                className="h-3.5 w-3.5 text-blue-600 rounded border-gray-300 focus:ring-blue-500 focus:ring-offset-0"
              />
              <span className="text-xs text-gray-400 group-hover:text-gray-500 transition-colors">
                Help improve AI
              </span>
            </label>

            <a
              href="https://docs.google.com/document/d/1rjFIogfs_xGAUmO68Ci1UJOTtpJ2jWvwllJRl7k_sN4/edit?usp=sharing"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-gray-400 hover:text-gray-500 transition-colors"
            >
              Privacy Policy
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

// Add fade-in animation styles
const style = document.createElement('style');
style.textContent = `
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: scale(0.95);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .animate-fadeIn {
    animation: fadeIn 0.2s ease-out;
  }
`;
document.head.appendChild(style);