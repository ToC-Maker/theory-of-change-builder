import { useAuth0 } from "@auth0/auth0-react"

const LoginButton = () => {
  const { loginWithRedirect } = useAuth0()

  return (
    <button
      onClick={() => loginWithRedirect()}
      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
    >
      Log In
    </button>
  )
}

export default LoginButton
