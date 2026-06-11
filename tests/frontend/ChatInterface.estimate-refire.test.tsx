// Model-switch / empty-draft contract for the composer cost estimate
// (src/components/ChatInterface.tsx, chat estimate effect).
//
// Investigated as PR #34 known-issue K6 ("estimate doesn't re-fire on
// model-switch with an empty draft"). `selectedModel` IS in the estimate
// effect's dependency list, so a model switch always re-runs the effect;
// what the reporter saw is the intentional empty-draft guard: with no
// draft text, no ready uploads, and no message history there is nothing
// sendable (Send is disabled at inputValue.length === 0), so the effect
// skips the network round-trip and resets the figure to $0 instead.
// Verified live (dev :8822, fetch-capture): truly-empty switch fires zero
// requests and displays $0.00; a switch with draft text or with message
// history re-fires with the new model and the figure updates.
//
// Contract pinned here:
//   1. Draft present → model switch re-estimates with the NEW model.
//   2. Truly empty composer → model switch fires no request, figure $0.00.
//   3. Emptying the draft clears the WHOLE estimate display, not just the
//      dollar figure: the "Estimation failed" banner and the "N files
//      couldn't be priced" notice from the previous draft must not
//      survive into the empty state. (This was the real defect found:
//      the chat guard reset only the figure, while the generate guard
//      already cleared the shared error slot — a network-failed estimate
//      followed by clearing the draft stranded a permanent failure banner
//      under an empty composer.)
//
// Not covered here (verified live instead): model switch with non-empty
// message HISTORY but empty draft re-estimates — exercising it in jsdom
// would require driving a full SSE send round-trip.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatInterface } from '../../src/components/ChatInterface';
import { ApiKeyContext, type ApiKeyContextValue } from '../../src/contexts/useApiKey';

vi.mock('@auth0/auth0-react', () => ({
  useAuth0: () => ({
    isAuthenticated: false,
    isLoading: false,
    user: undefined,
    getIdTokenClaims: vi.fn(async () => undefined),
    getAccessTokenSilently: vi.fn(async () => ''),
    loginWithRedirect: vi.fn(),
    logout: vi.fn(),
  }),
}));

const apiKeyStub: ApiKeyContextValue = {
  hasKey: false,
  keyLast4: null,
  verified: false,
  useForChat: false,
  setUseForChat: vi.fn(),
  submitKey: vi.fn(),
  clearKey: vi.fn(),
  refresh: vi.fn(),
  keyVersion: 0,
};

// Per-test controllable behavior of POST /api/count-tokens-estimate.
type EstimateBody = { model: string };
let estimateCalls: EstimateBody[];
let estimateImpl: () => Promise<Response>;

const okEstimate = (extra: Record<string, unknown> = {}) =>
  Promise.resolve(
    Response.json({
      input_tokens: 1000,
      estimated_cost_usd: 0.005,
      model: 'irrelevant',
      stripped_file_blocks: 0,
      uncounted_file_ids: [],
      cached_file_tokens: 0,
      cached_file_tokens_draft: 0,
      cached_file_tokens_history: 0,
      ...extra,
    }),
  );

beforeEach(() => {
  estimateCalls = [];
  estimateImpl = () => okEstimate();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/count-tokens-estimate')) {
        estimateCalls.push(JSON.parse(String(init?.body)) as EstimateBody);
        return estimateImpl();
      }
      // The sidebar progress bar renders `usage.used_usd`/`usage.limit_usd`
      // unguarded once usage is non-null, so this one needs a real shape.
      if (url.includes('/api/usage')) {
        return Response.json({ used_usd: 0, limit_usd: 5, tier: 'anon' });
      }
      // Remaining mount-time housekeeping (logging etc.) — benign empty
      // responses; those consumers are defensive about shape.
      return Response.json({});
    }),
  );
  // jsdom lacks scrollIntoView (chat autoscroll) — stub it.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChat() {
  return render(
    <MemoryRouter>
      <ApiKeyContext.Provider value={apiKeyStub}>
        <ChatInterface isCollapsed={false} onToggle={() => {}} graphData={null} />
      </ApiKeyContext.Provider>
    </MemoryRouter>,
  );
}

const PLACEHOLDER = 'Ask about your Theory of Change...';

async function getComposer() {
  // hasTurnstileSession starts null (placeholder render); the no-site-key
  // promotion effect flips it true right after mount.
  return await screen.findByPlaceholderText(PLACEHOLDER);
}

function setDraft(textarea: HTMLElement, value: string) {
  fireEvent.change(textarea, { target: { value } });
}

async function switchModel(label: string) {
  fireEvent.click(screen.getByTitle('Select AI Model'));
  // findByText + selector instead of findByRole: role queries compute
  // accessible names across this component's very large DOM and routinely
  // blow the test timeout. At query time only the menu option matches the
  // label (the trigger still shows the previous selection).
  fireEvent.click(await screen.findByText(label, { selector: 'button' }));
}

/**
 * Let the 600ms estimate debounce elapse without asserting anything fired.
 * Deliberately NOT act()-wrapped: wrapping this sleep in act() keeps the
 * act work loop draining this very large component tree for >14s
 * (observed) and times the test out. On the guard path the debounce
 * callback's setStates are bail-outs (0 → 0, false → false), so there are
 * no un-acted updates to warn about; state-changing paths are asserted
 * via waitFor, which is act-aware.
 */
async function debounceWindow() {
  await new Promise((r) => setTimeout(r, 1000));
}

const estimateLine = () => screen.getByText(/Estimated input cost:/).textContent ?? '';

describe('composer estimate × model switch', () => {
  it('re-estimates with the new model when a draft is present', async () => {
    renderChat();
    const textarea = await getComposer();

    setDraft(textarea, 'What outcomes should I add?');
    await waitFor(() => expect(estimateCalls).toHaveLength(1), { timeout: 3000 });
    expect(estimateCalls[0].model).toBe('claude-opus-4-7'); // default selection

    await switchModel('Claude Sonnet 4.6');
    await waitFor(() => expect(estimateCalls).toHaveLength(2), { timeout: 3000 });
    expect(estimateCalls[1].model).toBe('claude-sonnet-4-6');
  }, 15_000);

  it('fires no request on model switch when the composer is truly empty, and keeps $0.00', async () => {
    renderChat();
    await getComposer();

    await switchModel('Claude Sonnet 4.6');
    await debounceWindow();

    expect(estimateCalls).toHaveLength(0);
    expect(estimateLine()).toContain('$0.00');
  }, 15_000);

  it('clears the failure banner (not just the figure) when the draft is emptied', async () => {
    renderChat();
    const textarea = await getComposer();

    // Estimate fails → fallback figure + failure banner.
    estimateImpl = () => Promise.reject(new TypeError('Failed to fetch (simulated)'));
    setDraft(textarea, 'this estimate will fail');
    await screen.findByText(/Estimation failed:/, undefined, { timeout: 3000 });
    expect(estimateCalls).toHaveLength(1);

    // Empty the draft. The guard path must reset the whole display —
    // figure to $0.00, banner gone — WITHOUT issuing a new request
    // (nothing is sendable, so there is nothing to re-estimate).
    estimateImpl = () => okEstimate();
    setDraft(textarea, '');
    await waitFor(() => expect(estimateLine()).toContain('$0.00'), { timeout: 3000 });
    expect(screen.queryByText(/Estimation failed:/)).toBeNull();
    expect(estimateCalls).toHaveLength(1); // no refetch on the empty state
  }, 15_000);

  it("clears the files-couldn't-be-priced notice when the draft is emptied", async () => {
    renderChat();
    const textarea = await getComposer();

    estimateImpl = () => okEstimate({ uncounted_file_ids: ['file_011AbCdEfGhIjKlMnOpQrStU'] });
    setDraft(textarea, 'draft with an unpriceable file');
    await screen.findByText(/couldn't be priced/, undefined, { timeout: 3000 });

    setDraft(textarea, '');
    await waitFor(() => expect(estimateLine()).toContain('$0.00'), { timeout: 3000 });
    expect(screen.queryByText(/couldn't be priced/)).toBeNull();
  }, 15_000);
});
