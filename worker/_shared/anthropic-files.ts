// Shared helper for fanning out Anthropic Files API DELETEs.
//
// Two call sites need the same bounded fan-out:
//   - worker/api/chart-files.ts  (Clear Chat: bulk-delete one chart's files)
//   - worker/api/delete-my-data.ts (GDPR Art. 17: delete one user's files)
//
// Both want the same concurrency cap, the same 404-as-success policy, and the
// same logging-on-failure behavior. They differ only in what they do with the
// failed-id list: delete-my-data needs it for an audit-row UPDATE so a future
// retry job can pick up stragglers; chart-files just discards it. The helper
// always returns the list and lets the caller ignore it.
//
// Each failure carries a `transient` flag so a future retry job can tell
// "Anthropic was 5xx, try again" apart from "Anthropic 4xx'd this id, retrying
// will keep failing" — matters for retry budgets and for not perpetually
// re-queueing genuinely-permanent failures.
//
// Concurrency is capped at 6 so a Clear-Chat on a 500-file chart doesn't fan
// out 500 simultaneous HTTP connections from the isolate (Workers has a
// subrequest limit and the fan-out would starve other in-flight requests).
const ANTHROPIC_DELETE_CONCURRENCY = 6;

/**
 * Per-id outcome.
 * - `ok`: deleted (200/204) OR already-gone (404).
 * - `transient`: 5xx or fetch-throw — retry might succeed.
 * - `permanent`: any other 4xx (auth/validation/etc) — retry will keep failing.
 */
export type DeleteOutcome =
  | { ok: true }
  | { ok: false; transient: true }
  | { ok: false; transient: false };

/** Failure shape returned from the fan-out, suitable for an audit row. */
export interface AnthropicFileDeleteFailure {
  fid: string;
  /** True for 5xx + network errors (retry might succeed). */
  transient: boolean;
}

// Per-id outcome: 200/204/404 (already gone) all count as success.
// Exported for unit tests so we can drive single-id behavior without
// reconstructing the chunked loop.
export async function deleteOneAnthropicFile(
  apiKey: string,
  fid: string,
  logPrefix = '[anthropic-files]',
): Promise<DeleteOutcome> {
  try {
    const upstream = await fetch(`https://api.anthropic.com/v1/files/${encodeURIComponent(fid)}`, {
      method: 'DELETE',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
      },
    });
    if (upstream.ok || upstream.status === 404) return { ok: true };
    const errText = await upstream.text().catch(() => '');
    console.error(
      `${logPrefix} Anthropic DELETE ${upstream.status} for file_id=${fid}: ${errText}`,
    );
    // 5xx is transient (server-side hiccup, retry might succeed); any other
    // non-2xx/non-404 is treated as permanent (4xx auth/validation/etc).
    const transient = upstream.status >= 500 && upstream.status < 600;
    return { ok: false, transient };
  } catch (err) {
    console.error(`${logPrefix} Anthropic DELETE fetch failed for file_id=${fid}:`, err);
    // Network-level failure (TCP reset, DNS, etc) — treat as transient.
    return { ok: false, transient: true };
  }
}

// Bounded-concurrency fan-out. Returns the file_ids that did NOT delete
// successfully so the caller can keep them in an audit/dead-letter row for a
// later retry. chart-files.ts can safely ignore the return value.
//
// Semantics: each chunk waits for the slowest member to settle before the next
// chunk starts (wave concurrency, not a pool). This matches both prior
// implementations and keeps the upper bound on simultaneous in-flight requests
// at exactly ANTHROPIC_DELETE_CONCURRENCY.
export async function fanOutAnthropicFileDeletes(
  apiKey: string,
  fileIds: readonly string[],
  logPrefix = '[anthropic-files]',
): Promise<AnthropicFileDeleteFailure[]> {
  const failed: AnthropicFileDeleteFailure[] = [];
  for (let i = 0; i < fileIds.length; i += ANTHROPIC_DELETE_CONCURRENCY) {
    const chunk = fileIds.slice(i, i + ANTHROPIC_DELETE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(
        async (fid): Promise<[string, DeleteOutcome]> => [
          fid,
          await deleteOneAnthropicFile(apiKey, fid, logPrefix),
        ],
      ),
    );
    for (const [fid, outcome] of results) {
      if (!outcome.ok) failed.push({ fid, transient: outcome.transient });
    }
  }
  return failed;
}
