// Must be first: attaches Prism to window before @lexical/code language
// plugins (bundled inside MDXEditor's chunk) execute. See prism-setup.ts.
import './prism-setup';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { Auth0Provider } from '@auth0/auth0-react';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const domain = import.meta.env.VITE_AUTH0_DOMAIN;
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID;

// Validate Auth0 configuration
if (!domain || !clientId) {
  console.error('Auth0 configuration missing. Please check your .env file.');
  console.error('Required environment variables:');
  console.error('- VITE_AUTH0_DOMAIN');
  console.error('- VITE_AUTH0_CLIENT_ID');
  throw new Error('Auth0 domain and client ID must be set in .env file');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <Auth0Provider
        domain={domain}
        clientId={clientId}
        authorizationParams={{
          redirect_uri: window.location.origin,
          scope: 'openid profile email offline_access',
        }}
        cacheLocation="localstorage"
        useRefreshTokens={true}
        // Round-4 (PR #34): when the refresh-token grant dies (Auth0 403
        // "Unknown or invalid refresh token" — rotation reuse-detection
        // revoking the family, or absolute-lifetime expiry), the SDK's
        // default (fallback off, the v2 default — the original config
        // simply inherited it) gives up and the app silently demotes to
        // anonymous. With the fallback on, the SDK retries via the hidden
        // iframe `prompt=none` flow against the Auth0 session cookie and
        // can mint a fresh grant with NO user interaction. Tradeoffs:
        //   - needs third-party cookies (cross-site iframe to the auth0
        //     domain): blocked on Safari/Firefox/Brave/incognito, where
        //     the fallback fails `login_required` and the
        //     SessionExpiredBanner catches it — i.e. worst case equals
        //     the old behavior plus a visible recovery path;
        //   - LIVE CHECK before relying on it: the app origins
        //     (production domain + workers.dev previews) must be listed
        //     in the Auth0 application's "Allowed Web Origins", or the
        //     iframe flow always fails (again: banner catches it);
        //   - no new token exposure: same tokens, same JS context, the
        //     localstorage refresh token remains the larger standing
        //     surface either way.
        useRefreshTokensFallback={true}
      >
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </Auth0Provider>
    </ErrorBoundary>
  </StrictMode>,
);
