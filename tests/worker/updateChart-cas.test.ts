// Behavior of `POST /api/updateChart` (worker/api/updateChart.ts) once charts
// carry a `version`: a save is a compare-and-swap on the version the client
// last saw, a stale save gets the latest chart back instead of overwriting it,
// and a save from a tab running the previous client (no `baseVersion`) is
// still applied and logged.
//
// Who may save is covered for both save and poll in chart-edit-gate.test.ts.
// Infrastructure: tests/worker/helpers/chart-fake.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { handler as updateChart } from '../../worker/api/updateChart';
import { ChartFake, env } from './helpers/chart-fake';

const fake = new ChartFake();

const CURRENT = { title: 'Theirs', sections: [{ id: 's0', title: 'Latest', columns: [] }] };
const MINE = { title: 'My Theory', sections: [{ id: 's0', title: 'Mine', columns: [] }] };

function anonChart(version: number, chartData: unknown = CURRENT) {
  return {
    id: 'chart-1',
    edit_token: 'edit-tok-1',
    user_id: null,
    link_sharing_level: null,
    version,
    chart_data: chartData,
  };
}

function saveRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/updateChart', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ editToken: 'edit-tok-1', chartData: MINE, ...body }),
  });
}

/** The JSON each console.log call carried, for events the handler emits. */
function loggedEvents(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map(([line]) => (typeof line === 'string' ? JSON.parse(line) : null))
    .filter((e): e is Record<string, unknown> => e !== null && typeof e.event === 'string');
}

let logSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => fake.install());
afterAll(() => fake.uninstall());
beforeEach(() => {
  fake.reset(anonChart(5));
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe('compare-and-swap save', () => {
  it('cas_success_returns_new_version', async () => {
    const res = await updateChart(saveRequest({ baseVersion: 5 }), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, version: 6 });
    expect(fake.chart?.chart_data).toEqual(MINE);
    expect(fake.chart?.chart_title).toBe('My Theory');
    expect(loggedEvents(logSpy)).toEqual([]);
  });

  it('cas_miss_returns_409_with_latest', async () => {
    fake.reset(anonChart(7));

    const res = await updateChart(saveRequest({ baseVersion: 5 }), env);

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', version: 7, chartData: CURRENT });
    // The stale save changed nothing and recorded no attribution.
    expect(fake.chart?.chart_data).toEqual(CURRENT);
    expect(fake.chart?.version).toBe(7);
    expect(fake.insertedPermissions).toEqual([]);
    expect(loggedEvents(logSpy)).toEqual([
      { event: 'updateChart.conflict', chartId: 'chart-1', baseVersion: 5, currentVersion: 7 },
    ]);
  });

  it('cas_miss_then_row_gone_returns_404', async () => {
    fake.vanishAfterGate = true;

    const res = await updateChart(saveRequest({ baseVersion: 5 }), env);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Chart not found or invalid edit token' });
  });

  it('two saves on one base yield one success and one conflict carrying the winner', async () => {
    // The fake serialises the two saves, so this pins the handler's conflict
    // branch and 409 body; atomicity under real concurrency is Postgres's
    // (captured against Postgres 16 outside the repo).
    const [a, b] = await Promise.all([
      updateChart(saveRequest({ baseVersion: 5, chartData: { title: 'A', sections: [] } }), env),
      updateChart(saveRequest({ baseVersion: 5, chartData: { title: 'B', sections: [] } }), env),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? 'A' : 'B';
    const loser = a.status === 200 ? b : a;
    expect(fake.chart?.chart_data).toEqual({ title: winner, sections: [] });
    expect(await loser.json()).toEqual({
      error: 'conflict',
      version: 6,
      chartData: { title: winner, sections: [] },
    });
  });

  it('records the saving collaborator in chart_permissions after a successful write', async () => {
    const token = await fake.signToken({ sub: 'auth0|someone' });

    const res = await updateChart(
      saveRequest({ baseVersion: 5 }, { authorization: `Bearer ${token}` }),
      env,
    );

    expect(res.status).toBe(200);
    expect(fake.insertedPermissions).toEqual(['auth0|someone']);
  });

  it('does not record a collaborator whose save lost the race', async () => {
    fake.reset({ ...anonChart(7), user_id: 'auth0|owner', link_sharing_level: 'editor' });
    const token = await fake.signToken({ sub: 'auth0|someone' });

    const res = await updateChart(
      saveRequest({ baseVersion: 5 }, { authorization: `Bearer ${token}` }),
      env,
    );

    expect(res.status).toBe(409);
    expect(fake.insertedPermissions).toEqual([]);
  });

  it('leaves no permission row for an anonymous save', async () => {
    const res = await updateChart(saveRequest({ baseVersion: 5 }), env);
    expect(res.status).toBe(200);
    expect(fake.insertedPermissions).toEqual([]);
  });

  it('still saves, without attribution, when an anonymous chart is edited with a bad token', async () => {
    const res = await updateChart(
      saveRequest({ baseVersion: 5 }, { authorization: 'Bearer not-a-jwt' }),
      env,
    );
    expect(res.status).toBe(200);
    expect(fake.insertedPermissions).toEqual([]);
  });
});

describe('save from a tab without a version (legacy)', () => {
  it('missing_base_version_takes_legacy_path', async () => {
    fake.reset(anonChart(9));

    const res = await updateChart(saveRequest({}), env);

    expect(res.status).toBe(200);
    // Last save wins as before, and the version still advances for the others.
    expect(await res.json()).toEqual({ success: true, version: 10 });
    expect(fake.chart?.chart_data).toEqual(MINE);
    expect(fake.chartUpdates()).toHaveLength(1);
    expect(fake.chartUpdates()[0].query).not.toMatch(/version\s*=/);
    expect(loggedEvents(logSpy)).toEqual([{ event: 'updateChart.legacy', chartId: 'chart-1' }]);
  });
});

describe('request validation', () => {
  it.each([['5'], [1.5], [0], [-1], [null], [2 ** 31], [true]])(
    'non_integer_base_version_is_400: %j',
    async (baseVersion) => {
      const res = await updateChart(saveRequest({ baseVersion }), env);

      expect(res.status).toBe(400);
      expect(fake.chartUpdates()).toEqual([]);
      expect(fake.chart?.chart_data).toEqual(CURRENT);
    },
  );

  it.each([
    ['no edit token', { editToken: '' }],
    ['no chart data', { chartData: null }],
  ])('rejects a save with %s', async (_name, body) => {
    const res = await updateChart(saveRequest(body), env);
    expect(res.status).toBe(400);
    expect(fake.statements).toEqual([]);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await updateChart(
      new Request('https://example.com/api/updateChart', { method: 'POST', body: '{nope' }),
      env,
    );
    expect(res.status).toBe(400);
    expect(fake.statements).toEqual([]);
  });
});
