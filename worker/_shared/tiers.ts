// STUB: Will be superseded by Unit 2 (U2) on merge.
// Matches the interface documented in plans/cost-controls.md §Integration contracts.

export const LIFETIME_CAP_USD = 5;
export const LIFETIME_CAP_MICRO_USD = 5_000_000n;
export const GLOBAL_MONTHLY_CAP_USD = 100;
export const BODY_SIZE_LIMIT_BYTES = 262_144;

export type Tier = 'anon' | 'free' | 'byok';

export function tierFor(actorId: string, hasByokHeader: boolean): Tier {
  if (hasByokHeader) return 'byok';
  if (actorId.startsWith('anon-')) return 'anon';
  return 'free';
}
