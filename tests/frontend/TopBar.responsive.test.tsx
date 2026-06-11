// Tests for the responsive TopBar shell.
//
// At md+ (>=768px) the bar shows the full set of controls (FileMenu,
// FormatMenu, HelpPanel, Save indicator, Share, Profile). Below md it
// collapses into a hamburger that opens a MobileMenu carrying the same
// contents.
//
// We don't assert pixel-perfect placement here; preflight + manual
// smoke testing covers visual regressions. These tests only verify the
// breakpoint switch and that the hamburger drawer renders the expected
// content list.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, cleanup, fireEvent, createEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TopBar, MENUBAR_GRACE_CLOSE_MS } from '../../src/components/top-bar/TopBar';

const noop = () => {};

const defaultProps = {
  // Mode + selection.
  editMode: true,
  showEditButton: true,
  // Undo / redo.
  undoHistory: [] as never[],
  redoHistory: [] as never[],
  handleUndo: noop,
  handleRedo: noop,
  // Save status.
  isSaving: false,
  saveError: null,
  currentEditToken: 'tok-abc',
  // FormatMenu controls — passed through.
  curvature: 0.5,
  setCurvature: noop,
  textSize: 1,
  setTextSize: noop,
  fontFamily: "'Roboto', sans-serif",
  setFontFamily: noop,
  columnPadding: 16,
  setColumnPadding: noop,
  sectionPadding: 16,
  setSectionPadding: noop,
};

// Polyfill matchMedia in jsdom (tests pass a width via the breakpoint
// override prop, but components may also call matchMedia defensively).
beforeEach(() => {
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
});

const renderWithRouter = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('TopBar responsive layout', () => {
  it('renders the full bar at md+ widths', () => {
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);
    // Full-bar surface: FileMenu, FormatMenu, HelpPanel buttons + Share.
    expect(screen.getByRole('button', { name: /file/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /format/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /help/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /share/i })).toBeInTheDocument();
    // No hamburger when full bar is showing.
    expect(screen.queryByRole('button', { name: /open menu/i })).toBeNull();
  });

  it('collapses to a hamburger below md', () => {
    renderWithRouter(<TopBar {...defaultProps} breakpoint="sm" />);
    expect(screen.getByRole('button', { name: /open menu/i })).toBeInTheDocument();
    // Inline menu buttons are NOT rendered when collapsed.
    expect(screen.queryByRole('button', { name: /^file$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^format$/i })).toBeNull();
  });

  it('opens the MobileMenu with all expected sections when hamburger is clicked', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar {...defaultProps} breakpoint="sm" />);

    await user.click(screen.getByRole('button', { name: /open menu/i }));

    // The mobile drawer carries File, Format, Help, Share — but NOT
    // a mode toggle (deleted in PR 1) and NOT a sync button. Each
    // section renders a heading + the menu, so `File` etc. appear
    // multiple times; we only assert presence.
    expect(screen.getAllByText(/^file$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^format$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^help$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^share$/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/editing\/viewing/i)).toBeNull();
    expect(screen.queryByText(/sync now/i)).toBeNull();
  });

  it('renders a read-only badge when showEditButton=false', () => {
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" showEditButton={false} />);
    expect(screen.getByText(/view.?only|read.?only/i)).toBeInTheDocument();
  });

  it('calls preventDefault on undo/redo mousedown so text-input focus survives', () => {
    // L2 mitigation: clicking the toolbar undo/redo while a text input
    // is focused must not steal focus before handleUndo / handleRedo
    // read document.activeElement via isInputFocused(). Dropping the
    // onMouseDown.preventDefault() handlers regresses this — and the
    // user's typed text gets replaced by an unrelated graph undo.
    renderWithRouter(
      <TopBar
        {...defaultProps}
        breakpoint="md"
        undoHistory={[{ sections: [], title: 'x' } as never]}
        redoHistory={[{ sections: [], title: 'y' } as never]}
      />,
    );
    const undoBtn = screen.getByRole('button', { name: /^undo$/i });
    const redoBtn = screen.getByRole('button', { name: /^redo$/i });

    const undoEvent = createEvent.mouseDown(undoBtn);
    fireEvent(undoBtn, undoEvent);
    expect(undoEvent.defaultPrevented).toBe(true);

    const redoEvent = createEvent.mouseDown(redoBtn);
    fireEvent(redoBtn, redoEvent);
    expect(redoEvent.defaultPrevented).toBe(true);
  });

  it('switches to the hamburger when window resizes below md', () => {
    // useBreakpoint listens to `resize` and flips between sm/md. The
    // existing tests force the breakpoint via prop; this one exercises
    // the production listener path so a regression in the deps array
    // or initial-state computation surfaces here.
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1200,
    });
    renderWithRouter(<TopBar {...defaultProps} />);
    expect(screen.getByRole('button', { name: /file/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open menu/i })).toBeNull();

    act(() => {
      Object.defineProperty(window, 'innerWidth', {
        writable: true,
        configurable: true,
        value: 500,
      });
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByRole('button', { name: /open menu/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^file$/i })).toBeNull();
  });

  it('hides the pending-request badge when count is 0', () => {
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" pendingRequestCount={0} />);
    // The badge is identified by its aria-label.
    expect(screen.queryByLabelText(/pending access request/i)).toBeNull();
  });

  it('renders a pending-request badge with the count when > 0', () => {
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" pendingRequestCount={3} />);
    const badge = screen.getByLabelText(/3 pending access requests/i);
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toBe('3');
  });

  it('clamps the pending-request badge at 9+', () => {
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" pendingRequestCount={42} />);
    const badge = screen.getByLabelText(/42 pending access requests/i);
    expect(badge.textContent).toBe('9+');
  });

  it('renders a stale indicator on the badge when pendingRequestCountStale is true', () => {
    renderWithRouter(
      <TopBar
        {...defaultProps}
        breakpoint="md"
        pendingRequestCount={3}
        pendingRequestCountStale={true}
      />,
    );
    const badge = screen.getByLabelText(/may be stale/i);
    expect(badge).toBeInTheDocument();
  });

  it('does not render a stale indicator when pendingRequestCountStale is false', () => {
    renderWithRouter(
      <TopBar
        {...defaultProps}
        breakpoint="md"
        pendingRequestCount={3}
        pendingRequestCountStale={false}
      />,
    );
    expect(screen.queryByLabelText(/may be stale/i)).toBeNull();
    // Original badge still present and non-stale.
    expect(screen.getByLabelText(/3 pending access requests$/i)).toBeInTheDocument();
  });
});

describe('TopBar menubar hover-switch (PR 7 feedback (37))', () => {
  // Helper: grab a top-level menubar button by label (case-insensitive
  // exact-ish match). Multiple matches may exist when a menu is open
  // (the popover heading may also be a "file" text node); we want the
  // trigger, which is the one with `aria-haspopup`.
  const trigger = (label: 'File' | 'Format' | 'Help') => {
    const matches = screen.getAllByRole('button', { name: new RegExp(`^${label}$`, 'i') });
    const haspopup = matches.find((el) => el.getAttribute('aria-haspopup') === 'menu');
    if (!haspopup) throw new Error(`no aria-haspopup trigger for "${label}"`);
    return haspopup;
  };
  const expanded = (label: 'File' | 'Format' | 'Help') =>
    trigger(label).getAttribute('aria-expanded');

  it('opens File on click and leaves siblings closed', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);

    expect(expanded('File')).toBe('false');
    await user.click(trigger('File'));
    expect(expanded('File')).toBe('true');
    expect(expanded('Format')).toBe('false');
    expect(expanded('Help')).toBe('false');
  });

  it('switches the open menu on hover when a sibling is already open', async () => {
    // The bug from PR 7 feedback (37): once any menubar item is open,
    // hovering a sibling should switch the open dropdown without a
    // re-click. The lifted `openMenuId` state in TopBar makes this
    // work; before the fix, each menu owned its own boolean and
    // hovers on siblings did nothing.
    const user = userEvent.setup();
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);
    await user.click(trigger('File'));
    expect(expanded('File')).toBe('true');

    await user.hover(trigger('Format'));
    expect(expanded('File')).toBe('false');
    expect(expanded('Format')).toBe('true');
    expect(expanded('Help')).toBe('false');

    await user.hover(trigger('Help'));
    expect(expanded('File')).toBe('false');
    expect(expanded('Format')).toBe('false');
    expect(expanded('Help')).toBe('true');
  });

  it('does NOT open a menu on hover when no sibling is already open', async () => {
    // Casual mouse-over with all menus closed should be inert. A
    // user crossing the menubar to reach the undo button shouldn't
    // pop up menus they didn't ask for. The hover-switch only
    // activates after a click has put us into "menubar navigation
    // mode" (i.e. some sibling is already open).
    const user = userEvent.setup();
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);

    await user.hover(trigger('File'));
    expect(expanded('File')).toBe('false');
    await user.hover(trigger('Format'));
    expect(expanded('Format')).toBe('false');
  });

  it('closes the open menu on Escape', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);
    await user.click(trigger('File'));
    expect(expanded('File')).toBe('true');

    await user.keyboard('{Escape}');
    expect(expanded('File')).toBe('false');
  });

  it('closes Format and Help on Escape too (each menu owns its Escape)', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);
    await user.click(trigger('Format'));
    expect(expanded('Format')).toBe('true');
    await user.keyboard('{Escape}');
    expect(expanded('Format')).toBe('false');

    await user.click(trigger('Help'));
    expect(expanded('Help')).toBe('true');
    await user.keyboard('{Escape}');
    expect(expanded('Help')).toBe('false');
  });

  it('Escape ladder survives the controlled path: first Esc closes the flyout only', async () => {
    // Regression (pre-existing at ff25f99, surfaced while verifying
    // (44)): TopBar's old centralized Escape listener fired alongside
    // FileMenu's flyout-aware handler, so the first Esc closed the
    // whole menu instead of just the flyout. Escape handling now
    // lives with each menu (FileMenu keeps the two-step ladder).
    const user = userEvent.setup();
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);
    await user.click(trigger('File'));
    await user.click(screen.getByTestId('file-menu-export'));
    expect(screen.getByTestId('file-menu-export-flyout')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    // Flyout closed, menu still open.
    expect(screen.queryByTestId('file-menu-export-flyout')).toBeNull();
    expect(expanded('File')).toBe('true');

    await user.keyboard('{Escape}');
    expect(expanded('File')).toBe('false');
  });

  it('toggles closed when the open menu trigger is clicked again', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);
    await user.click(trigger('Format'));
    expect(expanded('Format')).toBe('true');

    await user.click(trigger('Format'));
    expect(expanded('Format')).toBe('false');
  });
});

describe('TopBar menubar grace-close on pointer exit (PR 7 feedback (44))', () => {
  // Same trigger helper as the hover-switch suite above.
  const trigger = (label: 'File' | 'Format' | 'Help') => {
    const matches = screen.getAllByRole('button', { name: new RegExp(`^${label}$`, 'i') });
    const haspopup = matches.find((el) => el.getAttribute('aria-haspopup') === 'menu');
    if (!haspopup) throw new Error(`no aria-haspopup trigger for "${label}"`);
    return haspopup;
  };
  const expanded = (label: 'File' | 'Format' | 'Help') =>
    trigger(label).getAttribute('aria-expanded');

  // userEvent's internal delays deadlock under vi.useFakeTimers(), so
  // these tests drive React's enter/leave synthesis directly: React
  // derives onPointerEnter/onPointerLeave from pointerover/pointerout
  // + relatedTarget. `pointerOut(el, {relatedTarget: document.body})`
  // = the pointer left `el`'s whole ancestor chain for the page;
  // `pointerOver(el, {relatedTarget: document.body})` = it came back.
  const leaveToPage = (el: Element) => fireEvent.pointerOut(el, { relatedTarget: document.body });
  const enterFromPage = (el: Element) =>
    fireEvent.pointerOver(el, { relatedTarget: document.body });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes the open menu after the grace delay once the pointer leaves the menubar', () => {
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);

    fireEvent.click(trigger('File'));
    expect(expanded('File')).toBe('true');

    leaveToPage(trigger('File'));
    // Still open within the grace window…
    act(() => vi.advanceTimersByTime(MENUBAR_GRACE_CLOSE_MS - 100));
    expect(expanded('File')).toBe('true');
    // …closed after it.
    act(() => vi.advanceTimersByTime(150));
    expect(expanded('File')).toBe('false');
  });

  it('closes when the pointer leaves from inside the open dropdown panel', () => {
    // The dropdown is a DOM descendant of the menubar wrapper, so
    // leaving from a menu item (not the trigger) must arm the same
    // grace close.
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);
    fireEvent.click(trigger('File'));
    const item = screen.getByTestId('file-menu-open-recent');

    leaveToPage(item);
    act(() => vi.advanceTimersByTime(MENUBAR_GRACE_CLOSE_MS + 50));
    expect(expanded('File')).toBe('false');
  });

  it('keeps the menu open when the pointer re-enters within the grace delay', () => {
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);

    fireEvent.click(trigger('File'));
    leaveToPage(trigger('File'));
    act(() => vi.advanceTimersByTime(MENUBAR_GRACE_CLOSE_MS - 150));

    // Accidental exit: the cursor comes back before the timer fires.
    enterFromPage(trigger('File'));
    act(() => vi.advanceTimersByTime(MENUBAR_GRACE_CLOSE_MS * 3));
    expect(expanded('File')).toBe('true');
  });

  it('does not misfire on hover-switch between siblings (pointer never leaves the bar)', () => {
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);

    fireEvent.click(trigger('File'));
    // Move from the File trigger to the Format trigger. A browser
    // reports this as `pointerout` on File with relatedTarget=Format;
    // React synthesizes the leave chain (File up to the common
    // ancestor — the menubar wrapper, exclusive) and the enter chain
    // (wrapper down to Format). The wrapper's onPointerLeave must NOT
    // fire. (React ignores the paired `pointerover` when its
    // relatedTarget is an in-root node, so the `out` carries both.)
    fireEvent.pointerOut(trigger('File'), { relatedTarget: trigger('Format') });
    expect(expanded('Format')).toBe('true');
    expect(expanded('File')).toBe('false');

    // No grace timer should be pending: the switch must survive well
    // past the grace window.
    act(() => vi.advanceTimersByTime(MENUBAR_GRACE_CLOSE_MS * 3));
    expect(expanded('Format')).toBe('true');
  });

  it('survives a leave-then-switch: exit the bar, re-enter on a sibling within the grace delay', () => {
    // Moving from File's dropdown up to Format's button can cross
    // outside the menubar subtree for a moment. The re-entry cancels
    // the pending close and the hover-switch takes over.
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);

    fireEvent.click(trigger('File'));
    leaveToPage(trigger('File'));
    act(() => vi.advanceTimersByTime(MENUBAR_GRACE_CLOSE_MS - 150));

    enterFromPage(trigger('Format'));
    expect(expanded('Format')).toBe('true');
    act(() => vi.advanceTimersByTime(MENUBAR_GRACE_CLOSE_MS * 3));
    expect(expanded('Format')).toBe('true');
    expect(expanded('File')).toBe('false');
  });

  it('a pointer pass-through with no menu open arms nothing', () => {
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);

    enterFromPage(trigger('File'));
    leaveToPage(trigger('File'));
    act(() => vi.advanceTimersByTime(MENUBAR_GRACE_CLOSE_MS * 3));
    expect(expanded('File')).toBe('false');
    expect(expanded('Format')).toBe('false');
    expect(expanded('Help')).toBe('false');
  });

  it('a stale grace timer cannot kill a menu reopened after Escape', () => {
    // Escape closes while the timer is pending; reopening (keyboard
    // path — no pointerenter to cancel the timer) must not be cut
    // short by the old timer.
    renderWithRouter(<TopBar {...defaultProps} breakpoint="md" />);

    fireEvent.click(trigger('File'));
    leaveToPage(trigger('File'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(expanded('File')).toBe('false');

    // Reopen via keyboard activation (no pointer movement).
    fireEvent.click(trigger('File'));
    expect(expanded('File')).toBe('true');
    act(() => vi.advanceTimersByTime(MENUBAR_GRACE_CLOSE_MS * 3));
    expect(expanded('File')).toBe('true');
  });
});
