import type { NeonQueryFunction } from '@neondatabase/serverless';

/**
 * Check if a user has opted out of logging server-side.
 * Returns true if the user exists in logging_preferences with opted_out = true.
 * Returns false for anonymous users (no user_id) -- anonymous opt-out is enforced
 * client-side only, since there is no server-side identity to store a preference against.
 * On database errors, fails safe by treating the user as opted out.
 */
export async function isUserOptedOut(
  sql: NeonQueryFunction<false, false>,
  user_id: string | null,
): Promise<boolean> {
  if (!user_id) return false;

  try {
    const result = await sql`
      SELECT opted_out FROM logging_preferences WHERE user_id = ${user_id}
    `;
    return result[0]?.opted_out === true;
  } catch (error) {
    console.error('[isUserOptedOut] Failed to check opt-out status:', error);
    return true; // Fail safe: treat as opted out when we can't verify
  }
}
