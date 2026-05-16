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
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { TopBar } from '../../src/components/top-bar/TopBar';

const noop = () => {};

const defaultProps = {
  // Mode + selection.
  editMode: true,
  setEditMode: noop,
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
  // Share / chart.
  data: { sections: [], title: 'My ToC' } as never,
  containerSize: { width: 1024, height: 768 },
  onChartCreated: noop,
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
});
