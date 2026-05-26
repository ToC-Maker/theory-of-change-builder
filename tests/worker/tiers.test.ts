import { describe, expect, it } from 'vitest';
import {
  tierFor,
  isCapped,
  allowByok,
  needTurnstile,
  LIFETIME_CAP_MICRO_USD,
  LIFETIME_CAP_USD,
  EFFECTIVE_LIFETIME_CAP_MICRO_USD,
  EFFECTIVE_LIFETIME_CAP_USD,
  CAP_OVERSPEND_TOLERANCE_FRACTION,
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

  it('effective cap (µUSD) = displayed cap * (1 + tolerance)', () => {
    const expected = BigInt(
      Math.round(Number(LIFETIME_CAP_MICRO_USD) * (1 + CAP_OVERSPEND_TOLERANCE_FRACTION)),
    );
    expect(EFFECTIVE_LIFETIME_CAP_MICRO_USD).toBe(expected);
  });

  it('effective cap (USD) = displayed cap * (1 + tolerance)', () => {
    expect(EFFECTIVE_LIFETIME_CAP_USD).toBe(
      LIFETIME_CAP_USD * (1 + CAP_OVERSPEND_TOLERANCE_FRACTION),
    );
  });

  it('USD and µUSD effective caps agree at the boundary (client/server float/BigInt symmetry)', () => {
    // Composer derivation (client, float USD) and reserveCost (server, BigInt
    // µUSD) must agree on whether a given total spend crosses the gate.
    // If this assertion ever breaks, a send the client thinks is fine will
    // be rejected by the server, or vice versa.
    const clientEffectiveMicro = BigInt(Math.round(EFFECTIVE_LIFETIME_CAP_USD * 1_000_000));
    expect(clientEffectiveMicro).toBe(EFFECTIVE_LIFETIME_CAP_MICRO_USD);
  });
});

// Pins the invariant that the 429 lifetime_cap_reached payload reports the
// DISPLAYED cap (LIFETIME_CAP_USD), not the EFFECTIVE cap. The client
// classifies cap_reached vs last_send_exceeded by comparing the payload's
// `used_usd` to its `limit_usd`; if a refactor accidentally swapped this
// to EFFECTIVE_LIFETIME_CAP_USD, the boundary between the two banner
// variants would silently shift by the overspend tolerance.
//
// Verified by `?raw` source search rather than a runtime test (reserveCost
// requires Neon to exercise end-to-end). Mirrors the pattern in
// reconcile-sql-invariants.test.ts.
// @ts-expect-error - Vite resolves `?raw` to a string at build time;
// TypeScript can't see the module declaration without a global *?raw
// shim. Suppressing the missing declaration locally is consistent with
// the same `?raw` pattern in production tests.
import streamSource from '../../worker/api/anthropic-stream.ts?raw';

describe('reserveCost 429 payload contract', () => {
  it('returns limit_usd: LIFETIME_CAP_USD in the lifetime_cap_reached error body', () => {
    // Look for the exact literal pairing inside the jsonError body so a
    // rename to EFFECTIVE_LIFETIME_CAP_USD would break this test.
    expect(streamSource as string).toMatch(
      /error:\s*['"]lifetime_cap_reached['"][\s\S]*?limit_usd:\s*LIFETIME_CAP_USD/,
    );
    expect(streamSource as string).not.toMatch(
      /error:\s*['"]lifetime_cap_reached['"][\s\S]*?limit_usd:\s*EFFECTIVE_LIFETIME_CAP_USD/,
    );
  });
});
