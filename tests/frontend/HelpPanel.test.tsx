// Tests for HelpPanel — Help dropdown in the new TopBar.
//
// Contract for "Replay the view-mode walkthrough":
//   1. Dispatches the GRAPH_TUTORIAL_REPLAY_EVENT custom event on
//      `window` so the already-mounted <GraphTutorial /> (in either
//      ToCViewer or ToCViewerOnly) opens.
//   2. Closes the menu.
//
// HelpPanel sits inside TopBar; <GraphTutorial> sits next to the canvas
// (disjoint subtrees), so a window-scoped CustomEvent bridges them
// without threading a prop chain. The previous implementation cleared a
// localStorage flag + reloaded — that produced PR #34 feedback ("some
// kind of tutorial pops up at some point, I'm not sure what is
// triggering it") because the flag-absent state was the *auto-open*
// trigger, surprising users on first load. The new flow opens only on
// explicit request via this button.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelpPanel } from '../../src/components/top-bar/HelpPanel';
import { GRAPH_TUTORIAL_REPLAY_EVENT } from '../../src/components/GraphTutorial';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HelpPanel — Replay the view-mode walkthrough', () => {
  it('dispatches the GRAPH_TUTORIAL_REPLAY_EVENT and closes the menu when clicked', async () => {
    const user = userEvent.setup();
    const listener = vi.fn();
    window.addEventListener(GRAPH_TUTORIAL_REPLAY_EVENT, listener);

    render(<HelpPanel />);
    await user.click(screen.getByRole('button', { name: /help/i }));
    await user.click(screen.getByRole('menuitem', { name: /replay/i }));

    expect(listener).toHaveBeenCalledTimes(1);
    // Menu closed → the menuitem is no longer in the DOM.
    expect(screen.queryByRole('menuitem', { name: /replay/i })).toBeNull();

    window.removeEventListener(GRAPH_TUTORIAL_REPLAY_EVENT, listener);
  });

  it('renders the contact email as a mailto link', async () => {
    // Users need a low-friction way to send bug reports, feedback, or
    // questions; surface a mailto link with the canonical inbox so the
    // user's mail client takes over and we don't have to host a form.
    const user = userEvent.setup();
    render(<HelpPanel />);
    await user.click(screen.getByRole('button', { name: /help/i }));

    const emailLink = screen.getByRole('menuitem', {
      name: /theoryofchangebuilder@gmail\.com/i,
    });
    expect(emailLink).toHaveAttribute('href', 'mailto:theoryofchangebuilder@gmail.com');
  });

  it('renders the GitHub issues link as an external link', async () => {
    // Power users prefer filing bugs directly on the repo; render as an
    // external link with safe `target="_blank"` semantics.
    const user = userEvent.setup();
    render(<HelpPanel />);
    await user.click(screen.getByRole('button', { name: /help/i }));

    const githubLink = screen.getByRole('menuitem', { name: /github issue/i });
    expect(githubLink).toHaveAttribute(
      'href',
      'https://github.com/ToC-Maker/theory-of-change-builder/issues/new',
    );
    expect(githubLink).toHaveAttribute('target', '_blank');
    expect(githubLink).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
