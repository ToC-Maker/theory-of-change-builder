// Regression test for the public-view gate in `GET /api/getChart?chartId=`
// (worker/api/getChart.ts, the `chartId` branch).
//
// An owned chart whose `link_sharing_level` is `restricted` (or NULL, which
// the handler treats as `restricted`) must refuse an unauthenticated viewer
// with 403; any other combination must serve the chart. This gate has locked
// owners' public view links out twice in production, so the five cells that
// matter are pinned here, each with no Authorization header:
//
//   owner? | level      | expected
//   -------+------------+---------
//   yes    | viewer     | 200
//   yes    | editor     | 200
//   yes    | restricted | 403
//   yes    | NULL       | 403
//   no     | restricted | 200   (anonymous charts have no owner to protect)
//
// Infrastructure: the real handler runs against a test-local
// `globalThis.fetch` that plays the Neon HTTP endpoint (the
// @neondatabase/serverless driver POSTs {query, params} to /sql and expects
// array-mode rows plus `fields` metadata). No token is sent, so the handler
// never reaches JWT verification and no JWKS is needed.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { handler as getChart } from '../../worker/api/getChart';
import type { Env } from '../../worker/_shared/types';

const env = {
  DATABASE_URL: 'postgresql://user:pass@db.test.neon.tech/neondb',
} as unknown as Env;

interface CapturedQuery {
  query: string;
  params: unknown[];
}
let dbQueries: CapturedQuery[];

// The chart row the fake database will serve for the current test.
let chartRow: { userId: string | null; level: string | null };

// Postgres type OIDs the driver uses to parse raw text values.
const TEXT = 25;
const JSONB = 3802;

const originalFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    // The driver rewrites the connection-string host's first label to `api.`,
    // so match on the /sql path rather than the host.
    if (url.pathname === '/sql' && req.method === 'POST') {
      const body = (await req.json()) as CapturedQuery;
      dbQueries.push(body);
      if (/^\s*SELECT .* FROM charts/is.test(body.query)) {
        return Response.json({
          command: 'SELECT',
          rowCount: 1,
          fields: [
            { name: 'id', dataTypeID: TEXT },
            { name: 'chart_data', dataTypeID: JSONB },
            { name: 'user_id', dataTypeID: TEXT },
            { name: 'link_sharing_level', dataTypeID: TEXT },
          ],
          rows: [['chart-1', '{"sections":[]}', chartRow.userId, chartRow.level]],
        });
      }
      // The view_count UPDATE.
      return Response.json({ command: 'UPDATE', rowCount: 1, fields: [], rows: [] });
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

function viewRequest(): Request {
  return new Request('https://example.com/api/getChart?chartId=chart-1');
}

describe('GET /api/getChart?chartId= view gate (no auth token)', () => {
  it('serves an owned chart at level viewer', async () => {
    chartRow = { userId: 'auth0|owner', level: 'viewer' };
    const res = await getChart(viewRequest(), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      chartId: 'chart-1',
      chartData: { sections: [] },
      canEdit: false,
      isOwner: false,
    });
  });

  it('serves an owned chart at level editor', async () => {
    chartRow = { userId: 'auth0|owner', level: 'editor' };
    const res = await getChart(viewRequest(), env);
    expect(res.status).toBe(200);
  });

  it('refuses an owned chart at level restricted with 403, without counting a view', async () => {
    chartRow = { userId: 'auth0|owner', level: 'restricted' };
    const res = await getChart(viewRequest(), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'Authentication required. This chart is restricted.',
    });
    expect(dbQueries.some((q) => /UPDATE charts/i.test(q.query))).toBe(false);
  });

  it('treats an owned chart with a NULL level as restricted', async () => {
    chartRow = { userId: 'auth0|owner', level: null };
    const res = await getChart(viewRequest(), env);
    expect(res.status).toBe(403);
  });

  it('serves a chart with no owner even at level restricted', async () => {
    chartRow = { userId: null, level: 'restricted' };
    const res = await getChart(viewRequest(), env);
    expect(res.status).toBe(200);
  });
});
