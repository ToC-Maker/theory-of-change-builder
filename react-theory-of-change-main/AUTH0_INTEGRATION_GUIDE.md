# Auth0 Integration Guide

## Setup Complete!

Auth0 has been successfully integrated into your Theory of Change Builder application.

### What Was Configured

1. **Auth0 SDK Installed**: `@auth0/auth0-react` package added
2. **Environment Variables**: `.env` file created with your Auth0 credentials
3. **Auth0Provider**: Wraps your entire app in `src/main.tsx`
4. **Auth Components**: Ready-to-use components created in `src/components/`

### Auth0 Configuration

- **Domain**: `dev-zy7obc7gqpztqadk.auth0.com`
- **Client ID**: `eGHWLKnz44EPGWfmCdcVvYY5SBSMX01B`
- **Application**: Theory of Change Builder

### Important: Auth0 Dashboard Configuration

You need to configure these URLs in your Auth0 dashboard:

1. Go to: https://manage.auth0.com/dashboard/
2. Navigate to: Applications → Theory of Change Builder → Settings
3. Add these URLs:

   **Allowed Callback URLs:**
   ```
   http://localhost:5173,
   http://localhost:8888,
   https://your-netlify-domain.netlify.app
   ```

   **Allowed Logout URLs:**
   ```
   http://localhost:5173,
   http://localhost:8888,
   https://your-netlify-domain.netlify.app
   ```

   **Allowed Web Origins:**
   ```
   http://localhost:5173,
   http://localhost:8888,
   https://your-netlify-domain.netlify.app
   ```

4. Click "Save Changes"

### Available Components

#### 1. **AuthButton** (Recommended)
All-in-one component that shows login/logout and user profile:

```tsx
import AuthButton from './components/AuthButton'

function MyComponent() {
  return <AuthButton />
}
```

#### 2. **LoginButton**
Simple login button:

```tsx
import LoginButton from './components/LoginButton'

function MyComponent() {
  return <LoginButton />
}
```

#### 3. **LogoutButton**
Simple logout button:

```tsx
import LogoutButton from './components/LogoutButton'

function MyComponent() {
  return <LogoutButton />
}
```

#### 4. **Profile**
Display user profile information:

```tsx
import Profile from './components/Profile'

function MyComponent() {
  return <Profile />
}
```

### Using Auth0 Hooks

You can access authentication state anywhere in your app:

```tsx
import { useAuth0 } from '@auth0/auth0-react'

function MyComponent() {
  const {
    user,              // User profile object
    isAuthenticated,   // Boolean: true if logged in
    isLoading,         // Boolean: true while checking auth state
    loginWithRedirect, // Function to trigger login
    logout,            // Function to trigger logout
    getAccessTokenSilently // Function to get access token for API calls
  } = useAuth0()

  if (isLoading) {
    return <div>Loading...</div>
  }

  return (
    <div>
      {isAuthenticated ? (
        <div>
          <p>Welcome, {user?.name}!</p>
          <p>Email: {user?.email}</p>
        </div>
      ) : (
        <p>Please log in</p>
      )}
    </div>
  )
}
```

### Integration Ideas for Your App

Here are some ways you can use Auth0 in your Theory of Change Builder:

#### 1. **Protected Routes**
Only allow authenticated users to edit graphs:

```tsx
import { useAuth0 } from '@auth0/auth0-react'

function ToCViewer() {
  const { isAuthenticated, loginWithRedirect } = useAuth0()

  if (!isAuthenticated) {
    return (
      <div className="h-screen flex items-center justify-center">
        <button onClick={() => loginWithRedirect()}>
          Log in to edit graphs
        </button>
      </div>
    )
  }

  // Regular component rendering...
}
```

#### 2. **User-Specific Graphs**
Link saved graphs to authenticated users:

```tsx
const { user } = useAuth0()
const storageKey = `toc_graph_${user?.sub}_${filename}`
```

#### 3. **Add Auth to Navigation**
Add the AuthButton to your existing UI (e.g., in the ChatInterface or top toolbar):

```tsx
import AuthButton from './components/AuthButton'

function ChatInterface() {
  return (
    <div>
      {/* Your existing chat interface */}
      <div className="auth-section">
        <AuthButton />
      </div>
    </div>
  )
}
```

#### 4. **Sync Graphs with User Account**
When creating/updating charts, include the user ID:

```tsx
const { user } = useAuth0()

const createChart = async (chartData) => {
  const response = await ChartService.createChart({
    ...chartData,
    userId: user?.sub, // Auth0 user ID
    userEmail: user?.email
  })
  return response
}
```

### Netlify Deployment

Your `.env` file is already in `.gitignore`, so it won't be committed to git.

For Netlify deployment, the Auth0 extension you enabled should automatically set the environment variables. If not, manually add them in Netlify:

1. Go to: Site Settings → Environment Variables
2. Add:
   - `VITE_AUTH0_DOMAIN` = `dev-zy7obc7gqpztqadk.auth0.com`
   - `VITE_AUTH0_CLIENT_ID` = `eGHWLKnz44EPGWfmCdcVvYY5SBSMX01B`

### Testing

1. Open http://localhost:5173/ in your browser
2. The app should load normally
3. Use the Auth0 components to test login/logout functionality
4. Check browser console for any Auth0 errors

### Troubleshooting

**Issue: "Login required" or redirect errors**
- Solution: Check Auth0 dashboard URLs are configured correctly

**Issue: "Invalid state" errors**
- Solution: Clear browser cookies and try again

**Issue: Environment variables not loading**
- Solution: Restart the dev server (`npm run dev`)

### Next Steps

1. Configure Auth0 dashboard URLs (see above)
2. Add AuthButton to your UI
3. Test login/logout flow
4. Optionally protect routes or features with authentication
5. Link user accounts to saved graphs

### Resources

- Auth0 React SDK Docs: https://auth0.com/docs/quickstart/spa/react
- Auth0 Dashboard: https://manage.auth0.com/dashboard/
- useAuth0 Hook API: https://auth0.github.io/auth0-react/interfaces/Auth0ContextInterface.html
