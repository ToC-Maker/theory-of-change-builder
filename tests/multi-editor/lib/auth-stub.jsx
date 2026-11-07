// Stands in for @auth0/auth0-react: always anonymous, so a chart is gated by its edit token alone.
export const Auth0Provider = ({ children }) => children;
const api = {
  isAuthenticated: false,
  isLoading: false,
  user: undefined,
  error: undefined,
  getAccessTokenSilently: async () => {
    throw new Error('stub: no token');
  },
  getIdTokenClaims: async () => undefined,
  loginWithRedirect: async () => {},
  logout: async () => {},
};
export const useAuth0 = () => api;
export const withAuthenticationRequired = (C) => C;
