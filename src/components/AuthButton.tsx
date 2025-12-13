import { useAuth0 } from "@auth0/auth0-react"
import { useState, useRef, useEffect } from "react"
import { UserCircleIcon, ShieldCheckIcon, XMarkIcon } from "@heroicons/react/24/outline"
import { loggingService } from "../services/loggingService"

// Privacy Settings Modal
function PrivacyModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean
  onClose: () => void
}) {
  // Read current state fresh each time modal opens
  const [loggingEnabled, setLoggingEnabled] = useState(false)
  const [hasAcceptedPrivacy, setHasAcceptedPrivacy] = useState(false)

  // Sync state when modal opens
  useEffect(() => {
    if (isOpen) {
      setHasAcceptedPrivacy(localStorage.getItem('privacyPolicyAccepted') === 'true')
      // Check actual opt-out value, not isOptedOut() which also checks privacy acceptance
      const isOptedOut = localStorage.getItem('usageLoggingOptOut') === 'true'
      setLoggingEnabled(!isOptedOut)
    }
  }, [isOpen])

  if (!isOpen) return null

  const handleToggle = () => {
    const newValue = !loggingEnabled
    setLoggingEnabled(newValue)
    loggingService.setOptOut(!newValue)
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black bg-opacity-50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-white rounded-lg shadow-xl max-w-sm w-full p-5">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-gray-400 hover:text-gray-600 transition-colors"
          aria-label="Close"
        >
          <XMarkIcon className="w-5 h-5" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-blue-100 rounded-full">
            <ShieldCheckIcon className="w-5 h-5 text-blue-600" />
          </div>
          <h3 className="text-lg font-semibold text-gray-900">Data & Privacy</h3>
        </div>

        {/* Content */}
        {hasAcceptedPrivacy ? (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              We collect chat messages, graph edits, and basic session data to improve AI features.
            </p>

            <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <span className="text-sm font-medium text-gray-700">Share usage data</span>
              <button
                onClick={handleToggle}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  loggingEnabled ? 'bg-blue-600' : 'bg-gray-300'
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    loggingEnabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-600">
            Please accept the privacy policy first to manage your data preferences.
          </p>
        )}

        {/* Footer */}
        <div className="mt-4 pt-3 border-t border-gray-100">
          <a
            href="https://docs.google.com/document/d/1rjFIogfs_xGAUmO68Ci1UJOTtpJ2jWvwllJRl7k_sN4/edit?usp=sharing"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-600 hover:text-blue-700"
          >
            View Privacy Policy →
          </a>
        </div>
      </div>
    </div>
  )
}

const AuthButton = () => {
  const { user, isAuthenticated, isLoading, loginWithRedirect, logout } = useAuth0()
  const [showDropdown, setShowDropdown] = useState(false)
  const [showPrivacyModal, setShowPrivacyModal] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false)
      }
    }

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showDropdown])

  if (isLoading) {
    return (
      <div className="w-9 h-9 rounded-full bg-gray-200 animate-pulse" />
    )
  }

  if (isAuthenticated && user) {
    return (
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className="w-9 h-9 rounded-full overflow-hidden hover:ring-2 hover:ring-gray-300 transition-all focus:outline-none focus:ring-2 focus:ring-blue-500"
          title={user.name || 'Account'}
        >
          {user.picture ? (
            <img
              src={user.picture}
              alt={user.name || 'User'}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full bg-blue-600 flex items-center justify-center text-white font-medium">
              {user.name?.charAt(0).toUpperCase() || 'U'}
            </div>
          )}
        </button>

        {showDropdown && (
          <div className="absolute top-full right-0 mt-2 w-72 bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden z-50">
            {/* User info header */}
            <div className="p-4 bg-gray-50 border-b border-gray-200">
              <div className="flex items-center gap-3">
                {user.picture ? (
                  <img
                    src={user.picture}
                    alt={user.name || 'User'}
                    className="w-12 h-12 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center text-white text-lg font-medium">
                    {user.name?.charAt(0).toUpperCase() || 'U'}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-gray-900 truncate">{user.name}</div>
                  <div className="text-sm text-gray-500 truncate">{user.email}</div>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="p-2 space-y-1">
              <button
                onClick={() => {
                  setShowDropdown(false)
                  setShowPrivacyModal(true)
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
              >
                <ShieldCheckIcon className="w-4 h-4" />
                Data & Privacy
              </button>
              <button
                onClick={() => {
                  setShowDropdown(false)
                  logout({ logoutParams: { returnTo: window.location.origin } })
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Sign out
              </button>
            </div>
          </div>
        )}

        {/* Privacy Modal */}
        <PrivacyModal
          isOpen={showPrivacyModal}
          onClose={() => setShowPrivacyModal(false)}
        />
      </div>
    )
  }

  // Anonymous user - show dropdown with sign in and privacy settings
  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className="flex flex-col items-center gap-0.5 text-gray-600 hover:text-gray-900 transition-colors focus:outline-none"
        title="Account"
      >
        <UserCircleIcon className="w-7 h-7" />
        <span className="text-xs">Account</span>
      </button>

      {showDropdown && (
        <div className="absolute top-full right-0 mt-2 w-56 bg-white rounded-lg shadow-lg border border-gray-200 overflow-hidden z-50">
          <div className="p-2 space-y-1">
            <button
              onClick={() => {
                setShowDropdown(false)
                loginWithRedirect()
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" />
              </svg>
              Sign in
            </button>
            <button
              onClick={() => {
                setShowDropdown(false)
                setShowPrivacyModal(true)
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
            >
              <ShieldCheckIcon className="w-4 h-4" />
              Data & Privacy
            </button>
          </div>
        </div>
      )}

      {/* Privacy Modal */}
      <PrivacyModal
        isOpen={showPrivacyModal}
        onClose={() => setShowPrivacyModal(false)}
      />
    </div>
  )
}

export default AuthButton
