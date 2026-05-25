import { describe, expect, it } from 'vitest';
import {
  tierFor,
  isCapped,
  allowByok,
  needTurnstile,
  LIFETIME_CAP_MICRO_USD,
  LIFETIME_CAP_USD,
} from '../../worker/_shared/tiers';

describe('tierFor', () => {
  it('classifies anon', () => {
    expect(tierFor('anon-abc123', false)).toBe('anon');
  });
  it('classifies authenticated', () => {
    expect(tierFor('auth0|sub123', false)).toBe('free');
  });
  it('classifies byok when header present', () => {
    expect(tierFor('auth0|sub123', true)).toBe('byok');
  });
  it('byok wins even for anon (edge case)', () => {
    expect(tierFor('anon-abc', true)).toBe('byok');
  });
});

describe('tier predicates', () => {
  it('isCapped: anon + free yes; byok no', () => {
    expect(isCapped('anon')).toBe(true);
    expect(isCapped('free')).toBe(true);
    expect(isCapped('byok')).toBe(false);
  });
  it('allowByok: free/byok yes; anon no', () => {
    expect(allowByok('anon')).toBe(false);
    expect(allowByok('free')).toBe(true);
    expect(allowByok('byok')).toBe(true);
  });
  it('needTurnstile: only anon', () => {
    expect(needTurnstile('anon')).toBe(true);
    expect(needTurnstile('free')).toBe(false);
    expect(needTurnstile('byok')).toBe(false);
  });
});

describe('lifetime cap constants', () => {
  it('USD and microUSD agree', () => {
    expect(LIFETIME_CAP_MICRO_USD).toBe(BigInt(LIFETIME_CAP_USD) * 1_000_000n);
  });
});
