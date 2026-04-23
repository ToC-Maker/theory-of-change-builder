/**
 * Probes a user-supplied Anthropic API key via /v1/messages/count_tokens.
 *
 * Returns:
 *   - 'verified' on 200 (key is valid and has Messages API access)
 *   - 'invalid'  on 401 or 403 (bad or revoked key)
 *   - 'error'    on anything else (Anthropic outage, network error)
 *
 * The raw key is never logged. Anthropic's documented error bodies don't
 * echo the submitted x-api-key, so draining resp.text() into an error log
 * is safe.
 */
export async function probeAnthropicKey(
  userKey: string,
  logPrefix: string,
): Promise<'verified' | 'invalid' | 'error'> {
  let resp: Response;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': userKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
  } catch (e) {
    console.error(`[${logPrefix}] Anthropic probe: network error`, e);
    return 'error';
  }

  if (resp.ok) return 'verified';
  if (resp.status === 401 || resp.status === 403) return 'invalid';

  let detail = '';
  try {
    detail = await resp.text();
  } catch {
    /* ignore */
  }
  console.error(`[${logPrefix}] Anthropic probe: unexpected status ${resp.status}`, detail);
  return 'error';
}
