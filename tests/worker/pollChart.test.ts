// Behavior of `POST /api/pollChart` (worker/api/pollChart.ts): the cheap
// check an open editor makes every few seconds. It answers with the chart's
// version, and with the chart itself only when that version differs from the
// one the caller already has. It never writes (unlike getChart's edit-token
// path, which records permission rows).
//
// Who may poll is covered for both poll and save in chart-edit-gate.test.ts.
// Infrastructure: tests/worker/helpers/chart-fake.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { handler as pollChart } from '../../worker/api/pollChart';
import worker from '../../worker/index';
import { ChartFake, env } from './helpers/chart-fake';

const fake = new ChartFake();

const CHART = { title: 'Latest', sections: [{ id: 's0', title: 'A', columns: [] }] };

function pollRequest(body: unknown): Request {
  return new Request('https://example.com/api/pollChart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(() => fake.install());
afterAll(() => fake.uninstall());
beforeEach(() => {
  fake.reset({
    id: 'chart-1',
    edit_token: 'edit-tok-1',
    user_id: null,
    link_sharing_level: null,
    version: 5,
    chart_data: CHART,
  });
});

describe('POST /api/pollChart', () => {
  it('poll_unchanged_returns_version_only', async () => {
    fake.chart!.version = 4;

    const res = await pollChart(pollRequest({ editToken: 'edit-tok-1', knownVersion: 4 }), env);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ version: 4 });
    expect('chartData' in (body as object)).toBe(false);
  });

  it('poll_changed_returns_chart', async () => {
    const res = await pollChart(pollRequest({ editToken: 'edit-tok-1', knownVersion: 4 }), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 5, chartData: CHART });
  });

  it('returns the chart when the stored version is lower than the caller knows (a restore)', async () => {
    const res = await pollChart(pollRequest({ editToken: 'edit-tok-1', knownVersion: 9 }), env);

    expect(await res.json()).toEqual({ version: 5, chartData: CHART });
  });

  it('issues no writes', async () => {
    const token = await fake.signToken({ sub: 'auth0|someone' });
    const res = await pollChart(
      new Request('https://example.com/api/pollChart', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ editToken: 'edit-tok-1', knownVersion: 4 }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(fake.writes()).toEqual([]);
  });

  it.each([['4'], [1.5], [null], [undefined], [2 ** 31], [true]])(
    'rejects knownVersion %j with 400 before touching the database',
    async (knownVersion) => {
      const res = await pollChart(pollRequest({ editToken: 'edit-tok-1', knownVersion }), env);

      expect(res.status).toBe(400);
      expect(fake.statements).toEqual([]);
    },
  );

  it('rejects a poll without an edit token with 400', async () => {
    const res = await pollChart(pollRequest({ knownVersion: 4 }), env);

    expect(res.status).toBe(400);
    expect(fake.statements).toEqual([]);
  });

  it('rejects a body that is not JSON with 400', async () => {
    const res = await pollChart(
      new Request('https://example.com/api/pollChart', { method: 'POST', body: '{nope' }),
      env,
    );

    expect(res.status).toBe(400);
  });

  it('is served at POST /api/pollChart by the Worker entry point', async () => {
    const res = await worker.fetch(
      pollRequest({ editToken: 'edit-tok-1', knownVersion: 5 }),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 5 });
  });
});
