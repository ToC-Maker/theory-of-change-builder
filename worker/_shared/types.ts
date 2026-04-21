export interface Env {
  ASSETS: Fetcher;
  DATABASE_URL: string;
  ANTHROPIC_API_KEY: string;
  IP_HASH_SALT: string;
  VITE_AUTH0_DOMAIN: string;
  VITE_AUTH0_CLIENT_ID: string;
  SITE_URL?: string;
  BYOK_ENCRYPTION_KEY?: string;
  // Turnstile secret for anonymous bot verification in anthropic-stream.
  // When unset, the anon bot check is skipped (useful for local dev).
  TURNSTILE_SECRET_KEY?: string;
}
