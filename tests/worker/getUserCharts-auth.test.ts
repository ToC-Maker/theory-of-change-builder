// Auth contract tests for `GET /api/getUserCharts`
// (worker/api/getUserCharts.ts).
//
// Context (PR 7 round-2 feedback, signed-in 401s): commit 533e6ba —
// part of this PR series, NOT yet on main — hardened the endpoint to
// derive `userId` from a verified Bearer JWT instead of trusting the
// `?userId=` query param. The client was not upgraded in lockstep: it
// attaches the Authorization header only when a mount-time static
// token happens to be set (src/services/chartService.ts), so a missing
// or expired token produced exactly the 401 the reviewer reported:
//
//   /api/getUserCharts?userId=auth0%7C…  → 401
//   [FileMenu] failed to load user charts
//
// These tests pin the worker side of that contract so the fix on the
// client (per-request token resolution via setAuthTokenProvider) has a
// stable target:
//   - no Authorization header       → 401 (never touches the DB)
//   - expired token (signed-in-but- → 401 (the mid-session staleness
//     stale, the reviewer's case)         window)
//   - token signed by the wrong key → 401
//   - valid token                   → 200, and the SQL params use the
//     JWT's `sub` — NOT the ?userId= query param — so a caller cannot
//     enumerate someone else's charts.
//
// Infrastructure: the real handler runs against a test-local
// `globalThis.fetch` router (this @cloudflare/vitest-pool-workers major
// no longer ships `fetchMock`; the pool itself reassigns global fetch,
// so tests may too) that serves:
//   - a locally generated RS256 public key as the tenant JWKS
//     (worker/_shared/auth.ts fetches
//     https://<domain>/.well-known/jwks.json via jose), and
//   - a fake Neon HTTP endpoint (the @neondatabase/serverless driver
//     POSTs {query, params} to https://<db-host>/sql and expects
//     array-mode rows + fields metadata; dataTypeID 25 = text).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, type JWK } from 'jose';
import { handler as getUserCharts } from '../../worker/api/getUserCharts';
import type { Env } from '../../worker/_shared/types';

const AUTH0_DOMAIN = 'test-tenant.auth0.example';
const AUTH0_CLIENT_ID = 'client-id-test';
const DB_HOST = 'db.test.neon.tech';

const env = {
  DATABASE_URL: `postgresql://user:pass@${DB_HOST}/neondb`,
  VITE_AUTH0_DOMAIN: AUTH0_DOMAIN,
  VITE_AUTH0_CLIENT_ID: AUTH0_CLIENT_ID,
} as unknown as Env;

// Keypair generated once per file; the public half is served as the
// tenant JWKS. A second keypair ("rogue") signs structurally valid
// tokens that must fail signature verification.
let privateKey: CryptoKey;
let roguePrivateKey: CryptoKey;
let publicJwk: JWK;

// Captured bodies of every POST the Neon driver makes, so tests can
// assert which SQL ran and with which params.
interface CapturedQuery {
  query: string;
  params: unknown[];
}
let dbQueries: CapturedQuery[];

// One Neon row in the raw HTTP wire shape (Neon-Array-Mode: true +
// Neon-Raw-Text-Output: true): rows are arrays of strings zipped with
// `fields` by the driver. dataTypeID 25 (text) keeps values as-is.
const chartsResult = {
  command: 'SELECT',
  rowCount: 1,
  fields: [
    { name: 'chart_id', dataTypeID: 25 },
    { name: 'chart_title', dataTypeID: 25 },
    { name: 'edit_token', dataTypeID: 25 },
    { name: 'updated_at', dataTypeID: 25 },
    { name: 'created_at', dataTypeID: 25 },
    { name: 'permission_level', dataTypeID: 25 },
  ],
  rows: [
    [
      'chart-1',
      'My Theory',
      'edit-tok-1',
      '2026-06-01T10:00:00.000Z',
      '2026-05-01T10:00:00.000Z',
      'owner',
    ],
  ],
};

const originalFetch = globalThis.fetch;

/** Sign a token with the given claims against the test tenant. */
async function signToken(
  key: CryptoKey,
  { sub = 'auth0|reviewer', expiresIn = '1h' }: { sub?: string; expiresIn?: string | number } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject(sub)
    .setIssuer(`https://${AUTH0_DOMAIN}/`)
    .setAudience(AUTH0_CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

function request(headers: Record<string, string> = {}): Request {
  // The client still sends ?userId= for backward compatibility; the
  // worker must ignore it (the JWT sub is authoritative).
  return new Request('https://example.com/api/getUserCharts?userId=auth0%7Csomeone-else', {
    headers,
  });
}

beforeAll(async () => {
  const real = await generateKeyPair('RS256');
  const rogue = await generateKeyPair('RS256');
  privateKey = real.privateKey;
  roguePrivateKey = rogue.privateKey;
  publicJwk = { ...(await exportJWK(real.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  // Outbound-fetch router: JWKS + Neon. Anything else is a test bug.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === AUTH0_DOMAIN && url.pathname === '/.well-known/jwks.json') {
      return Response.json({ keys: [publicJwk] });
    }
    // The neon driver rewrites the connection-string host's first label
    // to `api.` for its HTTP endpoint (db.test.neon.tech →
    // api.test.neon.tech), so match on the /sql path, not the host.
    if (url.pathname === '/sql' && req.method === 'POST') {
      const body = (await req.json()) as CapturedQuery;
      dbQueries.push(body);
      return Response.json(chartsResult);
    }
    throw new Error(`Unexpected outbound fetch in test: ${req.method} ${req.url}`);
  }) as typeof fetch;
});

beforeEach(() => {
  dbQueries = [];
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('GET /api/getUserCharts auth contract', () => {
  it('returns 401 when no Authorization header is present (and never queries the DB)', async () => {
    // This is the exact wire shape the redesigned FileMenu produced for
    // the reviewer: authenticated UI state, but ChartService's static
    // token was null, so the fetch went out bare.
    const res = await getUserCharts(request(), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Authentication required' });
    expect(dbQueries).toHaveLength(0);
  });

  it('returns 401 for an expired token (mid-session staleness — the signed-in 401)', async () => {
    // ChartService used to capture the ID token once per mount; any
    // request after the token's exp got this response.
    const expired = await signToken(privateKey, {
      expiresIn: Math.floor(Date.now() / 1000) - 3600,
    });
    const res = await getUserCharts(request({ authorization: `Bearer ${expired}` }), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid or expired token' });
    expect(dbQueries).toHaveLength(0);
  });

  it('returns 401 for a token signed by the wrong key', async () => {
    const forged = await signToken(roguePrivateKey);
    const res = await getUserCharts(request({ authorization: `Bearer ${forged}` }), env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid or expired token' });
    expect(dbQueries).toHaveLength(0);
  });

  it('returns 200 with charts for a valid token, deriving userId from the JWT sub (not ?userId=)', async () => {
    // No email claim in the token → tryMigrateUser no-ops → exactly one
    // DB query (the charts SELECT).
    const token = await signToken(privateKey, { sub: 'auth0|reviewer' });
    const res = await getUserCharts(request({ authorization: `Bearer ${token}` }), env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { charts: { chartId: string; editUrl: string }[] };
    expect(body.charts).toHaveLength(1);
    expect(body.charts[0]).toMatchObject({
      chartId: 'chart-1',
      title: 'My Theory',
      permissionLevel: 'owner',
    });
    expect(body.charts[0].editUrl).toContain('/edit/edit-tok-1');

    // The authorization core: SQL params must be the verified JWT sub,
    // not the attacker-controllable query param value.
    expect(dbQueries).toHaveLength(1);
    expect(dbQueries[0].query).toContain('FROM charts');
    // Three placeholders: the chart_permissions JOIN + both WHERE arms.
    expect(dbQueries[0].params).toEqual(['auth0|reviewer', 'auth0|reviewer', 'auth0|reviewer']);
    expect(dbQueries[0].params).not.toContain('auth0|someone-else');
  });
});
