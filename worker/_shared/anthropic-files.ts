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
// Concurrency is capped at 6 so a Clear-Chat on a 500-file chart doesn't fan
// out 500 simultaneous HTTP connections from the isolate (Workers has a
// subrequest limit and the fan-out would starve other in-flight requests).
const ANTHROPIC_DELETE_CONCURRENCY = 6;

// Per-id outcome: 200/204/404 (already gone) all count as success.
// Exported for unit tests so we can drive single-id behavior without
// reconstructing the chunked loop.
export async function deleteOneAnthropicFile(
  apiKey: string,
  fid: string,
  logPrefix = '[anthropic-files]',
): Promise<boolean> {
  try {
    const upstream = await fetch(`https://api.anthropic.com/v1/files/${encodeURIComponent(fid)}`, {
      method: 'DELETE',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
      },
    });
    if (upstream.ok || upstream.status === 404) return true;
    const errText = await upstream.text().catch(() => '');
    console.error(
      `${logPrefix} Anthropic DELETE ${upstream.status} for file_id=${fid}: ${errText}`,
    );
    return false;
  } catch (err) {
    console.error(`${logPrefix} Anthropic DELETE fetch failed for file_id=${fid}:`, err);
    return false;
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
): Promise<string[]> {
  const failed: string[] = [];
  for (let i = 0; i < fileIds.length; i += ANTHROPIC_DELETE_CONCURRENCY) {
    const chunk = fileIds.slice(i, i + ANTHROPIC_DELETE_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(
        async (fid): Promise<[string, boolean]> => [
          fid,
          await deleteOneAnthropicFile(apiKey, fid, logPrefix),
        ],
      ),
    );
    for (const [fid, ok] of results) if (!ok) failed.push(fid);
  }
  return failed;
}
