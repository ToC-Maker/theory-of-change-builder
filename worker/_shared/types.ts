export interface Env {
  ASSETS: Fetcher;
  DATABASE_URL: string;
  ANTHROPIC_API_KEY: string;
  IP_HASH_SALT: string;
  VITE_AUTH0_DOMAIN: string;
  VITE_AUTH0_CLIENT_ID: string;
  SITE_URL?: string;
}
