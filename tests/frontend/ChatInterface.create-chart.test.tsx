// The first message on `/` creates the chart on the server before the reply is
// requested. The app is told what was created and at which version, with the
// chart exactly as it was sent, so edits made while the request was out go out
// on that version; when creating fails the user is told instead of the message
// quietly going nowhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
});
