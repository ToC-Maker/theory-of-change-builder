// App's global Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y shortcuts, driven through
// the real App tree. With Shift (or Caps Lock) held the browser reports
// `event.key` as 'Z', so the handler has to compare the letter without case.
//
// The edit under test is "select all, then Delete" on a one-node chart: the node
// leaving and returning is the undo/redo effect, and the toolbar's Undo and Redo
// buttons show whether either stack holds a step.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../../src/App';
import { ChartService } from '../../src/services/chartService';
import type { ToCData } from '../../src/types';

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

const chart: ToCData = {
  title: 'Shortcut chart',
  sections: [
    {
      title: 'Inputs',
      columns: [
        {
          nodes: [
            {
              id: 'n-1',
              title: 'Funding',
              text: '',
              connectionIds: [],
              connections: [],
              yPosition: 100,
            },
          ],
        },
      ],
    },
  ],
};

// The full App tree renders on the first test, which is slow on a loaded machine.
const SLOW_RENDER_MS = 30_000;
// Per-assertion wait, generous for a loaded machine.
const WAIT = { timeout: 10_000 };

beforeEach(() => {
  localStorage.clear();
  // The load answers; the periodic sync that follows never hears back, so it
  // cannot overwrite an edit or an undo while the test runs.
  vi.spyOn(ChartService, 'getChartByEditToken')
    .mockResolvedValueOnce({
      chartData: structuredClone(chart),
      chartId: 'c1',
      isOwner: true,
    } as never)
    .mockImplementation(() => new Promise(() => {}));
  vi.spyOn(ChartService, 'updateChart').mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // jsdom lacks scrollIntoView (chat autoscroll) — stub it.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Presses a key the way a user does after clicking the chart: focus is off the
// chat box, which takes it back shortly after mount.
const pressOnCanvas = (init: KeyboardEventInit) => {
  (document.activeElement as HTMLElement).blur();
  press(init);
};

const press = (init: KeyboardEventInit) =>
  act(() => {
    fireEvent.keyDown(document.body, { bubbles: true, cancelable: true, ...init });
  });

// Renders the editor and makes one undoable edit by deleting the only node.
async function renderEditedChart() {
  render(
    <MemoryRouter initialEntries={['/edit/tok']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByText('Funding', undefined, { timeout: SLOW_RENDER_MS });
  // The chat box taking focus marks the end of the mount effects.
  await waitFor(() => expect(document.activeElement?.tagName).toBe('TEXTAREA'), WAIT);
  pressOnCanvas({ key: 'a', ctrlKey: true });
  pressOnCanvas({ key: 'Delete' });
  await waitFor(() => expect(screen.queryByText('Funding')).toBeNull(), WAIT);
  // The step reaches the undo stack once the 300 ms grouping window closes.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled(), WAIT);
  // That step was added by a timer, outside act: let React finish re-binding the
  // key listener to the handlers that can see it before the test presses a key.
  await act(async () => {});
}

const undoIsAvailable = () =>
  !(screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled;
const redoIsAvailable = () =>
  !(screen.getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled;

describe('App undo and redo keyboard shortcuts', () => {
  it(
    'Ctrl+Z undoes',
    async () => {
      await renderEditedChart();
      pressOnCanvas({ key: 'z', ctrlKey: true });
      expect(await screen.findByText('Funding', undefined, WAIT)).toBeInTheDocument();
      expect(redoIsAvailable()).toBe(true);
    },
    SLOW_RENDER_MS,
  );

  it(
    'Ctrl+Z with Caps Lock on (key "Z", no Shift) undoes',
    async () => {
      await renderEditedChart();
      pressOnCanvas({ key: 'Z', ctrlKey: true, shiftKey: false });
      expect(await screen.findByText('Funding', undefined, WAIT)).toBeInTheDocument();
      expect(redoIsAvailable()).toBe(true);
    },
    SLOW_RENDER_MS,
  );

  it.each([
    ['Ctrl+Shift+Z', { key: 'Z', ctrlKey: true, shiftKey: true }],
    ['Cmd+Shift+Z', { key: 'Z', metaKey: true, shiftKey: true }],
    ['Ctrl+Shift+Z with Caps Lock on (key "z")', { key: 'z', ctrlKey: true, shiftKey: true }],
    ['Ctrl+Y', { key: 'y', ctrlKey: true }],
    ['Ctrl+Y with Caps Lock on (key "Y")', { key: 'Y', ctrlKey: true }],
  ])(
    '%s redoes',
    async (_name, redoKey) => {
      await renderEditedChart();
      pressOnCanvas({ key: 'z', ctrlKey: true });
      await screen.findByText('Funding', undefined, WAIT);
      expect(redoIsAvailable()).toBe(true);

      pressOnCanvas(redoKey);
      await waitFor(() => expect(screen.queryByText('Funding')).toBeNull(), WAIT);
      expect(redoIsAvailable()).toBe(false);
      expect(undoIsAvailable()).toBe(true);
    },
    SLOW_RENDER_MS,
  );

  it(
    'leaves Ctrl+Z to a focused text field',
    async () => {
      await renderEditedChart();
      const field = document.createElement('input');
      field.type = 'text';
      document.body.appendChild(field);
      field.focus();
      try {
        press({ key: 'z', ctrlKey: true });
        press({ key: 'Z', ctrlKey: true, shiftKey: true });
        // The edit stays applied and its step stays on the undo stack.
        expect(screen.queryByText('Funding')).toBeNull();
        expect(undoIsAvailable()).toBe(true);
        expect(redoIsAvailable()).toBe(false);
      } finally {
        field.remove();
      }
    },
    SLOW_RENDER_MS,
  );
});
