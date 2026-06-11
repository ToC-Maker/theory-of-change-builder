// Tests for FileMenu side-flyout vertical alignment (PR 7 feedback (62)).
//
// The Open recent / Export flyouts must start at their parent menu
// item, not at the top of the main menu panel. Positioning is computed
// by `computeFlyoutTop` (pure) and wired into the flyout's inline
// `top` style via offsetTop measurements in a layout effect.
//
// jsdom has no layout (offsetTop / getBoundingClientRect return 0), so
// the wiring tests mock those per-element. The math itself is covered
// by the pure-function tests.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FileMenu } from '../../src/components/top-bar/FileMenu';
import {
  computeFlyoutTop,
  FLYOUT_FIRST_ITEM_INSET_PX,
  FLYOUT_VIEWPORT_MARGIN_PX,
} from '../../src/components/top-bar/flyoutPosition';
import type { ComponentProps } from 'react';

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    user: { sub: 'auth0|test-user' },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

type FileMenuProps = ComponentProps<typeof FileMenu>;

const baseProps: FileMenuProps = {
  isAuthenticated: false,
  isOwner: false,
  currentEditToken: 'tok-abc',
  currentChartId: 'chart-xyz',
  onDeleteChart: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderMenu = (props: Partial<FileMenuProps> = {}) =>
  render(
    <MemoryRouter>
      <FileMenu {...baseProps} {...props} />
    </MemoryRouter>,
  );

describe('computeFlyoutTop (pure)', () => {
  // Real numbers from the live repro: bar button root at viewport
  // y=10, panel offsetTop 36 (32px trigger + 4px gap), Export item
  // offsetTop 112. First-item alignment puts the flyout at
  // 36 + 112 - 4 = 144 within the containing block.
  const base = {
    panelOffsetTop: 36,
    itemOffsetTop: 112,
    flyoutHeight: 118,
    anchorTop: 10,
    viewportHeight: 720,
  };

  it('aligns the flyout first item with the parent item when space allows', () => {
    expect(computeFlyoutTop(base)).toBe(36 + 112 - FLYOUT_FIRST_ITEM_INSET_PX);
  });

  it('clamps so the flyout does not overflow the viewport bottom', () => {
    // Tall flyout (Open recent with many charts): 600px against a
    // 720px viewport. maxTop = 720 - margin - 600 - 10.
    const top = computeFlyoutTop({ ...base, flyoutHeight: 600 });
    expect(top).toBe(720 - FLYOUT_VIEWPORT_MARGIN_PX - 600 - 10);
    expect(top).toBeLessThan(36 + 112 - FLYOUT_FIRST_ITEM_INSET_PX);
  });

  it('never rises above the main panel top, even when the flyout is taller than the viewport', () => {
    // Degenerate: flyout taller than the whole viewport. The clamp
    // would want a negative top; floor at the panel top instead.
    expect(computeFlyoutTop({ ...base, flyoutHeight: 5000 })).toBe(36);
  });

  it('returns the desired position for the first item (offsetTop 0)', () => {
    // Parent item is the first row: desired = panelOffsetTop - inset,
    // floored at panelOffsetTop... desired (36 - 4 = 32) is below the
    // floor (36)? No: floor is panelOffsetTop = 36, desired = 32, so
    // the floor wins. The flyout never starts above the panel.
    expect(computeFlyoutTop({ ...base, itemOffsetTop: 0 })).toBe(36);
  });
});

describe('FileMenu flyout alignment wiring (PR 7 feedback (62))', () => {
  it('positions the Export flyout at the Export item, not the panel top', async () => {
    const user = userEvent.setup();
    renderMenu({ data: { sections: [] } });
    await user.click(screen.getByRole('button', { name: /file/i }));

    // Only the main panel is open at this point.
    const panel = screen.getByRole('menu');
    const exportItem = screen.getByTestId('file-menu-export');
    Object.defineProperty(panel, 'offsetTop', { value: 36, configurable: true });
    Object.defineProperty(exportItem, 'offsetTop', { value: 112, configurable: true });

    await user.click(exportItem);

    const flyout = screen.getByTestId('file-menu-export-flyout');
    // 36 + 112 - inset(4) = 144. Before the fix the flyout used
    // `top-full mt-1` (panel-top alignment) and had no inline top.
    expect(flyout.style.top).toBe('144px');
  });

  it('clamps the flyout top when it would overflow the viewport bottom', async () => {
    const user = userEvent.setup();
    renderMenu({ data: { sections: [] } });
    await user.click(screen.getByRole('button', { name: /file/i }));

    const panel = screen.getByRole('menu');
    const exportItem = screen.getByTestId('file-menu-export');
    Object.defineProperty(panel, 'offsetTop', { value: 36, configurable: true });
    Object.defineProperty(exportItem, 'offsetTop', { value: 112, configurable: true });

    // Pretend the flyout renders 200px tall in a 300px viewport.
    const innerHeightSpy = vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(300);
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        const height = this.dataset?.testid === 'file-menu-export-flyout' ? 200 : 0;
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: height,
          width: 0,
          height,
          toJSON: () => ({}),
        } as DOMRect;
      });

    await user.click(exportItem);

    const flyout = screen.getByTestId('file-menu-export-flyout');
    // desired = 144, maxTop = 300 - 8 - 200 - 0 = 92 -> clamped.
    expect(flyout.style.top).toBe('92px');

    rectSpy.mockRestore();
    innerHeightSpy.mockRestore();
  });

  it('positions the Open recent flyout at its parent item too', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: /file/i }));

    const panel = screen.getByRole('menu');
    const recentItem = screen.getByTestId('file-menu-open-recent');
    Object.defineProperty(panel, 'offsetTop', { value: 36, configurable: true });
    Object.defineProperty(recentItem, 'offsetTop', { value: 40, configurable: true });

    await user.click(recentItem);

    const flyout = await screen.findByTestId('file-menu-recent-flyout');
    expect(flyout.style.top).toBe(`${36 + 40 - FLYOUT_FIRST_ITEM_INSET_PX}px`);
  });
});
