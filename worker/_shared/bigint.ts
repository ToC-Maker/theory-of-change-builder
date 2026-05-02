/**
 * Coerce a Neon-returned `cost_micro_usd`-shaped value into a `bigint`.
 *
 * Neon's `BIGINT` columns deserialize differently depending on driver
 * version: a small int may arrive as `number`, a value past `2^53` as
 * `bigint`, and some legacy paths surface the column as `string`. The
 * call sites that consume these values do exact bigint arithmetic
 * (cost-cap accounting), so any silent `Number`-coercion mid-pipeline
 * truncates at `Number.MAX_SAFE_INTEGER` and corrupts the cap. Funnel
 * every conversion through this single helper to make the contract
 * — and any future driver behavior change — easy to audit.
 *
 * `null` / `undefined` map to `0n` rather than throwing because every
 * call site treats "missing row" or "zero spend" identically; a thrown
 * exception here would force defensive try/catch at every read site.
 */
export function toBigInt(v: bigint | number | string | null | undefined): bigint {
  if (v === null || v === undefined) return 0n;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  // Neon returns BIGINT as string for driver versions that disable the
  // numeric-bigint path; `BigInt('123')` is the canonical parse.
  return BigInt(v);
}
