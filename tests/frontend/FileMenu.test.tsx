// Tests for FileMenu — File dropdown in the new TopBar.
//
// Two main concerns:
//   1. The "Delete chart" item is owner-gated. For anonymous edits
//      (no auth, but possessing the edit token) it is still shown
//      because anyone with the edit token is the de-facto owner. For
//      authenticated callers it shows only when `isOwner=true`.
//   2. Static items are always present: New ToC, Open recent, Import,
//      Export, all in that order. Import/Export sub-actions are
//      placeholders in PR 1 (PR 6 wires the real implementations).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FileMenu } from '../../src/components/top-bar/FileMenu';
import { ChartService } from '../../src/services/chartService';
import type { ComponentProps } from 'react';

// Auth0 normally returns `{user: undefined}` outside a provider; the
// auth-path tests need a user.sub to hit the `getUserCharts` branch.
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
  currentEditToken: 'tok-abc' as string | null,
  currentChartId: 'chart-xyz' as string | null,
  onDeleteChart: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

const renderMenu = (props: Partial<FileMenuProps> = {}) =>
  render(
    <MemoryRouter>
      <FileMenu {...baseProps} {...props} />
    </MemoryRouter>,
  );

describe('FileMenu', () => {
  it('renders a File trigger button', () => {
    renderMenu();
    expect(screen.getByRole('button', { name: /file/i })).toBeInTheDocument();
  });

  it('opens the dropdown on click and lists the expected items', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: /file/i }));

    expect(screen.getByText(/new toc/i)).toBeInTheDocument();
    expect(screen.getByText(/open recent/i)).toBeInTheDocument();
    expect(screen.getByText(/^import$/i)).toBeInTheDocument();
    expect(screen.getByText(/^export$/i)).toBeInTheDocument();
  });

  it('hides Delete chart for anonymous viewers without an edit token', async () => {
    const user = userEvent.setup();
    renderMenu({ currentEditToken: null });
    await user.click(screen.getByRole('button', { name: /file/i }));
    expect(screen.queryByText(/delete chart/i)).toBeNull();
  });

  it('shows Delete chart for anonymous edits (edit token, not authenticated)', async () => {
    const user = userEvent.setup();
    renderMenu({ isAuthenticated: false, currentEditToken: 'tok-abc', isOwner: false });
    await user.click(screen.getByRole('button', { name: /file/i }));
    expect(screen.getByText(/delete chart/i)).toBeInTheDocument();
  });

  it('hides Delete chart for authenticated non-owners', async () => {
    const user = userEvent.setup();
    renderMenu({ isAuthenticated: true, isOwner: false, currentEditToken: 'tok-abc' });
    await user.click(screen.getByRole('button', { name: /file/i }));
    expect(screen.queryByText(/delete chart/i)).toBeNull();
  });

  it('shows Delete chart for authenticated owners', async () => {
    const user = userEvent.setup();
    renderMenu({ isAuthenticated: true, isOwner: true, currentEditToken: 'tok-abc' });
    await user.click(screen.getByRole('button', { name: /file/i }));
    expect(screen.getByText(/delete chart/i)).toBeInTheDocument();
  });

  it('calls onDeleteChart with the chart ID when Delete is confirmed via ConfirmModal', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderMenu({
      isAuthenticated: true,
      isOwner: true,
      currentEditToken: 'tok-abc',
      onDeleteChart: onDelete,
    });

    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/delete chart/i));

    // PR 5: confirm prompt is now a React modal, not window.confirm.
    const modal = await screen.findByTestId('confirm-modal');
    expect(modal).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-modal-confirm'));

    expect(onDelete).toHaveBeenCalledWith('chart-xyz');
  });

  it('does NOT call onDeleteChart when the user cancels the ConfirmModal', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderMenu({
      isAuthenticated: true,
      isOwner: true,
      currentEditToken: 'tok-abc',
      onDeleteChart: onDelete,
    });

    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/delete chart/i));

    const modal = await screen.findByTestId('confirm-modal');
    expect(modal).toBeInTheDocument();
    await user.click(screen.getByTestId('confirm-modal-cancel'));

    expect(onDelete).not.toHaveBeenCalled();
    // Modal closes after cancel.
    expect(screen.queryByTestId('confirm-modal')).toBeNull();
  });

  it('shows a distinct error row when the anon Open recent localStorage read throws', async () => {
    const user = userEvent.setup();
    // Force localStorage.getItem to throw — same shape as Brave Shields
    // / Safari ITP / corrupt-blob failures.
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: localStorage disabled');
    });
    // Silence the console.error so the test output stays clean.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderMenu({ isAuthenticated: false, currentEditToken: 'tok-abc' });
    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/open recent/i));

    // The error row must be visible and distinct from the empty-state
    // copy ("No local charts found.") — otherwise the user sees a
    // misleading "empty" state and concludes data was lost.
    await waitFor(() => {
      expect(screen.getByText(/couldn.t load recent charts/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/no local charts found/i)).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();

    getItemSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('shows a distinct error row when getUserCharts throws (auth path)', async () => {
    const user = userEvent.setup();
    const getUserChartsSpy = vi
      .spyOn(ChartService, 'getUserCharts')
      .mockRejectedValueOnce(new Error('HTTP 503: upstream timeout'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderMenu({ isAuthenticated: true, isOwner: false, currentEditToken: 'tok-abc' });
    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/open recent/i));

    await waitFor(() => {
      expect(screen.getByText(/couldn.t load recent charts/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/no saved charts yet/i)).toBeNull();

    getUserChartsSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// PR 6 Task 6.2: Import + Export wiring
// ---------------------------------------------------------------------------
//
// These tests pin the new behavior added by PR 6: clicking
// Export → JSON serializes the live `data` and triggers a download;
// Import → JSON opens a file picker and routes the parsed result
// through `onImportJson` (with a confirm gate when the existing
// graph has nodes).

import type { ToCData } from '../../src/types';

const sampleData: ToCData = {
  title: 'Sample Theory',
  sections: [
    {
      title: 'Inputs',
      columns: [{ nodes: [{ id: 'n1', title: 'A', text: 'a', connectionIds: [] }] }],
    },
  ],
};

describe('FileMenu — Export (PR 6 Task 6.2)', () => {
  it('Export → JSON serializes data and downloads it', async () => {
    // Mock URL.createObjectURL + anchor.click so we can read what the
    // FileMenu hands off without actually starting a download.
    const objectUrls: string[] = [];
    let counter = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob) => {
      const url = `blob:t-${++counter}-${blob.size}`;
      objectUrls.push(url);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    let clicked: { href: string; download: string } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked = { href: this.href, download: this.download };
    });

    const user = userEvent.setup();
    renderMenu({ data: sampleData });
    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/^export$/i));
    await user.click(screen.getByTestId('file-menu-export-json'));

    // The handler dynamic-imports `exportChart.ts`, so we await the
    // import + click to settle.
    await waitFor(() => expect(clicked).not.toBeNull());
    // Filename derived from `data.title` via slugify.
    expect(clicked!.download).toMatch(/sample-theory\.json/);
    expect(objectUrls).toHaveLength(1);
  });

  it('Export → JSON is disabled when `data` is not passed', async () => {
    const user = userEvent.setup();
    renderMenu(); // no `data`
    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/^export$/i));
    const btn = screen.getByTestId('file-menu-export-json');
    expect(btn).toBeDisabled();
  });
});

describe('FileMenu — Import (PR 6 Task 6.2)', () => {
  // Build a File object for the hidden <input type=file>. jsdom
  // exposes the File constructor in the global scope.
  const makeJsonFile = (obj: unknown, name = 'theory.json') =>
    new File([JSON.stringify(obj)], name, { type: 'application/json' });

  it('parses the file and calls onImportJson directly when the existing graph is empty', async () => {
    const user = userEvent.setup();
    const onImportJson = vi.fn();
    renderMenu({
      data: { sections: [] }, // empty graph -> no confirm needed
      onImportJson,
    });

    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/^import$/i));
    await user.click(screen.getByTestId('file-menu-import-json'));

    const fileInput = screen.getByTestId('file-menu-import-input') as HTMLInputElement;
    await user.upload(fileInput, makeJsonFile(sampleData));

    // Microtask boundary so the .text() promise + setState settle.
    await Promise.resolve();
    expect(onImportJson).toHaveBeenCalledWith(sampleData);
  });

  it('shows a confirm modal when the existing graph has nodes, and only commits on confirm', async () => {
    const user = userEvent.setup();
    const onImportJson = vi.fn();
    renderMenu({
      data: sampleData, // 1 node — non-empty
      onImportJson,
    });

    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/^import$/i));
    await user.click(screen.getByTestId('file-menu-import-json'));

    const fileInput = screen.getByTestId('file-menu-import-input') as HTMLInputElement;
    await user.upload(
      fileInput,
      makeJsonFile({
        sections: [
          {
            title: 'X',
            columns: [{ nodes: [{ id: 'b1', title: 'B', text: 'b', connectionIds: [] }] }],
          },
        ],
      }),
    );

    // Modal appears (rendered via the same ConfirmModal primitive).
    const modal = await screen.findByTestId('confirm-modal');
    expect(modal).toBeInTheDocument();
    expect(onImportJson).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('confirm-modal-confirm'));
    expect(onImportJson).toHaveBeenCalledTimes(1);
    expect((onImportJson.mock.calls[0][0] as { sections: unknown[] }).sections).toHaveLength(1);
  });

  it('rejects files without a sections array', async () => {
    const user = userEvent.setup();
    const onImportJson = vi.fn();
    renderMenu({
      data: { sections: [] },
      onImportJson,
    });

    await user.click(screen.getByRole('button', { name: /file/i }));
    await user.click(screen.getByText(/^import$/i));
    await user.click(screen.getByTestId('file-menu-import-json'));

    const fileInput = screen.getByTestId('file-menu-import-input') as HTMLInputElement;
    await user.upload(fileInput, makeJsonFile({ wrongShape: true }));

    await Promise.resolve();
    // Bad file -> onImportJson is never called; an export-error modal
    // appears via the third ConfirmModal instance.
    expect(onImportJson).not.toHaveBeenCalled();
    expect(await screen.findByText(/does not look like a theory of change/i)).toBeInTheDocument();
  });
});
