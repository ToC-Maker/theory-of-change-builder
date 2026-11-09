// Tests for FileMenu inline (accordion) submenus — K3.
//
// Inside MobileMenu's w-72 drawer the desktop side flyouts
// (`absolute left-56`, Open recent w-80 = 320px) land mostly outside
// a phone viewport: measured at 390x844, the Open recent flyout
// rendered at x 335..655 (265px off-screen). On mobile the submenus
// must instead expand IN FLOW below their parent item (accordion),
// which can never be clipped horizontally.
//
// The mode is an explicit `inlineSubmenus` prop passed by MobileMenu:
// - not keyed off uncontrolled mode, because tests (and any future
//   caller) use uncontrolled FileMenu to exercise desktop flyouts;
// - not a viewport query inside FileMenu, because TopBar already
//   centralizes the breakpoint decision ("children stay simple, no
//   per-component matchMedia" — TopBar.tsx header).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FileMenu } from '../../src/components/top-bar/FileMenu';
import { MobileMenu } from '../../src/components/top-bar/MobileMenu';
import type { ComponentProps } from 'react';

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    user: null,
    isAuthenticated: false,
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
  // Some children (FormatMenu et al.) may consult matchMedia.
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    }),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

const renderMenu = (props: Partial<FileMenuProps> = {}) =>
  render(
    <MemoryRouter>
      <FileMenu {...baseProps} {...props} />
    </MemoryRouter>,
  );

const openFileMenu = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: /file/i }));
  return screen.getByTestId('file-menu-open-recent').closest('[role="menu"]') as HTMLElement;
};

describe('FileMenu inline submenus (K3 — mobile drawer accordion)', () => {
  it('renders Open recent IN FLOW inside the menu panel, not as an absolute side flyout', async () => {
    const user = userEvent.setup();
    renderMenu({ inlineSubmenus: true });
    const panel = await openFileMenu(user);

    await user.click(screen.getByTestId('file-menu-open-recent'));
    const flyout = await screen.findByTestId('file-menu-recent-flyout');

    // Accordion: the submenu is a child of the main menu panel...
    expect(panel.contains(flyout)).toBe(true);
    // ...and is not absolutely positioned off the panel's right edge.
    expect(flyout.className).not.toMatch(/absolute/);
    expect(flyout.className).not.toMatch(/left-56/);
    // Anonymous + empty localStorage -> the empty state renders inline.
    expect(flyout).toHaveTextContent(/no local charts/i);
  });

  it('renders Export entries IN FLOW inside the menu panel', async () => {
    const user = userEvent.setup();
    renderMenu({ inlineSubmenus: true, data: { sections: [] } });
    const panel = await openFileMenu(user);

    await user.click(screen.getByTestId('file-menu-export'));
    const flyout = screen.getByTestId('file-menu-export-flyout');

    expect(panel.contains(flyout)).toBe(true);
    expect(flyout.className).not.toMatch(/absolute/);
    expect(screen.getByTestId('file-menu-export-json')).toBeInTheDocument();
    expect(screen.getByTestId('file-menu-export-png')).toBeInTheDocument();
    expect(screen.getByTestId('file-menu-export-pdf')).toBeInTheDocument();
  });

  it('toggles: clicking the open parent again collapses the accordion', async () => {
    const user = userEvent.setup();
    renderMenu({ inlineSubmenus: true, data: { sections: [] } });
    await openFileMenu(user);

    const exportItem = screen.getByTestId('file-menu-export');
    await user.click(exportItem);
    expect(screen.getByTestId('file-menu-export-flyout')).toBeInTheDocument();
    expect(exportItem).toHaveAttribute('aria-expanded', 'true');

    await user.click(exportItem);
    expect(screen.queryByTestId('file-menu-export-flyout')).toBeNull();
    expect(exportItem).toHaveAttribute('aria-expanded', 'false');
  });

  it('switching parents swaps which submenu is expanded', async () => {
    const user = userEvent.setup();
    renderMenu({ inlineSubmenus: true, data: { sections: [] } });
    await openFileMenu(user);

    await user.click(screen.getByTestId('file-menu-open-recent'));
    expect(await screen.findByTestId('file-menu-recent-flyout')).toBeInTheDocument();

    await user.click(screen.getByTestId('file-menu-export'));
    expect(screen.getByTestId('file-menu-export-flyout')).toBeInTheDocument();
    expect(screen.queryByTestId('file-menu-recent-flyout')).toBeNull();
  });

  it('default (desktop) mode still renders the flyout as a sibling outside the panel', async () => {
    const user = userEvent.setup();
    renderMenu({ data: { sections: [] } });
    const panel = await openFileMenu(user);

    await user.click(screen.getByTestId('file-menu-export'));
    const flyout = screen.getByTestId('file-menu-export-flyout');

    expect(panel.contains(flyout)).toBe(false);
    expect(flyout.className).toMatch(/absolute/);
    expect(flyout.className).toMatch(/left-56/);
  });
});

describe('MobileMenu wires FileMenu into inline-submenu mode (K3)', () => {
  const noop = () => {};
  const mobileProps: ComponentProps<typeof MobileMenu> = {
    isSaving: false,
    hasEditToken: true,
    saveError: null,
    hasPendingChanges: false,
    isAuthenticated: false,
    isOwner: false,
    currentEditToken: 'tok-abc',
    currentChartId: 'chart-xyz',
    onDeleteChart: noop,
    data: { sections: [] },
    editMode: true,
    fontFamily: "'Roboto', sans-serif",
    setFontFamily: noop,
    textSize: 1,
    setTextSize: noop,
    curvature: 0.5,
    setCurvature: noop,
    columnPadding: 16,
    setColumnPadding: noop,
    sectionPadding: 16,
    setSectionPadding: noop,
    onShareClick: noop,
  };

  it('Open recent expands inside the drawer FileMenu panel instead of flying out', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <MobileMenu {...mobileProps} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: /open menu/i }));
    await user.click(screen.getByRole('button', { name: /file/i }));
    const panel = screen
      .getByTestId('file-menu-open-recent')
      .closest('[role="menu"]') as HTMLElement;

    await user.click(screen.getByTestId('file-menu-open-recent'));
    const flyout = await screen.findByTestId('file-menu-recent-flyout');

    expect(panel.contains(flyout)).toBe(true);
    expect(flyout.className).not.toMatch(/absolute/);
  });
});
