/**
 * Wire-format shapes for saving and polling a chart (client ↔ Worker).
 *
 * Every change to a stored chart's content advances its integer `version`
 * (writing identical content leaves it unchanged). A save names
 * the version it was based on; the Worker applies it only if that is still the
 * current version (compare-and-swap) and otherwise answers 409 with the latest
 * chart, which the client merges before saving again. A poll names the version
 * the client already has and receives the chart only when it differs.
 *
 * `chartData` stays `unknown` on purpose: the Worker round-trips it as JSONB
 * without looking inside, and the client normalises whatever arrives before
 * using it.
 *
 * Cross-references:
 *  - `worker/api/updateChart.ts` parses `UpdateChartRequest` and answers with
 *    `UpdateChartOk` (200) or `UpdateChartConflict` (409).
 *  - `worker/api/pollChart.ts` parses `PollChartRequest` and answers with
 *    `PollChartResponse`.
 *  - `worker/api/getChart.ts` and `worker/api/createChart.ts` add the current
 *    `version` to their existing responses.
 *  - `isChartVersion` is what both endpoints use to reject a malformed
 *    `baseVersion` or `knownVersion` with 400 instead of a database error.
 */

export interface UpdateChartRequest {
  editToken: string;
  chartData: unknown;
  /**
   * The version this save was based on: a positive integer. Absent only from
   * tabs still running the previous client, whose save is applied without the
   * check (last save wins) and, if it changes the chart, still advances the
   * version.
   */
  baseVersion?: number;
}

export interface UpdateChartOk {
  success: true;
  /** The version this save produced. */
  version: number;
}

export interface UpdateChartConflict {
  error: 'conflict';
  /** The current version, which differs from the save's `baseVersion`: newer, or older after a database restore. */
  version: number;
  /** The chart as stored at `version`. */
  chartData: unknown;
}

export interface PollChartRequest {
  editToken: string;
  /** The version the caller already holds. */
  knownVersion: number;
}

export interface PollChartResponse {
  /** The current version. */
  version: number;
  /** Present only when `version` differs from the request's `knownVersion`. */
  chartData?: unknown;
}

/** A version is a positive int4: `charts.version` is an INTEGER column. */
export function isChartVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 2 ** 31 - 1;
}
