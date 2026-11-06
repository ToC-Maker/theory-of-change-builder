// The public viewer route (/chart/:chartId) mounts no TopBar, so the
// "View-only" chip has to live on the viewer itself. Inside an iframe the
// viewer hides all its chrome (copy button, zoom controls, legend), and the
// chip with it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
  title: 'Viewer chart',
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

const renderViewer = () =>
  render(
    <MemoryRouter initialEntries={['/chart/c1']}>
      <App />
    </MemoryRouter>,
  );

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(ChartService, 'getChart').mockResolvedValue(chart as never);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// The full App tree renders on the first test, which is slow on a loaded machine.
const SLOW_RENDER_MS = 30_000;

describe('ToCViewerOnly read-only chip', () => {
  it(
    'shows a "View-only" chip next to the Make a Copy button',
    async () => {
      renderViewer();
      expect(
        await screen.findByRole('button', { name: /make a copy/i }, { timeout: SLOW_RENDER_MS }),
      ).toBeInTheDocument();
      expect(screen.getByText('View-only')).toBeInTheDocument();
    },
    SLOW_RENDER_MS,
  );

  it(
    'hides the chip inside an iframe, like the rest of the viewer chrome',
    async () => {
      const realSelf = Object.getOwnPropertyDescriptor(window, 'self');
      Object.defineProperty(window, 'self', { configurable: true, value: {} });
      try {
        renderViewer();
        expect(
          await screen.findByText('Funding', undefined, { timeout: SLOW_RENDER_MS }),
        ).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /make a copy/i })).toBeNull();
        expect(screen.queryByText('View-only')).toBeNull();
      } finally {
        if (realSelf) Object.defineProperty(window, 'self', realSelf);
      }
    },
    SLOW_RENDER_MS,
  );
});
