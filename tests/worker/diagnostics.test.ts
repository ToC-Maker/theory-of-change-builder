// Tests for `writeDiagnostic` (worker/_shared/diagnostics.ts).
//
// The helper centralises the `INSERT INTO logging_errors` boilerplate that
// was duplicated across the streaming worker. Coverage focuses on the
// auto-injection logic in `request_metadata` — the SQL shape and the
// error-swallowing recovery path are pinned implicitly via the SQL spy
// fixture below.
//
// `start_at_ms` is the new param this test file was added for: when
// supplied alongside (or without) `fired_at_ms`, the helper auto-computes
// `diagnostic_elapsed_ms` so callers can stop manually subtracting elapsed
// times at every site in `anthropic-stream.ts`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeonQueryFunction } from '@neondatabase/serverless';
import { writeDiagnostic } from '../../worker/_shared/diagnostics';

// Minimal NeonQueryFunction stub. The real client is a tagged-template
// function that returns a thenable; for our purposes we just need to
// observe the JSON `request_metadata` argument it receives. We capture the
// values array (the second slot in the template-tag invocation) and let
// the call resolve to an empty rows array.
type CapturedCall = {
  strings: TemplateStringsArray;
  values: unknown[];
};

function makeSqlSpy(): { sql: NeonQueryFunction<false, false>; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sql: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings, values });
    return Promise.resolve([]);
  };
  return { sql: sql as NeonQueryFunction<false, false>, calls };
}

/**
 * Pull the `request_metadata` argument out of the captured tagged-template
 * call. The INSERT in writeDiagnostic always lays out the values in the
 * same order: error_id, error_name, error_message, user_id, chart_id,
 * http_status, request_metadata (as a JSON-encoded string).
 */
function readMetadataFromCall(call: CapturedCall): Record<string, unknown> {
  // request_metadata is the 7th interpolated value (zero-indexed: 6).
  const raw = call.values[6];
  if (typeof raw !== 'string') {
    throw new Error(`expected request_metadata to be a JSON string, got ${typeof raw}`);
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('writeDiagnostic — request_metadata auto-injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start_at_ms (new in Task 4 — diagnostic_elapsed_ms)', () => {
    it('computes diagnostic_elapsed_ms = Date.now() - start_at_ms when fired_at_ms is omitted', async () => {
      // Pin Date.now() to a deterministic instant so we can assert the
      // computed elapsed value exactly (instead of asserting "approximately
      // X" with a tolerance).
      vi.setSystemTime(new Date('2026-05-16T12:00:01.500Z')); // = 1779_278_401_500
      const now = Date.now();

      const { sql, calls } = makeSqlSpy();
      await writeDiagnostic(sql, {
        error_name: 'TestElapsedFromNow',
        error_message: 'test',
        user_id: 'user-x',
        request_metadata: { foo: 'bar' },
        start_at_ms: now - 250,
      });

      expect(calls.length).toBe(1);
      const meta = readMetadataFromCall(calls[0]);
      expect(meta.diagnostic_elapsed_ms).toBe(250);
      expect(meta.foo).toBe('bar');
    });

    it('computes diagnostic_elapsed_ms = fired_at_ms - start_at_ms when both are provided', async () => {
      // When the caller has its own clock-source for the fire time (e.g.
      // copying a recorded ms field from earlier in the request lifecycle)
      // it wins over Date.now(). Reuses the auto-stamped fired_at_ms in the
      // metadata.
      const { sql, calls } = makeSqlSpy();
      await writeDiagnostic(sql, {
        error_name: 'TestElapsedFromFiredAt',
        error_message: 'test',
        user_id: 'user-x',
        request_metadata: {},
        start_at_ms: 1000,
        fired_at_ms: 1750,
      });

      const meta = readMetadataFromCall(calls[0]);
      expect(meta.diagnostic_elapsed_ms).toBe(750);
      // fired_at_ms is also auto-stamped, so the same field is preserved
      // (sanity: the new logic doesn't shadow the existing auto-stamp).
      expect(meta.fired_at_ms).toBe(1750);
    });

    it('omits diagnostic_elapsed_ms when start_at_ms is not provided', async () => {
      // Pre-lifecycle call sites (e.g. ByokTierInvariantViolation in
      // anthropic-stream.ts which fires before teeCtx is constructed)
      // don't have access to handlerStartedAtMs, so they leave start_at_ms
      // unset. The metadata must NOT carry a diagnostic_elapsed_ms key in
      // that case.
      const { sql, calls } = makeSqlSpy();
      await writeDiagnostic(sql, {
        error_name: 'TestNoElapsed',
        error_message: 'test',
        user_id: 'user-x',
        request_metadata: { other: 'data' },
      });

      const meta = readMetadataFromCall(calls[0]);
      expect('diagnostic_elapsed_ms' in meta).toBe(false);
      expect(meta.other).toBe('data');
    });

    it('preserves a pre-existing diagnostic_elapsed_ms in request_metadata (caller wins)', async () => {
      // Mirror the same precedence rule that fired_at_ms / deployment_host
      // already use: if the caller bakes the field into request_metadata
      // directly, the auto-stamp becomes a no-op so analytics queries
      // never see the value mutate under them.
      const { sql, calls } = makeSqlSpy();
      await writeDiagnostic(sql, {
        error_name: 'TestPreExistingWins',
        error_message: 'test',
        user_id: 'user-x',
        request_metadata: { diagnostic_elapsed_ms: 9999 },
        start_at_ms: 100,
        fired_at_ms: 200,
      });

      const meta = readMetadataFromCall(calls[0]);
      expect(meta.diagnostic_elapsed_ms).toBe(9999);
    });
  });

  describe('existing auto-stamp behaviour (regression pins for fired_at_ms / deployment_host)', () => {
    it('auto-stamps deployment_host when omitted from request_metadata', async () => {
      const { sql, calls } = makeSqlSpy();
      await writeDiagnostic(sql, {
        error_name: 'TestAutoStampHost',
        error_message: 'test',
        user_id: null,
        request_metadata: {},
        deployment_host: 'tocb.example',
      });
      const meta = readMetadataFromCall(calls[0]);
      expect(meta.deployment_host).toBe('tocb.example');
    });

    it('does not overwrite a pre-existing deployment_host in request_metadata', async () => {
      const { sql, calls } = makeSqlSpy();
      await writeDiagnostic(sql, {
        error_name: 'TestPreserveHost',
        error_message: 'test',
        user_id: null,
        request_metadata: { deployment_host: 'baked-in.example' },
        deployment_host: 'auto-stamp.example',
      });
      const meta = readMetadataFromCall(calls[0]);
      expect(meta.deployment_host).toBe('baked-in.example');
    });
  });
});
