import { neon } from '@neondatabase/serverless';
import type { Env } from './types';

export function getDb(env: Env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL not configured');
  }
  return neon(env.DATABASE_URL);
}
