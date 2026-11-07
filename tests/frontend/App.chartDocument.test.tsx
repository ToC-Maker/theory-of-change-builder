// How the editor route is wired to the chart document: what it loads, what the
// toolbar's undo, redo, pill and unload guard read, and what the chat, import
// and create flows hand to it. The real App, document, canvas and save/poll
// hooks run; the chat, toolbar and share dialog are stand-ins that record the
// props App gives them, so a test can call them the way those components do.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App';
import { ChartApiError, ChartService } from '../../src/services/chartService';
import type { ChartInput, ToCData } from '../../src/types';
import { normalizeChart } from '../../shared/chart-model';
import { findNode, node, nodesOf } from '../shared/chart-fixtures';

// App's children that this test only needs the props of.
const latest = vi.hoisted(() => ({
  chat: null as null | Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  top: null as null | Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
  share: null as null | Record<string, any>, // eslint-disable-line @typescript-eslint/no-explicit-any
}));
const chat = () => latest.chat!;
const top = () => latest.top!;

vi.mock('../../src/components/ChatInterface', async () => {
  const { useNavigate } = await import('react-router-dom');
  return {
    ChatInterface: (props: Record<string, unknown>) => {
      latest.chat = { ...props, navigate: useNavigate() };
      return null;
    },
  };
});
vi.mock('../../src/components/top-bar/TopBar', () => ({
  TopBar: (props: Record<string, unknown>) => {
    latest.top = props;
    return null;
  },
}));
vi.mock('../../src/components/share/ShareDialog', () => ({
  ShareDialog: (props: Record<string, unknown>) => {
    latest.share = props;
    return null;
  },
}));
vi.mock('../../src/components/GraphTutorial', () => ({ GraphTutorial: () => null }));
vi.mock('../../src/components/PrivacyPolicyPopup', () => ({ PrivacyPolicyPopup: () => null }));
vi.mock('../../src/components/SessionExpiredBanner', () => ({ SessionExpiredBanner: () => null }));

vi.mock('@auth0/auth0-react', () => {
  const auth = {
    isAuthenticated: false,
    isLoading: false,
    user: undefined,
    getIdTokenClaims: async () => undefined,
    getAccessTokenSilently: async () => 'token',
    loginWithRedirect: async () => {},
    logout: async () => {},
  };
  return { useAuth0: () => auth, Auth0Provider: ({ children }: { children: unknown }) => children };
});

vi.mock('../../src/services/loggingService', () => ({
  loggingService: {
    reportError: vi.fn(),
    getCurrentChartId: vi.fn(() => null),
    isOptedOut: vi.fn(() => true),
    isLoggingEnabled: vi.fn(() => false),
    getCurrentSessionId: vi.fn(() => null),
    saveSnapshotDebounced: vi.fn(),
    flushPendingSnapshot: vi.fn(),
    endSession: vi.fn(),
    endSessionBeacon: vi.fn(),
    resetSessionTimeout: vi.fn(),
    syncPreferenceFromServer: vi.fn(),
  },
  LoggingServiceClass: { setAuthTokenProvider: vi.fn(), setAuthToken: vi.fn() },
}));

const CHART: ToCData = normalizeChart({
  title: 'T',
  sections: [
    {
      id: 's1',
      title: 'One',
      columns: [
        {
          id: 'c1',
          nodes: [node('n1', 100, { title: 'Alpha' }), node('n2', 300, { title: 'Beta' })],
        },
      ],
    },
  ],
});

// The first render of the whole App is slow on a loaded machine.
const SLOW = 30_000;

let update: ReturnType<typeof vi.spyOn<typeof ChartService, 'updateChart'>>;
let poll: ReturnType<typeof vi.spyOn<typeof ChartService, 'pollChart'>>;

beforeEach(() => {
  latest.chat = latest.top = latest.share = null;
  localStorage.clear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(ChartService, 'getChartByEditToken').mockResolvedValue({
    chartData: CHART,
    chartId: 'chart-1',
    canEdit: true,
    isOwner: true,
    version: 7,
  });
  update = vi
    .spyOn(ChartService, 'updateChart')
    .mockImplementation(async (_token, _chart, base) => ({ status: 'saved', version: base + 1 }));
  poll = vi
    .spyOn(ChartService, 'pollChart')
    .mockImplementation(async (_token, known) => ({ version: known }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openEditor(path = '/edit/tok') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  // The toolbar mounts once the chart has loaded. Its store subscriptions are
  // made by effects after that commit, so let them run before a test edits.
  await waitFor(() => expect(latest.top).not.toBeNull(), { timeout: SLOW });
  await act(async () => {});
}

const committed = (): ToCData => chat().graphData;
const sentCharts = () => update.mock.calls.map(([, chart, base]) => ({ chart, base }));
// Generous: on a loaded machine the canvas re-renders and the save debounce come due late.
const shown = (text: string) => screen.findByText(text, undefined, { timeout: 15_000 });
const savedOnce = () => waitFor(() => expect(update).toHaveBeenCalledTimes(1), { timeout: 15_000 });

describe('the editor route and the chart document', () => {
  it(
    'loads the chart with its server version and saves an edit on that version',
    async () => {
      await openEditor();
      expect(top().hasPendingChanges).toBe(false);

      act(() => top().setTextSize(1.5));
      expect(top().hasPendingChanges).toBe(true);

      await savedOnce();
      expect(update.mock.calls[0][0]).toBe('tok');
      expect(update.mock.calls[0][2]).toBe(7);
      expect(update.mock.calls[0][1].textSize).toBe(1.5);
      await waitFor(() => expect(top().hasPendingChanges).toBe(false));
    },
    SLOW,
  );

  it(
    'keeps the open document, and what is unsaved in it, when the load runs again',
    async () => {
      // The load effect re-runs when the location state or the auth state changes.
      let finishSave!: () => void;
      update.mockImplementationOnce(
        (_token, _chart, base) =>
          new Promise((resolve) => {
            finishSave = () => resolve({ status: 'saved', version: base + 1 });
          }),
      );
      await openEditor();
      act(() => top().setTextSize(1.5));
      await savedOnce();
      const alpha = screen.getByText('Alpha');
      const loads = vi.mocked(ChartService.getChartByEditToken).mock.calls.length;

      act(() => chat().navigate('/edit/tok', { replace: true, state: { again: true } }));
      await waitFor(() =>
        expect(vi.mocked(ChartService.getChartByEditToken).mock.calls.length).toBe(loads + 1),
      );

      // No loading screen in between, and the edit is still there and still being saved.
      expect(document.contains(alpha)).toBe(true);
      expect(committed().textSize).toBe(1.5);
      expect(top().hasPendingChanges).toBe(true);
      await act(async () => finishSave());
      await waitFor(() => expect(top().hasPendingChanges).toBe(false));
    },
    SLOW,
  );

  it(
    'undoes and redoes through the document, from the toolbar and from the keyboard',
    async () => {
      await openEditor();
      expect(top().canUndo).toBe(false);
      act(() => top().setTextSize(1.5));
      expect(top().canUndo).toBe(true);
      expect(top().canRedo).toBe(false);

      act(() => top().handleUndo());
      expect(committed().textSize).toBe(CHART.textSize);
      expect(top().canUndo).toBe(false);
      expect(top().canRedo).toBe(true);

      act(() => top().handleRedo());
      expect(committed().textSize).toBe(1.5);

      fireEvent.keyDown(document, { key: 'z', ctrlKey: true });
      expect(committed().textSize).toBe(CHART.textSize);
      fireEvent.keyDown(document, { key: 'z', ctrlKey: true, shiftKey: true });
      expect(committed().textSize).toBe(1.5);
    },
    SLOW,
  );

  it(
    'leaves undo to a focused text field',
    async () => {
      await openEditor();
      act(() => top().setTextSize(1.5));
      const input = document.createElement('input');
      document.body.appendChild(input);
      input.focus();

      act(() => top().handleUndo());
      expect(committed().textSize).toBe(1.5);

      input.remove();
    },
    SLOW,
  );

  it(
    'warns before unload while a save is outstanding, and not after',
    async () => {
      let finishSave!: () => void;
      update.mockImplementationOnce(
        (_token, _chart, base) =>
          new Promise((resolve) => {
            finishSave = () => resolve({ status: 'saved', version: base + 1 });
          }),
      );
      await openEditor();
      const unload = () => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      };
      expect(unload()).toBe(false);

      act(() => top().setTextSize(1.5));
      expect(unload()).toBe(true);
      await savedOnce();
      expect(unload()).toBe(true);

      await act(async () => finishSave());
      await waitFor(() => expect(unload()).toBe(false));
    },
    SLOW,
  );

  it(
    'shows why the chart cannot be loaded when the server returns no version',
    async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(ChartService.getChartByEditToken).mockRejectedValue(
        new ChartApiError('The server did not return a chart version', 200),
      );
      render(
        <MemoryRouter initialEntries={['/edit/tok']}>
          <App />
        </MemoryRouter>,
      );

      expect(
        await screen.findByText(/did not return a chart version/i, undefined, { timeout: SLOW }),
      ).toBeInTheDocument();
      expect(screen.getByText(/Unable to Load Chart/i)).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    'shows a chart the server holds in a shape it cannot read as a load error',
    async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(ChartService.getChartByEditToken).mockRejectedValue(
        new (await import('../../shared/chart-model')).ChartShapeError(
          {},
          'sections[0].columns is not an array',
        ),
      );
      render(
        <MemoryRouter initialEntries={['/edit/tok']}>
          <App />
        </MemoryRouter>,
      );

      expect(
        await screen.findByText(/sections\[0\]\.columns is not an array/, undefined, {
          timeout: SLOW,
        }),
      ).toBeInTheDocument();
    },
    SLOW,
  );
});

describe('what the chat, import and generate flows hand to the document', () => {
  const retitleFirst = (chart: ToCData, title: string): ChartInput => {
    const result = structuredClone(chart) as ChartInput;
    result.sections[0].columns[0].nodes[0].title = title;
    return result;
  };

  it(
    'merges an AI edit computed against the chart as sent, and returns what it applied',
    async () => {
      await openEditor();
      const asSent = committed();

      const applied = chat().onAIEdit(asSent, retitleFirst(asSent, 'Alpha by AI')) as ToCData;

      expect(findNode(applied, 'n1')?.title).toBe('Alpha by AI');
      expect(await shown('Alpha by AI')).toBeInTheDocument();
      expect(findNode(committed(), 'n1')?.title).toBe('Alpha by AI');
      await savedOnce();
      expect(findNode(sentCharts()[0].chart, 'n1')?.title).toBe('Alpha by AI');
    },
    SLOW,
  );

  it(
    'keeps an edit made while the reply was streaming',
    async () => {
      await openEditor();
      const asSent = committed();
      act(() => top().setTextSize(1.7));

      act(() => void chat().onAIEdit(asSent, retitleFirst(asSent, 'Alpha by AI')));

      expect(findNode(committed(), 'n1')?.title).toBe('Alpha by AI');
      expect(committed().textSize).toBe(1.7);
    },
    SLOW,
  );

  it(
    'lets a result that is not a chart fail the edit, for the chat to report',
    async () => {
      await openEditor();
      const bad = { sections: [{ title: 'S', columns: 'oops' }] } as unknown as ChartInput;

      expect(() => chat().onAIEdit(committed(), bad)).toThrow(/columns is not an array/);
      expect(findNode(committed(), 'n1')?.title).toBe('Alpha');
    },
    SLOW,
  );

  it(
    'loads a generated chart as the whole chart, with ids, and undo brings the old one back',
    async () => {
      await openEditor();
      const generated: ChartInput = {
        title: 'Generated',
        sections: [{ title: 'Inputs', columns: [{ nodes: [node('g1', 100, { title: 'Gen' })] }] }],
      };

      act(() => chat().onLoadGeneratedGraph(generated));

      expect(await shown('Gen')).toBeInTheDocument();
      expect(screen.queryByText('Alpha')).toBeNull();
      expect(committed().sections.map((s) => s.id)).toEqual(['s0']);

      act(() => top().handleUndo());
      expect(await shown('Alpha')).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    'imports a file as the whole chart, and ignores one that is not a chart',
    async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await openEditor();

      act(() => top().onImportJson({ sections: 'nope' }));
      expect(nodesOf(committed()).map((n) => n.id)).toEqual(['n1', 'n2']);

      const file: ChartInput = {
        title: 'Imported',
        sections: [
          { title: 'Only', columns: [{ nodes: [node('f1', 100, { title: 'From the file' })] }] },
        ],
      };
      act(() => top().onImportJson(normalizeChart(file)));

      expect(await shown('From the file')).toBeInTheDocument();
      expect(screen.queryByText('Alpha')).toBeNull();
      await savedOnce();
      expect(sentCharts()[0].base).toBe(7);
      expect(nodesOf(sentCharts()[0].chart).map((n) => n.id)).toEqual(['f1']);
    },
    SLOW,
  );
});

describe('a chart that does not exist on the server yet', () => {
  it(
    'keeps edits made while the chart is being created and sends them on the created version',
    async () => {
      await openEditor('/');
      expect(top().currentEditToken).toBeNull();
      const asCreated = committed();

      // The user edits while createChart is out.
      act(() => top().setTextSize(1.2));
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(update).not.toHaveBeenCalled();

      act(() =>
        chat().onChartCreated({
          editToken: 'new-token',
          chartId: 'new-chart',
          version: 1,
          chart: asCreated,
        }),
      );

      expect(top().currentEditToken).toBe('new-token');
      await savedOnce();
      expect(update.mock.calls[0][0]).toBe('new-token');
      expect(update.mock.calls[0][2]).toBe(1);
      expect(update.mock.calls[0][1].textSize).toBe(1.2);
    },
    SLOW,
  );

  it(
    'keeps a local copy of the chart that has no server yet',
    async () => {
      await openEditor('/');

      act(() => top().setTextSize(1.2));

      await waitFor(() => {
        const saved = JSON.parse(localStorage.getItem('toc_graph_default') ?? '{}');
        expect(saved.textSize).toBe(1.2);
      });
    },
    SLOW,
  );

  it(
    'hands the share dialog a way to attach the created chart too',
    async () => {
      await openEditor('/');
      const asCreated = committed();

      act(() =>
        latest.share!.onChartCreated({
          editToken: 'shared-token',
          chartId: 'shared-chart',
          version: 1,
          chart: asCreated,
        }),
      );

      expect(top().currentEditToken).toBe('shared-token');
      expect(top().currentChartId).toBe('shared-chart');
    },
    SLOW,
  );
});

describe('a chart from someone else that cannot be used', () => {
  it(
    'shows in the save pill, as the poll finds it',
    async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      // The save is refused for good (a 400 is not retried), so the local edit
      // stays unsaved and a landing needs a real merge; the chart below has two
      // sections with one id, which the merge refuses.
      update.mockRejectedValue(new ChartApiError('Bad request', 400));
      await openEditor();
      act(() => top().setTextSize(1.5));
      await waitFor(() => expect(top().saveError?.message).toBe('Bad request'), {
        timeout: 15_000,
      });
      const broken = structuredClone(CHART);
      broken.sections.push(structuredClone(broken.sections[0]));
      poll.mockResolvedValue({ version: 20, chartData: broken });

      await waitFor(() => expect(top().saveError?.message).toMatch(/repeats section id/), {
        timeout: 20_000,
      });
    },
    SLOW,
  );
});
