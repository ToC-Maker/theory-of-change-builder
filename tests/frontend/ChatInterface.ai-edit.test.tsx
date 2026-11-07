// What the chat does with the edits an AI reply carries: it computes them against
// the chart as it was when the message was sent (not whatever the chart is when
// the reply lands, which is the merge's job to reconcile), hands them to the app,
// and when the app cannot use them says so in the conversation, in Chat and in
// Generate mode alike.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ChatInterface } from '../../src/components/ChatInterface';
import { ApiKeyContext, type ApiKeyContextValue } from '../../src/contexts/useApiKey';
import { ChartService } from '../../src/services/chartService';
import { chatService } from '../../src/services/chatService';
import { loggingService } from '../../src/services/loggingService';
import { normalizeChart, type ToCData } from '../../shared/chart-model';
import { edit, findNode, node, nodeIn } from '../shared/chart-fixtures';

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

const sentChart = normalizeChart({
  title: 'T',
  sections: [{ title: 'One', columns: [{ nodes: [node('n1', 100, { title: 'Alpha' })] }] }],
});
// The chart a collaborator's edit has made it by the time the reply lands.
const laterChart: ToCData = edit(sentChart, (draft) => {
  nodeIn(draft, 'n1').title = 'Alpha, retitled by someone else';
});

const EDITS = [{ type: 'update' as const, path: 'sections.0.title', value: 'Retitled by AI' }];

// The first render of the chat is slow on a loaded machine.
const SLOW = 30_000;

let streamed: ReturnType<typeof deferred<void>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  // The chat restores its history from here, and Generate asks before replacing one.
  localStorage.clear();
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
  vi.spyOn(ChartService, 'getChartByEditToken').mockResolvedValue({
    chartData: sentChart,
    chartId: 'chart-1',
    canEdit: true,
    isOwner: true,
    version: 1,
  });
  vi.spyOn(loggingService, 'logAIEdit').mockImplementation(() => {});
  // A reply that carries `EDITS`, delivered when the test lets it.
  streamed = deferred<void>();
  vi.spyOn(chatService, 'streamMessage').mockImplementation(async ({ callbacks }) => {
    callbacks.onAccepted?.();
    await streamed.promise;
    callbacks.onComplete?.('Done.', EDITS, undefined, 'Done.', []);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderChat(
  onAIEdit: (asSent: ToCData, result: unknown) => ToCData,
  graphData = sentChart,
) {
  const ui = (graph: ToCData) => (
    <MemoryRouter initialEntries={['/edit/tok']}>
      <ApiKeyContext.Provider value={apiKeyStub}>
        <Routes>
          <Route
            path="/edit/:editToken"
            element={
              <ChatInterface
                isCollapsed={false}
                onToggle={() => {}}
                graphData={graph}
                onAIEdit={onAIEdit as never}
              />
            }
          />
        </Routes>
      </ApiKeyContext.Provider>
    </MemoryRouter>
  );
  const rendered = render(ui(graphData));
  return { ...rendered, showChart: (graph: ToCData) => rendered.rerender(ui(graph)) };
}

const sendChatMessage = () => {
  fireEvent.change(screen.getByPlaceholderText('Ask about your Theory of Change...'), {
    target: { value: 'Retitle the first section' },
  });
  fireEvent.click(screen.getByTitle('Send message'));
};

const startGenerating = () => {
  fireEvent.click(screen.getAllByText('Generate')[0].closest('button')!);
  const prompt = screen.getByPlaceholderText('A description, files, or both…');
  fireEvent.change(prompt, { target: { value: 'A chart about bees' } });
  fireEvent.click(screen.getByTitle('Generate Theory of Change'));
};

describe('an AI reply in Chat mode', () => {
  it(
    'is computed against the chart as it was sent, whatever the chart is when the reply lands',
    async () => {
      const onAIEdit = vi.fn().mockReturnValue(sentChart);
      const { showChart } = renderChat(onAIEdit);

      sendChatMessage();
      await waitFor(() => expect(chatService.streamMessage).toHaveBeenCalledTimes(1), {
        timeout: 15_000,
      });
      // A collaborator's edit reaches the chat's chart while the reply streams.
      showChart(laterChart);
      streamed.resolve();

      await waitFor(() => expect(onAIEdit).toHaveBeenCalledTimes(1), { timeout: 15_000 });
      const [asSent, result] = onAIEdit.mock.calls[0];
      expect(asSent).toBe(sentChart);
      expect(findNode(asSent, 'n1')?.title).toBe('Alpha');
      expect((result as ToCData).sections[0].title).toBe('Retitled by AI');
    },
    SLOW,
  );

  it(
    'shows an edit error and logs the failure when the app cannot use the edits',
    async () => {
      const onAIEdit = vi.fn(() => {
        throw new Error('Chart data is malformed: sections[0].columns is not an array');
      });
      renderChat(onAIEdit);

      sendChatMessage();
      await waitFor(() => expect(chatService.streamMessage).toHaveBeenCalledTimes(1), {
        timeout: 15_000,
      });
      streamed.resolve();

      expect(await screen.findByText(/Edit Error/, undefined, { timeout: 15_000 })).toBeVisible();
      expect(screen.getByText(/sections\[0\]\.columns is not an array/)).toBeVisible();
      expect(loggingService.logAIEdit).toHaveBeenCalledWith(
        expect.objectContaining({ success: false }),
      );
    },
    SLOW,
  );
});

describe('an AI reply in Generate mode', () => {
  it(
    'shows an edit error when the app cannot use the edits, as Chat mode does',
    async () => {
      const onAIEdit = vi.fn(() => {
        throw new Error('Chart data is malformed: sections[0].columns is not an array');
      });
      renderChat(onAIEdit);

      startGenerating();
      await waitFor(() => expect(chatService.streamMessage).toHaveBeenCalledTimes(1), {
        timeout: 15_000,
      });
      streamed.resolve();

      expect(await screen.findByText(/Edit Error/, undefined, { timeout: 15_000 })).toBeVisible();
      expect(screen.getByText(/sections\[0\]\.columns is not an array/)).toBeVisible();
    },
    SLOW,
  );
});
