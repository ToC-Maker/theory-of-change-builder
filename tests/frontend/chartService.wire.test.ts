// ChartService reads and polls: the version rides along with every chart the
// client loads or creates, and every chart arriving from the server is
// normalised here, once, so nothing downstream sees a section without an id.
// A poll names the version it holds and gets the chart back only when the
// server's differs. Bodies are the shapes worker/api/getChart.ts,
// createChart.ts and pollChart.ts answer with.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChartApiError, ChartService } from '../../src/services/chartService';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// What a chart saved by a client that predates section and column ids looks like.
const STORED_IDLESS = { title: 'Stored', sections: [{ title: 'S', columns: [{ nodes: [] }] }] };
const NORMALISED = {
  title: 'Stored',
  sections: [{ id: 's0', title: 'S', columns: [{ id: 'c0.0', nodes: [] }] }],
};

let fetchSpy: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ChartService.pollChart', () => {
  it('posts the edit token and known version and returns only the version when it is unchanged', async () => {
    fetchSpy.mockResolvedValue(json({ version: 4 }));

    const result = await ChartService.pollChart('tok', 4);

    expect(result).toEqual({ version: 4 });
    expect('chartData' in result).toBe(false);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/pollChart');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ editToken: 'tok', knownVersion: 4 });
  });

  it('returns the new version with the chart normalised when the version changed', async () => {
    fetchSpy.mockResolvedValue(json({ version: 5, chartData: STORED_IDLESS }));

    await expect(ChartService.pollChart('tok', 4)).resolves.toEqual({
      version: 5,
      chartData: NORMALISED,
    });
  });

  it('rejects with the status and logs the raw body of a failed poll', async () => {
    fetchSpy.mockResolvedValue(new Response('upstream down', { status: 503 }));

    const failure = ChartService.pollChart('tok', 4);

    await expect(failure).rejects.toBeInstanceOf(ChartApiError);
    await expect(failure).rejects.toMatchObject({ status: 503 });

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('/api/pollChart');
    expect(logged).toContain('503');
    expect(logged).toContain('upstream down');
  });
});

describe('ChartService.getChartByEditToken', () => {
  it('returns the version and the chart normalised', async () => {
    fetchSpy.mockResolvedValue(
      json({
        chartData: STORED_IDLESS,
        chartId: 'abc123',
        version: 6,
        canEdit: true,
        isOwner: false,
      }),
    );

    await expect(ChartService.getChartByEditToken('tok')).resolves.toEqual({
      chartData: NORMALISED,
      chartId: 'abc123',
      version: 6,
      canEdit: true,
      isOwner: false,
    });
  });

  it("rejects with the worker's message and logs the raw body", async () => {
    fetchSpy.mockResolvedValue(json({ error: 'Chart not found' }, 404));

    await expect(ChartService.getChartByEditToken('tok')).rejects.toMatchObject({
      message: 'Chart not found',
      status: 404,
    });

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).toContain('GET');
    expect(logged).toContain('/api/getChart');
    expect(logged).toContain('Chart not found');
  });

  it('explains a 401 with no readable body', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 401 }));

    await expect(ChartService.getChartByEditToken('tok')).rejects.toMatchObject({
      message: 'Authentication required. Please log in to access this chart.',
    });
  });
});

describe('ChartService.getChart (view route)', () => {
  it('returns the chart normalised', async () => {
    fetchSpy.mockResolvedValue(
      json({ chartData: STORED_IDLESS, chartId: 'abc123', version: 6, canEdit: false }),
    );

    await expect(ChartService.getChart('abc123')).resolves.toEqual(NORMALISED);
  });

  it('rejects and logs the raw body when the chart cannot be fetched', async () => {
    fetchSpy.mockResolvedValue(new Response('gone', { status: 500 }));

    await expect(ChartService.getChart('abc123')).rejects.toMatchObject({ status: 500 });
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('gone');
  });
});

describe('ChartService.createChart', () => {
  it('returns the share links and the version the chart was created at', async () => {
    fetchSpy.mockResolvedValue(
      json({
        chartId: 'abc123',
        editToken: 'tok',
        version: 1,
        viewUrl: 'https://x/chart/abc123',
        editUrl: 'https://x/edit/tok',
        message: 'Chart created successfully',
      }),
    );

    const created = await ChartService.createChart({ title: 'T', sections: [] });

    expect(created).toMatchObject({
      chartId: 'abc123',
      editToken: 'tok',
      version: 1,
      viewUrl: 'https://x/chart/abc123',
      editUrl: 'https://x/edit/tok',
    });
  });

  it('rejects and logs the raw body when creation fails', async () => {
    fetchSpy.mockResolvedValue(json({ error: 'Failed to create chart' }, 500));

    await expect(ChartService.createChart({ title: 'T', sections: [] })).rejects.toMatchObject({
      status: 500,
    });
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('/api/createChart');
  });
});
