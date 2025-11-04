import { useAuth0 } from "@auth0/auth0-react"

const AuthButton = () => {
  const { user, isAuthenticated, isLoading, loginWithRedirect, logout } = useAuth0()

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-lg">
        <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
        <span className="text-sm text-gray-600">Loading...</span>
      </div>
    )
  }

  if (isAuthenticated && user) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          {user.picture && (
            <img
              src={user.picture}
              alt={user.name || 'User'}
              className="w-8 h-8 rounded-full object-cover border-2 border-blue-500"
            />
          )}
          <span className="text-sm font-medium text-gray-700">{user.name}</span>
        </div>
        <button
          onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
          className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
        >
          Log Out
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => loginWithRedirect()}
      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
    >
      Log In
    </button>
  )
}

export default AuthButton
