// Tests for AuthButton — TopBar profile badge + account dropdown.
//
// PR 7 feedback (58): the authenticated badge button had no display class,
// so it rendered as the UA default `display: inline-block`. Its plain-block
// wrapper (`div.relative`) then laid it out as inline content: with
// `overflow-hidden` an inline-block's baseline is its bottom margin edge,
// and the wrapper's line box adds the strut descent (~7px at 16px/1.5)
// below the button. Measured: wrapper 43px around a 36px button, so the
// badge mis-centered against the 36px Share button in the TopBar's
// `items-center` row. Contract: every badge variant is a block-level
// 36×36 flex box (`w-9 h-9 rounded-full flex items-center justify-center`),
// which keeps the wrapper exactly button-sized.
//
// PR 7 feedback (59): Auth0 database-connection users get `name` defaulted
// to the literal email, so the dropdown header's unconditional
// `{user.name}` + `{user.email}` lines showed the same address twice.
// Contract: a real, distinct name renders name + email as two lines in the
// same flex column (same left edge — no indent mismatch); a missing name or
// name === email renders the email exactly once, with no empty line.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthButton from '../../src/components/AuthButton';

const mockUseAuth0 = vi.fn();
vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => mockUseAuth0(),
}));

// ApiKeyModal (always mounted by AuthButton) calls useApiKey() at the top
// level, which throws outside ApiKeyProvider. Stub the hook so these tests
// don't need the provider's fetch wiring.
vi.mock('../../src/contexts/useApiKey', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/contexts/useApiKey')>();
  return {
    ...actual,
    useApiKey: () => ({
      hasKey: false,
      keyLast4: null,
      verified: false,
      useForChat: false,
      setUseForChat: vi.fn(),
      submitKey: vi.fn(),
      clearKey: vi.fn(),
      refresh: vi.fn(),
      keyVersion: 0,
    }),
  };
});

const EMAIL = 'moiri.gamboni@proton.me';

const auth0State = (user?: Record<string, unknown>) => ({
  user,
  isAuthenticated: user !== undefined,
  isLoading: false,
  loginWithRedirect: vi.fn(),
  logout: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

// Exactly one button is in the tree before the dropdown opens (modals are
// closed → null), so role lookup is unambiguous and independent of the
// title attribute.
const getBadge = () => screen.getByRole('button');

// The Share-row alignment contract (TopBar right cluster is
// `flex items-center`): the badge must be a 36×36 *block-level* flex box.
// An inline-block button makes the wrapper taller than the button
// (line-box strut descent below the baseline-pinned bottom edge), which
// breaks vertical centering against the 36px Share button.
const SHARE_ROW_CONTRACT = ['w-9', 'h-9', 'rounded-full', 'flex', 'items-center', 'justify-center'];

const expectShareRowContract = (badge: HTMLElement) => {
  for (const cls of SHARE_ROW_CONTRACT) {
    expect(badge.classList.contains(cls), `expected badge to have class "${cls}"`).toBe(true);
  }
  // No margin utilities that would offset the badge inside the row.
  expect(badge.className).not.toMatch(/(?:^|\s)-?m[tbylrxse]?-/);
};

describe('AuthButton badge geometry contract (58)', () => {
  it('authenticated badge with an avatar picture is a 36×36 block-level flex box', () => {
    mockUseAuth0.mockReturnValue(
      auth0State({
        name: EMAIL,
        email: EMAIL,
        picture: 'https://cdn.auth0.com/avatars/mo.png',
        sub: 'auth0|abc',
      }),
    );
    render(<AuthButton />);
    expectShareRowContract(getBadge());
  });

  it('authenticated badge without a picture (initials fallback) keeps the same contract', () => {
    mockUseAuth0.mockReturnValue(
      auth0State({ name: 'Moïri Gamboni', email: EMAIL, sub: 'auth0|abc' }),
    );
    render(<AuthButton />);
    expectShareRowContract(getBadge());
  });

  it('anonymous badge keeps the same contract (round-1 regression guard)', () => {
    mockUseAuth0.mockReturnValue(auth0State(undefined));
    render(<AuthButton />);
    expectShareRowContract(getBadge());
  });
});

describe('AuthButton dropdown identity lines (59)', () => {
  // The flex column holding the identity lines. Every rendered line must
  // have real text — an empty line still takes up a line-height of space
  // and pushes the email visibly off-center next to the avatar.
  const expectNoEmptyLines = (column: HTMLElement) => {
    expect(column.children.length).toBeGreaterThan(0);
    for (const child of Array.from(column.children)) {
      expect(child.textContent?.trim(), 'identity column must not render empty lines').toBeTruthy();
    }
  };

  it('renders the email exactly once when Auth0 defaults name to the email (database connections)', async () => {
    mockUseAuth0.mockReturnValue(auth0State({ name: EMAIL, email: EMAIL, sub: 'auth0|abc' }));
    render(<AuthButton />);
    await userEvent.click(getBadge());

    expect(screen.getAllByText(EMAIL)).toHaveLength(1);
    expectNoEmptyLines(screen.getByText(EMAIL).parentElement as HTMLElement);
    // A lone email line renders at text-sm so the full address fits the
    // w-72 dropdown instead of ellipsizing (16px font-medium truncates it).
    expect(screen.getByText(EMAIL).classList.contains('text-sm')).toBe(true);
  });

  it('renders the email exactly once when name is missing', async () => {
    mockUseAuth0.mockReturnValue(auth0State({ email: EMAIL, sub: 'auth0|abc' }));
    render(<AuthButton />);
    await userEvent.click(getBadge());

    expect(screen.getAllByText(EMAIL)).toHaveLength(1);
    expectNoEmptyLines(screen.getByText(EMAIL).parentElement as HTMLElement);
  });

  it('renders name and email as two aligned lines when a distinct name exists', async () => {
    mockUseAuth0.mockReturnValue(
      auth0State({ name: 'Moïri Gamboni', email: EMAIL, sub: 'auth0|abc' }),
    );
    render(<AuthButton />);
    await userEvent.click(getBadge());

    const nameEl = screen.getByText('Moïri Gamboni');
    const emailEl = screen.getByText(EMAIL);
    // Same flex column ⇒ same left edge ⇒ no indent mismatch between lines.
    expect(nameEl.parentElement).toBe(emailEl.parentElement);
    expectNoEmptyLines(nameEl.parentElement as HTMLElement);
  });

  it('renders the name exactly once when email is missing', async () => {
    mockUseAuth0.mockReturnValue(auth0State({ name: 'Moïri Gamboni', sub: 'auth0|abc' }));
    render(<AuthButton />);
    await userEvent.click(getBadge());

    expect(screen.getAllByText('Moïri Gamboni')).toHaveLength(1);
    expectNoEmptyLines(screen.getByText('Moïri Gamboni').parentElement as HTMLElement);
  });
});
