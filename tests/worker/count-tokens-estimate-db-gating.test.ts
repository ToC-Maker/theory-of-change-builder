// DB-access gating for /api/count-tokens-estimate
// (worker/api/count-tokens-estimate.ts).
//
// The handler only needs the database for two things, both optional per
// request:
//   1. the chart access check (only when the body carries `chartId`), and
//   2. the chart_files cached-token lookup (only when the payload contained
//      Files-API `document` blocks that got stripped).
//
// It used to call `getDb(env)` unconditionally between the upstream
// count_tokens fetch and those two blocks. `getDb` throws when
// `env.DATABASE_URL` is unset (worker/_shared/db.ts), and the router
// (worker/index.ts) turns handler throws into a 500 — so a missing/broken
// DATABASE_URL failed even pure-text estimates that never touch the DB.
//
// Contract pinned here:
//   - no files + no chartId  → DB never consulted; 200 even without
//     DATABASE_URL.
//   - files, no chartId      → DB unavailability degrades like any other
//     chart_files lookup failure (the existing catch): 200 with every
//     stripped file_id reported in `uncounted_file_ids`, not a 500.
//   - chartId present        → fail closed. The access check is an IDOR
//     guard; without a DB we cannot verify the caller, so the handler
//     throws (router → 500) rather than answering.

import { describe, expect, it, vi, afterEach } from 'vitest';
import { handler } from '../../worker/api/count-tokens-estimate';
import type { Env } from '../../worker/_shared/types';

// No DATABASE_URL on purpose — that's the scenario under test.
const envWithoutDb = { ANTHROPIC_API_KEY: 'test-key' } as unknown as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubUpstream() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.anthropic.com/v1/messages/count_tokens')) {
        return Response.json({ input_tokens: 42 });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

function post(body: unknown): Request {
  return new Request('https://example.test/api/count-tokens-estimate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('count-tokens-estimate DB gating (DATABASE_URL unset)', () => {
  it('returns 200 for a pure-text payload (no files, no chartId) — the DB is never needed', async () => {
    stubUpstream();
    const res = await handler(
      post({
        model: 'claude-sonnet-4-6',
        system: [{ type: 'text', text: 'sys' }],
        messages: [{ role: 'user', content: 'hello' }],
      }),
      envWithoutDb,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { input_tokens: number; estimated_cost_usd: number };
    expect(json.input_tokens).toBe(42);
    expect(json.estimated_cost_usd).toBeGreaterThan(0);
  });

  it('returns 200 with all stripped file_ids reported uncounted when files are present but the DB is unavailable', async () => {
    // Same degradation contract as a failed chart_files query: the base
    // count still comes back, and the client is told exactly which files
    // the number excludes (it renders the "N files couldn't be priced"
    // notice from uncounted_file_ids).
    stubUpstream();
    const fileId = 'file_011AbCdEfGhIjKlMnOpQrStU';
    const res = await handler(
      post({
        model: 'claude-sonnet-4-6',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'file', file_id: fileId } },
              { type: 'text', text: 'summarize this' },
            ],
          },
        ],
      }),
      envWithoutDb,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      input_tokens: number;
      stripped_file_blocks: number;
      uncounted_file_ids: string[];
      cached_file_tokens: number;
    };
    expect(json.stripped_file_blocks).toBe(1);
    expect(json.uncounted_file_ids).toEqual([fileId]);
    expect(json.cached_file_tokens).toBe(0);
    expect(json.input_tokens).toBe(42);
  });

  it('fails closed (throws → router 500) when chartId is present — the access check cannot run without a DB', async () => {
    stubUpstream();
    await expect(
      handler(
        post({
          model: 'claude-sonnet-4-6',
          chartId: 'abc123',
          messages: [{ role: 'user', content: 'hello' }],
        }),
        envWithoutDb,
      ),
    ).rejects.toThrow('DATABASE_URL not configured');
  });
});
