// Who may save a chart, and who may poll it. `POST /api/updateChart` and
// `POST /api/pollChart` share one gate (worker/_shared/chart-edit-access.ts),
// so every case below runs against both endpoints.
//
// The gate's history: commit 533e6ba made owned charts whose
// link_sharing_level is not 'editor' require a valid Bearer JWT (the owner's,
// or a collaborator with an `approved` chart_permissions row). The client's
// autosave attached only a mount-time token, so a missing or expired token
// made every save 403 ("it seems the chart isn't saved"). The edit token alone
// still suffices for anonymous charts and for owned charts shared as 'editor'.
//
// Two properties matter beyond the status code: a refused caller never learns
// the chart's version or content, and a refusal never writes.
// Infrastructure: tests/worker/helpers/chart-fake.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { handler as updateChart } from '../../worker/api/updateChart';
import { handler as pollChart } from '../../worker/api/pollChart';
import type { Env } from '../../worker/_shared/types';
import {
  ChartFake,
  env,
  envWithJwksOutage,
  DOWN_AUTH0_DOMAIN,
  type ChartRow,
} from './helpers/chart-fake';

const fake = new ChartFake();

const ROW: ChartRow = {
  id: 'chart-1',
  edit_token: 'edit-tok-1',
  user_id: 'auth0|owner',
  link_sharing_level: 'restricted',
  version: 5,
  chart_data: { title: 'Stored', sections: [] },
};

type Credential =
  | { kind: 'none' }
  | { kind: 'jwt'; sub: string }
  | { kind: 'expired' }
  | { kind: 'wrong-key' }
  | { kind: 'jwks-outage' };

interface GateCase {
  name: string;
  chart: Partial<ChartRow>;
  credential: Credential;
  permission?: string;
  editToken?: string;
  expect: { status: 200 } | { status: 403 | 404 | 502; error: string };
}

const AUTH_REQUIRED = 'Authentication required to edit this chart.';
const INVALID_AUTH = 'Invalid or expired authentication. Please log in again.';
const NO_PERMISSION = 'You do not have permission to edit this chart.';
const NOT_FOUND = 'Chart not found or invalid edit token';
const AUTH_DOWN = 'Authentication service unavailable. Please try again later.';

const cases: GateCase[] = [
  {
    name: 'anonymous chart, edit token only',
    chart: { user_id: null, link_sharing_level: null },
    credential: { kind: 'none' },
    expect: { status: 200 },
  },
  {
    name: 'owned chart shared as editor, no JWT',
    chart: { link_sharing_level: 'editor' },
    credential: { kind: 'none' },
    expect: { status: 200 },
  },
  {
    name: 'owned restricted chart, no JWT',
    chart: { link_sharing_level: 'restricted' },
    credential: { kind: 'none' },
    expect: { status: 403, error: AUTH_REQUIRED },
  },
  {
    name: 'owned viewer chart, no JWT',
    chart: { link_sharing_level: 'viewer' },
    credential: { kind: 'none' },
    expect: { status: 403, error: AUTH_REQUIRED },
  },
  {
    name: 'owned chart with no sharing level (treated as restricted), no JWT',
    chart: { link_sharing_level: null },
    credential: { kind: 'none' },
    expect: { status: 403, error: AUTH_REQUIRED },
  },
  {
    name: 'owner with a valid JWT',
    chart: {},
    credential: { kind: 'jwt', sub: 'auth0|owner' },
    expect: { status: 200 },
  },
  {
    name: 'collaborator with an approved permission row',
    chart: {},
    credential: { kind: 'jwt', sub: 'auth0|collab' },
    permission: 'approved',
    expect: { status: 200 },
  },
  {
    name: 'collaborator whose request is pending',
    chart: {},
    credential: { kind: 'jwt', sub: 'auth0|collab' },
    permission: 'pending',
    expect: { status: 403, error: NO_PERMISSION },
  },
  {
    name: 'collaborator whose request was rejected',
    chart: {},
    credential: { kind: 'jwt', sub: 'auth0|collab' },
    permission: 'rejected',
    expect: { status: 403, error: NO_PERMISSION },
  },
  {
    name: 'stranger with no permission row',
    chart: {},
    credential: { kind: 'jwt', sub: 'auth0|stranger' },
    expect: { status: 403, error: NO_PERMISSION },
  },
  {
    name: 'expired JWT',
    chart: {},
    credential: { kind: 'expired' },
    expect: { status: 403, error: INVALID_AUTH },
  },
  {
    name: 'JWT signed by an unknown key',
    chart: {},
    credential: { kind: 'wrong-key' },
    expect: { status: 403, error: INVALID_AUTH },
  },
  {
    name: 'JWKS endpoint down',
    chart: {},
    credential: { kind: 'jwks-outage' },
    expect: { status: 502, error: AUTH_DOWN },
  },
  {
    name: 'unknown edit token',
    chart: {},
    credential: { kind: 'none' },
    editToken: 'no-such-token',
    expect: { status: 404, error: NOT_FOUND },
  },
];

async function authorization(c: Credential): Promise<Record<string, string>> {
  switch (c.kind) {
    case 'none':
      return {};
    case 'jwt':
      return { authorization: `Bearer ${await fake.signToken({ sub: c.sub })}` };
    case 'expired':
      return {
        authorization: `Bearer ${await fake.signToken({
          expiresIn: Math.floor(Date.now() / 1000) - 3600,
        })}`,
      };
    case 'wrong-key':
      return { authorization: `Bearer ${await fake.signToken({}, { rogue: true })}` };
    case 'jwks-outage':
      return {
        authorization: `Bearer ${await fake.signToken({}, { domain: DOWN_AUTH0_DOMAIN })}`,
      };
  }
}

const endpoints = [
  {
    name: 'updateChart',
    call: (editToken: string, headers: Record<string, string>, row: ChartRow, workerEnv: Env) =>
      updateChart(
        new Request('https://example.com/api/updateChart', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            editToken,
            chartData: { title: 'New', sections: [] },
            baseVersion: row.version,
          }),
        }),
        workerEnv,
      ),
  },
  {
    name: 'pollChart',
    call: (editToken: string, headers: Record<string, string>, row: ChartRow, workerEnv: Env) =>
      pollChart(
        new Request('https://example.com/api/pollChart', {
          method: 'POST',
          headers,
          body: JSON.stringify({ editToken, knownVersion: row.version - 1 }),
        }),
        workerEnv,
      ),
  },
];

beforeAll(() => fake.install());
afterAll(() => fake.uninstall());

describe.each(endpoints)('edit gate on $name', ({ name, call }) => {
  it.each(cases)('$name', async (c) => {
    const row: ChartRow = { ...ROW, ...c.chart };
    fake.reset(row);
    if (c.permission) fake.permissions.set('auth0|collab', c.permission);

    const res = await call(
      c.editToken ?? row.edit_token,
      await authorization(c.credential),
      row,
      c.credential.kind === 'jwks-outage' ? envWithJwksOutage : env,
    );
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(c.expect.status);
    // A poll never writes, whoever asks (a save records its editor on success).
    if (name === 'pollChart') expect(fake.writes()).toEqual([]);
    if (c.expect.status === 200) {
      expect(body).toHaveProperty('version');
      return;
    }
    expect(body).toEqual({ error: c.expect.error });
    expect(body).not.toHaveProperty('version');
    expect(body).not.toHaveProperty('chartData');
    expect(fake.writes()).toEqual([]);
    expect(fake.chart).toEqual(row);
  });
});
