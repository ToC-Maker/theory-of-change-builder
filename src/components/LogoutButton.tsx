import { useAuth0 } from "@auth0/auth0-react"

const LogoutButton = () => {
  const { logout } = useAuth0()

  return (
    <button
      onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
      className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors"
    >
      Log Out
    </button>
  )
}

export default LogoutButton
