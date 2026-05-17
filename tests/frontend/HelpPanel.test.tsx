// Tests for HelpPanel — Help dropdown in the new TopBar.
//
// Contract for "Replay the view-mode walkthrough":
//   1. Clears `graph-tutorial-seen` from localStorage so <GraphTutorial>
//      will re-arm on next mount.
//   2. Reloads the window so <GraphTutorial> remounts and runs its
//      first-time check.
//
// Both legs are required: clearing the flag without a reload leaves the
// (already-mounted) GraphTutorial inert; reloading without clearing the
// flag re-runs the gate and skips the tutorial. <GraphTutorial> is
// mounted in both ToCViewerOnly and ToCViewer (App.tsx) so the reload
// re-arms regardless of which route the user is on.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelpPanel } from '../../src/components/top-bar/HelpPanel';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HelpPanel — Replay the view-mode walkthrough', () => {
  it('removes the graph-tutorial-seen flag and reloads when clicked', async () => {
    const user = userEvent.setup();
    localStorage.setItem('graph-tutorial-seen', 'true');
    // jsdom's `window.location` is not configurable for `reload` directly;
    // patch the whole `location` object so we can spy on reload.
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadMock },
    });

    render(<HelpPanel />);
    await user.click(screen.getByRole('button', { name: /help/i }));
    await user.click(screen.getByRole('menuitem', { name: /replay/i }));

    // After this point, on a real browser reload, <GraphTutorial>
    // remounts (in either ToCViewer or ToCViewerOnly), reads
    // localStorage('graph-tutorial-seen'), finds it absent, and starts
    // its first-time sequence. The two assertions below cover both
    // preconditions for that re-arming.
    expect(localStorage.getItem('graph-tutorial-seen')).toBeNull();
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces inline error and skips reload when localStorage throws', async () => {
    // Private-mode / disabled-storage scenario: removeItem throws.
    // The previous behaviour swallowed the error and reloaded anyway,
    // which left the tutorial flag in place silently (so the
    // "Replay" affordance appeared to do nothing). Surface the
    // failure instead, and skip the reload that would otherwise lie
    // to the user about resetting the tutorial.
    const user = userEvent.setup();
    localStorage.setItem('graph-tutorial-seen', 'true');
    const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    const reloadMock = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadMock },
    });

    render(<HelpPanel />);
    await user.click(screen.getByRole('button', { name: /help/i }));
    await user.click(screen.getByRole('menuitem', { name: /replay/i }));

    expect(removeSpy).toHaveBeenCalledWith('graph-tutorial-seen');
    expect(reloadMock).not.toHaveBeenCalled();
    expect(screen.getByText(/storage may be disabled/i)).toBeInTheDocument();
  });
});
