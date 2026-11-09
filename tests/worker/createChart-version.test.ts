// `POST /api/createChart` returns the new chart's `version`, so the creating
// tab can start saving against it without a second request.
// Infrastructure: tests/worker/helpers/chart-fake.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { handler as createChart } from '../../worker/api/createChart';
import { ChartFake, env } from './helpers/chart-fake';

const fake = new ChartFake();

beforeAll(() => fake.install());
afterAll(() => fake.uninstall());
beforeEach(() => fake.reset(null));

describe('POST /api/createChart', () => {
  it('createChart_returns_version', async () => {
    const res = await createChart(
      new Request('https://example.com/api/createChart', {
        method: 'POST',
        body: JSON.stringify({ chartData: { title: 'New', sections: [] } }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ version: 1 });
  });
});
