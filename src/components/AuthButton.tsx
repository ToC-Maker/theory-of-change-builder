import { useAuth0 } from "@auth0/auth0-react"
import { useState, useRef, useEffect } from "react"
import { UserCircleIcon } from "@heroicons/react/24/outline"

const AuthButton = () => {
  const { user, isAuthenticated, isLoading, loginWithRedirect, logout } = useAuth0()
  const [showDropdown, setShowDropdown] = useState(false)
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
            <div className="p-2">
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
      </div>
    )
  }

  return (
    <button
      onClick={() => loginWithRedirect()}
      className="flex flex-col items-center gap-0.5 text-gray-600 hover:text-gray-900 transition-colors focus:outline-none"
      title="Sign in"
    >
      <UserCircleIcon className="w-7 h-7" />
      <span className="text-xs">Sign in</span>
    </button>
  )
}

export default AuthButton
