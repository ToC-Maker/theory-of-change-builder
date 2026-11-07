// Auth contract tests for `POST /api/updateChart`
// (worker/api/updateChart.ts) — the save path behind the round-2
// reviewer report "it seems the chart isn't saved".
//
// Same root cause as the getUserCharts 401 (see
// getUserCharts-auth.test.ts): commit 533e6ba (this PR series, not on
// main) made owned charts with link_sharing_level != 'editor' require a
// valid Bearer JWT (owner sub or approved chart_permissions row). The
// client's debounced autosave (src/App.tsx handleDataChange →
// ChartService.updateChart) only attached the mount-time static token;
// when that token was absent or expired, every save 403'd, the catch
// left `pendingChangesRef` set, and navigating away produced the
// "changes might not have been saved" beforeunload warning the
// reviewer hit.
//
// Contract pinned here:
//   - owned + restricted + no token      → 403, UPDATE never runs
//   - owned + restricted + expired token → 403, UPDATE never runs
//   - owned + restricted + valid owner   → 200, UPDATE runs
//   - anonymous chart + no token         → 200 (edit token stays the
//     only gate for anon charts — the pre-hardening behavior)
//
// Mock infrastructure (fetch router for JWKS + Neon /sql) is the same
// approach as getUserCharts-auth.test.ts; see the header comment there.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { SignJWT, generateKeyPair, exportJWK, type JWK } from 'jose';
import { handler as updateChart } from '../../worker/api/updateChart';
import type { Env } from '../../worker/_shared/types';

const AUTH0_DOMAIN = 'test-tenant.auth0.example';
const AUTH0_CLIENT_ID = 'client-id-test';
const DB_HOST = 'db.test.neon.tech';

const env = {
  DATABASE_URL: `postgresql://user:pass@${DB_HOST}/neondb`,
  VITE_AUTH0_DOMAIN: AUTH0_DOMAIN,
  VITE_AUTH0_CLIENT_ID: AUTH0_CLIENT_ID,
} as unknown as Env;

let privateKey: CryptoKey;
let publicJwk: JWK;

interface CapturedQuery {
  query: string;
  params: unknown[];
}
let dbQueries: CapturedQuery[];

// Per-test chart row returned by the `SELECT … FROM charts WHERE
// edit_token = $1` lookup. user_id === null models an anonymous chart.
let chartRow: { id: string; user_id: string | null; link_sharing_level: string | null };

/** Neon raw wire shape for each query the handler can issue. */
function neonReply(body: CapturedQuery) {
  if (body.query.includes('SELECT id, user_id, link_sharing_level')) {
    return {
      command: 'SELECT',
      rowCount: 1,
      fields: [
        { name: 'id', dataTypeID: 25 },
        { name: 'user_id', dataTypeID: 25 },
        { name: 'link_sharing_level', dataTypeID: 25 },
      ],
      rows: [[chartRow.id, chartRow.user_id, chartRow.link_sharing_level]],
    };
  }
  if (body.query.includes('UPDATE charts')) {
    return {
      command: 'UPDATE',
      rowCount: 1,
      fields: [{ name: 'id', dataTypeID: 25 }],
      rows: [[chartRow.id]],
    };
  }
  if (body.query.includes('INSERT INTO chart_permissions')) {
    return { command: 'INSERT', rowCount: 0, fields: [], rows: [] };
  }
  throw new Error(`Unexpected SQL in test: ${body.query}`);
}

const originalFetch = globalThis.fetch;

async function signToken(
  key: CryptoKey,
  { sub = 'auth0|owner', expiresIn = '1h' }: { sub?: string; expiresIn?: string | number } = {},
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

function saveRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/updateChart', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      editToken: 'edit-tok-1',
      chartData: { title: 'My Theory', sections: [] },
    }),
  });
}

const ranUpdate = () => dbQueries.some((q) => q.query.includes('UPDATE charts'));

beforeAll(async () => {
  const real = await generateKeyPair('RS256');
  privateKey = real.privateKey;
  publicJwk = { ...(await exportJWK(real.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === AUTH0_DOMAIN && url.pathname === '/.well-known/jwks.json') {
      return Response.json({ keys: [publicJwk] });
    }
    // Host label is rewritten by the neon driver (db.… → api.…); match
    // the /sql path instead.
    if (url.pathname === '/sql' && req.method === 'POST') {
      const body = (await req.json()) as CapturedQuery;
      dbQueries.push(body);
      return Response.json(neonReply(body));
    }
    throw new Error(`Unexpected outbound fetch in test: ${req.method} ${req.url}`);
  }) as typeof fetch;
});

beforeEach(() => {
  dbQueries = [];
  chartRow = { id: 'chart-1', user_id: 'auth0|owner', link_sharing_level: 'restricted' };
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('POST /api/updateChart auth contract (the silent-save-failure path)', () => {
  it('403s an owned restricted chart when no Authorization header is sent — UPDATE never runs', async () => {
    // The reviewer's save path: signed-in UI, but the autosave fetch
    // went out without a usable token.
    const res = await updateChart(saveRequest(), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Authentication required to edit this chart.' });
    expect(ranUpdate()).toBe(false);
  });

  it('403s an owned restricted chart on an expired token — UPDATE never runs', async () => {
    const expired = await signToken(privateKey, {
      expiresIn: Math.floor(Date.now() / 1000) - 3600,
    });
    const res = await updateChart(saveRequest({ authorization: `Bearer ${expired}` }), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Invalid or expired authentication. Please log in again.',
    });
    expect(ranUpdate()).toBe(false);
  });

  it('200s and persists when the owner presents a valid token', async () => {
    const token = await signToken(privateKey, { sub: 'auth0|owner' });
    const res = await updateChart(saveRequest({ authorization: `Bearer ${token}` }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    expect(ranUpdate()).toBe(true);
  });

  it('403s a non-owner without an approved permission row', async () => {
    // The permission lookup for the stranger's sub returns no rows.
    const stranger = await signToken(privateKey, { sub: 'auth0|stranger' });
    const neonReplyBase = neonReply;
    // Narrow override: the SELECT on chart_permissions must come back
    // empty for this test. (Other queries keep the standard replies.)
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.pathname === '/sql' && req.method === 'POST') {
        const body = (await req.json()) as CapturedQuery;
        dbQueries.push(body);
        if (body.query.includes('SELECT status FROM chart_permissions')) {
          return Response.json({
            command: 'SELECT',
            rowCount: 0,
            fields: [{ name: 'status', dataTypeID: 25 }],
            rows: [],
          });
        }
        return Response.json(neonReplyBase(body));
      }
      return origFetch(input, init);
    }) as typeof fetch;
    try {
      const res = await updateChart(saveRequest({ authorization: `Bearer ${stranger}` }), env);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: 'You do not have permission to edit this chart.',
      });
      expect(ranUpdate()).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('200s an anonymous chart with no token (edit token remains the only gate)', async () => {
    chartRow = { id: 'chart-2', user_id: null, link_sharing_level: null };
    const res = await updateChart(saveRequest(), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true });
    expect(ranUpdate()).toBe(true);
    // No token → no attribution upsert.
    expect(dbQueries.some((q) => q.query.includes('INSERT INTO chart_permissions'))).toBe(false);
  });
});
