// Tests for LinkCopyRow, one shareable link in the Share dialog:
//   - a label naming the link, a line saying what it is for, a read-only
//     URL field and a copy button named for the link it copies.
//   - a status line about access: neutral for the view link; for the edit
//     link, "Anyone with this link can edit" (as a warning) only at level
//     'editor', "Approval required to edit." / "Editors must be approved."
//     for 'restricted' / 'viewer'. No status line when the level is unknown.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { LinkCopyRow } from '../../src/components/share/LinkCopyRow';

// Module-scope clipboard mock so a test can both inspect calls and the
// component can call `navigator.clipboard.writeText` through the same
// reference. `Object.defineProperty` recreates the mock per test;
// stashing the spy in this variable keeps the assertion target stable.
let writeTextSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  writeTextSpy = vi.fn(async () => undefined);
  // jsdom doesn't ship a clipboard polyfill; mock writeText so the test
  // can observe what the component tried to copy.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextSpy },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LinkCopyRow', () => {
  it('renders a single label and a copy button for the view link', () => {
    render(
      <LinkCopyRow
        variant="view"
        url="https://example.test/chart/c1"
        linkSharingLevel="restricted"
      />,
    );

    // Single visible label, not a title-then-subtitle pair.
    expect(screen.getByText('View link')).toBeInTheDocument();
    // Copy button (icon-only would still expose an accessible name).
    expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    // The URL is rendered (readonly input) so the user can see it.
    const input = screen.getByDisplayValue('https://example.test/chart/c1');
    expect(input).toBeInTheDocument();
  });

  it('names each copy button for the link it copies', () => {
    render(
      <>
        <LinkCopyRow variant="view" url="https://example.test/chart/c1" linkSharingLevel="viewer" />
        <LinkCopyRow variant="edit" url="https://example.test/edit/tok" linkSharingLevel="viewer" />
      </>,
    );

    expect(screen.getByRole('button', { name: 'Copy view link' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy edit link' })).toBeInTheDocument();
  });

  it('labels each URL field with the name of its link', () => {
    render(
      <>
        <LinkCopyRow variant="view" url="https://example.test/chart/c1" linkSharingLevel="viewer" />
        <LinkCopyRow variant="edit" url="https://example.test/edit/tok" linkSharingLevel="viewer" />
      </>,
    );

    expect(screen.getByLabelText('View link')).toHaveValue('https://example.test/chart/c1');
    expect(screen.getByLabelText('Edit link')).toHaveValue('https://example.test/edit/tok');
  });

  it('renders a single label for the edit link', () => {
    render(
      <LinkCopyRow
        variant="edit"
        url="https://example.test/edit/tok"
        linkSharingLevel="restricted"
      />,
    );
    expect(screen.getByText('Edit link')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://example.test/edit/tok')).toBeInTheDocument();
  });

  it('shows "Anyone with this link can edit" warning when mode is editor', () => {
    render(
      <LinkCopyRow variant="edit" url="https://example.test/edit/tok" linkSharingLevel="editor" />,
    );
    // Exact substring as required by L6 mitigation copy.
    expect(screen.getByText(/Anyone with this link can edit/i)).toBeInTheDocument();
  });

  it('does NOT show "Anyone with this link can edit" warning for restricted', () => {
    render(
      <LinkCopyRow
        variant="edit"
        url="https://example.test/edit/tok"
        linkSharingLevel="restricted"
      />,
    );
    expect(screen.queryByText(/Anyone with this link can edit/i)).toBeNull();
  });

  it('says what each link is for, whether or not a status line follows', () => {
    const levels = ['restricted', 'viewer', 'editor', null] as const;
    for (const level of levels) {
      const { unmount } = render(
        <>
          <LinkCopyRow
            variant="view"
            url="https://example.test/chart/c1"
            linkSharingLevel={level}
          />
          <LinkCopyRow
            variant="edit"
            url="https://example.test/edit/tok"
            linkSharingLevel={level}
          />
        </>,
      );
      expect(screen.getByText('Share this to show or embed the chart.')).toBeInTheDocument();
      expect(screen.getByText('Share this with people helping you build it.')).toBeInTheDocument();
      // The label itself stays a single plain label.
      expect(screen.getByText('View link')).toBeInTheDocument();
      expect(screen.getByText('Edit link')).toBeInTheDocument();
      unmount();
    }
  });

  it('shows no status line when the level is unknown', () => {
    const { container } = render(
      <>
        <LinkCopyRow variant="view" url="https://example.test/chart/c1" linkSharingLevel={null} />
        <LinkCopyRow variant="edit" url="https://example.test/edit/tok" linkSharingLevel={null} />
      </>,
    );
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('does NOT show edit-link warning on the view link variant', () => {
    render(
      <LinkCopyRow variant="view" url="https://example.test/chart/c1" linkSharingLevel="editor" />,
    );
    expect(screen.queryByText(/Anyone with this link can edit/i)).toBeNull();
  });

  it('copies the URL to clipboard on click and flips the button label to Copied', async () => {
    // user-event 14's `setup()` installs its own clipboard polyfill on
    // `navigator.clipboard`, which shadows the module-scope mock. Skip
    // setup() and click via fireEvent so our spy is the one called.
    render(
      <LinkCopyRow variant="view" url="https://example.test/chart/c1" linkSharingLevel="viewer" />,
    );

    const button = screen.getByRole('button', { name: /copy/i });
    button.click();

    await waitFor(() => {
      expect(writeTextSpy).toHaveBeenCalledWith('https://example.test/chart/c1');
    });
    // Click feedback flips to "Copied".
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
    });
  });
});
