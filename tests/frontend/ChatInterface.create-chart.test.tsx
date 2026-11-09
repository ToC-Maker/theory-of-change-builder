// The first message on `/` creates the chart on the server before the reply is
// requested. The app is told what was created and at which version, with the
// chart exactly as it was sent, so edits made while the request was out go out
// on that version; when creating fails the user is told instead of the message
// quietly going nowhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ChatInterface } from '../../src/components/ChatInterface';
import { ApiKeyContext, type ApiKeyContextValue } from '../../src/contexts/useApiKey';
import { ChartApiError, ChartService } from '../../src/services/chartService';
import { normalizeChart } from '../../shared/chart-model';
import { node } from '../shared/chart-fixtures';

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    isAuthenticated: true,
    isLoading: false,
    user: undefined,
    getIdTokenClaims: async () => undefined,
    getAccessTokenSilently: async () => '',
    loginWithRedirect: () => {},
    logout: () => {},
  }),
}));

const apiKeyStub: ApiKeyContextValue = {
  hasKey: false,
  keyLast4: null,
  verified: false,
  useForChat: false,
  setUseForChat: vi.fn(),
  submitKey: vi.fn(),
  clearKey: vi.fn(),
  refresh: vi.fn(),
  keyVersion: 0,
};

const chart = normalizeChart({
  title: 'T',
  sections: [{ title: 'One', columns: [{ nodes: [node('n1', 100, { title: 'Alpha' })] }] }],
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/usage')) {
        return Response.json({ used_usd: 0, limit_usd: 5, tier: 'free' });
      }
      if (url.includes('/api/upload-file')) {
        return Response.json({
          file_id: 'file-1',
          filename: 'a.pdf',
          size_bytes: 10,
          mime_type: 'application/pdf',
        });
      }
      return Response.json({});
    }),
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sendFirstMessage(onChartCreated = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/']}>
      <ApiKeyContext.Provider value={apiKeyStub}>
        <ChatInterface
          isCollapsed={false}
          onToggle={() => {}}
          graphData={chart}
          onChartCreated={onChartCreated}
        />
      </ApiKeyContext.Provider>
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByPlaceholderText('Ask about your Theory of Change...'), {
    target: { value: 'Hello' },
  });
  fireEvent.click(screen.getByTitle('Send message'));
  return onChartCreated;
}

describe('creating the chart on the first message', () => {
  it('tells the app the version and exactly the chart that was sent', async () => {
    const createChart = vi.spyOn(ChartService, 'createChart').mockResolvedValue({
      chartId: 'chart-1',
      editToken: 'tok-1',
      viewUrl: 'https://x.test/chart/chart-1',
      editUrl: 'https://x.test/edit/tok-1',
      version: 1,
    });
    vi.spyOn(ChartService, 'saveEditToken').mockImplementation(() => {});

    const onChartCreated = sendFirstMessage();

    await waitFor(() => expect(onChartCreated).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    expect(onChartCreated).toHaveBeenCalledWith({
      editToken: 'tok-1',
      chartId: 'chart-1',
      version: 1,
      chart: createChart.mock.calls[0][0],
    });
    expect(createChart.mock.calls[0][0]).toBe(chart);
  });

  it('shows why when the chart cannot be created, instead of dropping the message silently', async () => {
    vi.spyOn(ChartService, 'createChart').mockRejectedValue(
      new ChartApiError('The server did not return a chart version', 200),
    );

    const onChartCreated = sendFirstMessage();

    expect(
      await screen.findByText(/did not return a chart version/i, undefined, { timeout: 15_000 }),
    ).toBeVisible();
    expect(onChartCreated).not.toHaveBeenCalled();
  });

  it('creates the chart on the next message after a failed create', async () => {
    const createChart = vi
      .spyOn(ChartService, 'createChart')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        chartId: 'chart-1',
        editToken: 'tok-1',
        viewUrl: 'https://x.test/chart/chart-1',
        editUrl: 'https://x.test/edit/tok-1',
        version: 1,
      });
    vi.spyOn(ChartService, 'saveEditToken').mockImplementation(() => {});

    const onChartCreated = sendFirstMessage();
    expect(await screen.findByText(/network down/i, undefined, { timeout: 15_000 })).toBeVisible();

    // The failed create must not stay in flight: the next send tries again.
    fireEvent.change(screen.getByPlaceholderText('Ask about your Theory of Change...'), {
      target: { value: 'Hello again' },
    });
    fireEvent.click(screen.getByTitle('Send message'));

    await waitFor(() => expect(onChartCreated).toHaveBeenCalledTimes(1), { timeout: 15_000 });
    expect(createChart).toHaveBeenCalledTimes(2);
  }, 30_000);
});

// The first render of the chat is slow on a loaded machine.
const SLOW = 30_000;

const createdChart = (n: number) => ({
  chartId: `chart-${n}`,
  editToken: `tok-${n}`,
  viewUrl: `https://x.test/chart/chart-${n}`,
  editUrl: `https://x.test/edit/tok-${n}`,
  version: 1,
});

function Pathname() {
  return <output data-testid="pathname">{useLocation().pathname}</output>;
}

const pdf = (name: string) =>
  new File(['%PDF-1.4 /Type /Pages /Count 1'], name, { type: 'application/pdf' });

const uploadRequests = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => String(url).includes('/api/upload-file'))
    .map(([, init]) => ({
      chartId: (init?.body as FormData).get('chart_id'),
      editToken: (init?.headers as Record<string, string>)['X-Edit-Token'],
    }));

describe('two files added at once on a chart that does not exist yet', () => {
  it(
    'create one chart between them, and the URL, the app and both uploads follow it',
    async () => {
      let finishCreate!: (value: ReturnType<typeof createdChart>) => void;
      const createChart = vi.spyOn(ChartService, 'createChart').mockImplementation(
        () =>
          new Promise((resolve) => {
            finishCreate = resolve;
          }),
      );
      vi.spyOn(ChartService, 'saveEditToken').mockImplementation(() => {});
      const onChartCreated = vi.fn();
      const { container } = render(
        <MemoryRouter initialEntries={['/']}>
          <ApiKeyContext.Provider value={apiKeyStub}>
            <ChatInterface
              isCollapsed={false}
              onToggle={() => {}}
              graphData={chart}
              onChartCreated={onChartCreated}
            />
            <Pathname />
          </ApiKeyContext.Provider>
        </MemoryRouter>,
      );

      fireEvent.change(container.querySelector('input[type="file"][multiple]')!, {
        target: { files: [pdf('a.pdf'), pdf('b.pdf')] },
      });
      // Both files are uploading (and have asked for the chart) before the first create returns.
      await screen.findByText('a.pdf', undefined, { timeout: 15_000 });
      await screen.findByText('b.pdf', undefined, { timeout: 15_000 });
      expect(createChart).toHaveBeenCalledTimes(1);

      finishCreate(createdChart(1));

      await waitFor(() => expect(uploadRequests()).toHaveLength(2), { timeout: 15_000 });
      // The router applies a navigation as a transition, which a loaded machine delays.
      await waitFor(() => expect(screen.getByTestId('pathname').textContent).toBe('/edit/tok-1'), {
        timeout: 15_000,
      });
      expect(createChart).toHaveBeenCalledTimes(1);
      expect(onChartCreated).toHaveBeenCalledTimes(1);
      expect(onChartCreated.mock.calls[0][0].editToken).toBe('tok-1');
      expect(uploadRequests()).toEqual([
        { chartId: 'chart-1', editToken: 'tok-1' },
        { chartId: 'chart-1', editToken: 'tok-1' },
      ]);
    },
    SLOW,
  );
});

describe('a chart created while the document already holds another', () => {
  it(
    'follows the chart the app kept: the URL and the upload use its token and id',
    async () => {
      // Chat and Share created a chart at once; the app attached the first.
      vi.spyOn(ChartService, 'createChart').mockResolvedValue(createdChart(2));
      vi.spyOn(ChartService, 'saveEditToken').mockImplementation(() => {});
      const onChartCreated = vi
        .fn()
        .mockReturnValue({ editToken: 'tok-doc', chartId: 'chart-doc' });
      const { container } = render(
        <MemoryRouter initialEntries={['/']}>
          <ApiKeyContext.Provider value={apiKeyStub}>
            <ChatInterface
              isCollapsed={false}
              onToggle={() => {}}
              graphData={chart}
              onChartCreated={onChartCreated}
            />
            <Pathname />
          </ApiKeyContext.Provider>
        </MemoryRouter>,
      );

      fireEvent.change(container.querySelector('input[type="file"][multiple]')!, {
        target: { files: [pdf('a.pdf')] },
      });

      await waitFor(() => expect(uploadRequests()).toHaveLength(1), { timeout: 15_000 });
      await waitFor(
        () => expect(screen.getByTestId('pathname').textContent).toBe('/edit/tok-doc'),
        {
          timeout: 15_000,
        },
      );
      expect(uploadRequests()).toEqual([{ chartId: 'chart-doc', editToken: 'tok-doc' }]);
    },
    SLOW,
  );
});
