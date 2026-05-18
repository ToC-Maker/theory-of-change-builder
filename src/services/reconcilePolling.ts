// Client-side reconcile-polling machinery for /api/reconcile-cost.
//
// Three responsibilities, formerly tangled inside chatService.ts:
//
//  1. `enqueuePendingReconcile` / `drainPendingReconciles` — the
//     network-failure retry queue. localStorage-backed so an entry that
//     POSTed-but-failed survives a reload; 7-day GC bound. Drain emits
//     ONE POST per stored entry; drops on `reconciled:true` or 4xx,
//     keeps on `reconciled:false` or 5xx / network error.
//
//  2. `pollUntilReconciled` — the just-ended-stream follow-up. Polls
//     /api/reconcile-cost every 1s until `reconciled:true` OR 30s
//     elapse (safety bound). Bumps the BYOK pill on every strict
//     `cost_settled_micro_usd` increase.
//
//  3. `postReconcileOnce` — shared single-POST helper consumed by both
//     of the above. Returns a discriminated result so callers can branch
//     on `{ok, reconciled, cost_settled_micro_usd}` (success) vs
//     `{ok:false, status}` (network/HTTP failure).
//
// Why a separate module: the polling/queue logic doesn't depend on the
// streaming state (SSE reader, CostTracker, fetch teardown). Splitting
// it out (a) keeps chatService.ts focused on streaming, (b) lets tests
// exercise the queue + polling without standing up the full chat
// pipeline, and (c) lets the future "reconcile from a Web Worker"
// experiment live behind the same surface.
//
// The wire shape of the /api/reconcile-cost response is fixed by
// worker/api/reconcile-cost.ts:
//   { applied: boolean,           // helper actually advanced the row?
//     delta: string,              // µUSD credited to user_api_usage
//     new_settled: string,        // settled value the helper wrote (0 if !applied)
//     cost_settled_micro_usd: string, // CURRENT row value (post-IIFE if applicable)
//     reconciled: boolean }       // reconciled_at IS NOT NULL?
//
// `cost_settled_micro_usd` is the authoritative figure the pill should
// match. `reconciled` is the stop signal for polling.

const PENDING_RECONCILE_KEY = 'byok-reconcile-pending';
const PENDING_RECONCILE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** 30s safety bound on pollUntilReconciled — bounds resource use if the worker
 * died mid-IIFE and `reconciled_at` will never be stamped. */
const POLL_BUDGET_MS = 30_000;
/** Inter-poll cadence: each tick re-POSTs the latest queued figure. */
const POLL_INTERVAL_MS = 1_000;

/**
 * Module-level set of `logging_message_id`s currently being polled by an
 * active `pollUntilReconciled`. Read by `drainPendingReconciles` so a
 * concurrent drain skips these entries (otherwise drain and poll would
 * race on the same baseline and double-credit the BYOK pill bump).
 */
const activePollIds = new Set<string>();

/** Read-only view for callers that need to coordinate with the active set
 *  (chatService's drain wrapper uses this; tests use it to verify lifecycle).
 *  Returns the live Set — callers MUST NOT mutate. */
export function getActivePollIds(): ReadonlySet<string> {
  return activePollIds;
}

// Re-export so tests can plant fixtures directly into the same key the
// production code reads/writes. Not part of the public API surface
// consumed by chatService.ts.
export { PENDING_RECONCILE_KEY };

// ---------------------------------------------------------------------------
// Queue persistence (localStorage)
// ---------------------------------------------------------------------------

export interface PendingReconcile {
  logging_message_id: string;
  cost_micro_usd: string;
  queued_at: number;
  /**
   * Whether the server has reported `reconciled:true` for this entry. New
   * entries start at `false`; flips to `true` after a successful POST
   * observes `reconciled:true`. (At that point the entry is dropped from
   * the queue, so a persisted `reconciled:true` row should never appear
   * in practice. The field is kept on the type for future-proofing — e.g.
   * if we ever want to track "successfully reconciled" entries for one
   * more session before dropping.)
   */
  reconciled?: boolean;
  /**
   * Chart edit-token-or-id at the moment the stream ran, snapshotted for
   * pill-bump routing. Null/undefined for non-BYOK streams or when the
   * stream didn't carry a chart context. Drain/poll uses this together
   * with `keyLast4` to credit the per-chart and per-key BYOK pills via
   * `onCostBump`.
   */
  chartId?: string | null;
  /**
   * Last 4 chars of the BYOK key in use during the stream. Same routing
   * intent as `chartId`. Null/undefined for non-BYOK streams.
   */
  keyLast4?: string | null;
}

function isPendingReconcile(v: unknown): v is PendingReconcile {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.logging_message_id === 'string' &&
    o.logging_message_id.length > 0 &&
    typeof o.cost_micro_usd === 'string' &&
    o.cost_micro_usd.length > 0 &&
    typeof o.queued_at === 'number' &&
    Number.isFinite(o.queued_at)
  );
}

function readPendingReconciles(): PendingReconcile[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(PENDING_RECONCILE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingReconcile);
  } catch (e) {
    // Corrupt JSON: discard. Better to lose the queue than to keep retrying
    // on every drain cycle with a parse error.
    console.warn('[reconcile-polling] discarding corrupt reconcile queue:', e);
    return [];
  }
}

function writePendingReconciles(items: PendingReconcile[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (items.length === 0) {
      localStorage.removeItem(PENDING_RECONCILE_KEY);
    } else {
      localStorage.setItem(PENDING_RECONCILE_KEY, JSON.stringify(items));
    }
  } catch (e) {
    console.warn('[reconcile-polling] failed to persist pending reconciles:', e);
  }
}

/**
 * Add a reconcile to the retry queue, deduping by logging_message_id. The
 * latest call wins on cost + chart context (this matters when polling: the
 * just-ended stream's pre-enqueue lands first with the tracker's last figure,
 * then post-stream poll responses bump the queued cost as the server's
 * `cost_settled` advances). Always stamps `queued_at = now` so staleness GC
 * measures from the latest attempt, not the first.
 *
 * Note: this does NOT clear the `reconciled` flag — if a caller re-enqueues
 * an entry that was already marked reconciled, we'd keep that state. In
 * practice reconciled entries are dropped on POST, not re-enqueued.
 */
export function enqueuePendingReconcile(entry: {
  logging_message_id: string;
  cost_micro_usd: string;
  chartId?: string | null;
  keyLast4?: string | null;
}): void {
  const existing = readPendingReconciles().filter(
    (p) => p.logging_message_id !== entry.logging_message_id,
  );
  existing.push({
    logging_message_id: entry.logging_message_id,
    cost_micro_usd: entry.cost_micro_usd,
    queued_at: Date.now(),
    reconciled: false,
    chartId: entry.chartId ?? null,
    keyLast4: entry.keyLast4 ?? null,
  });
  writePendingReconciles(existing);
}

// ---------------------------------------------------------------------------
// Pill-bump callback contract
// ---------------------------------------------------------------------------

/**
 * Argument shape for `onCostBump` callbacks. Fired when a server response
 * reports `cost_settled_micro_usd` strictly greater than the entry's
 * baseline (`cost_micro_usd`). The callback should credit the delta to the
 * appropriate BYOK pill bucket (per-chart + per-key).
 */
export interface CostBumpEvent {
  chartId: string;
  keyLast4: string;
  /** µUSD to add to the pill — strictly positive. */
  deltaMicroUsd: bigint;
  /** The new authoritative server figure. Useful for logging. */
  newSettledMicroUsd: bigint;
}

export type OnCostBump = (event: CostBumpEvent) => void;

// ---------------------------------------------------------------------------
// Single-POST helper
// ---------------------------------------------------------------------------

export interface PostReconcileOnceArgs {
  logging_message_id: string;
  cost_micro_usd: string;
  authToken: string | null;
  /** Per-chart BYOK pill key (snapshotted at stream start). */
  chartId?: string | null;
  /** Last-4 of the BYOK key in use at stream start. */
  keyLast4?: string | null;
  /** Called once per strict-increase server response. See {@link CostBumpEvent}. */
  onCostBump?: OnCostBump;
}

export type PostReconcileResult =
  | {
      ok: true;
      status: number;
      reconciled: boolean;
      cost_settled_micro_usd: bigint;
      applied: boolean;
    }
  | {
      ok: false;
      /** 0 = network/fetch threw; >=400 = HTTP status. Callers use 4xx vs
       *  5xx to decide drop-vs-retry semantics. */
      status: number;
    };

/**
 * Single POST to /api/reconcile-cost. Parses the JSON response, fires
 * `onCostBump` on strict `cost_settled` increase, and returns a discriminated
 * `PostReconcileResult` so callers can branch on success-with-state vs
 * failure-with-status.
 *
 * Failure modes:
 *  - fetch throws (network drop, CORS, etc.) → `{ok:false, status:0}`
 *  - HTTP 4xx → `{ok:false, status:NNN}`. Caller should drop the entry
 *    (definitive reject — row gone, ownership mismatch, etc.).
 *  - HTTP 5xx → `{ok:false, status:5NN}`. Caller should retry later.
 *  - HTTP 2xx with unparseable body → treated as `{ok:false, status:200}`
 *    so the entry stays queued (better than dropping a paid-for reconcile
 *    because the server returned malformed JSON).
 */
export async function postReconcileOnce(args: PostReconcileOnceArgs): Promise<PostReconcileResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (args.authToken) headers['Authorization'] = `Bearer ${args.authToken}`;

  let resp: Response;
  try {
    resp = await fetch('/api/reconcile-cost', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({
        logging_message_id: args.logging_message_id,
        cost_micro_usd: args.cost_micro_usd,
      }),
    });
  } catch {
    return { ok: false, status: 0 };
  }

  if (!resp.ok) {
    return { ok: false, status: resp.status };
  }

  let body: {
    applied?: boolean;
    cost_settled_micro_usd?: string;
    reconciled?: boolean;
  };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    // Body unparseable — treat as failure so the caller keeps the entry
    // queued (we don't want a malformed response to silently drop a
    // not-yet-reconciled entry).
    return { ok: false, status: resp.status };
  }

  // Defensive parse: missing fields fall back to safe defaults (cost=0,
  // reconciled=false). This matches the worker's 200-no-op shape
  // (`current_settled_micro_usd:"0"`, `reconciled:false`) for foreign /
  // missing rows.
  let settled: bigint;
  try {
    settled = BigInt(body.cost_settled_micro_usd ?? '0');
  } catch {
    settled = 0n;
  }
  const reconciled = body.reconciled === true;

  // Fire pill bump on strict increase, only when chart/key context is set
  // (otherwise the stream wasn't BYOK and the pill doesn't apply).
  if (args.onCostBump && args.chartId && args.keyLast4) {
    let baseline: bigint;
    try {
      baseline = BigInt(args.cost_micro_usd);
    } catch {
      baseline = 0n;
    }
    if (settled > baseline) {
      args.onCostBump({
        chartId: args.chartId,
        keyLast4: args.keyLast4,
        deltaMicroUsd: settled - baseline,
        newSettledMicroUsd: settled,
      });
    }
  }

  return {
    ok: true,
    status: resp.status,
    reconciled,
    cost_settled_micro_usd: settled,
    applied: body.applied === true,
  };
}

// ---------------------------------------------------------------------------
// Drain: one POST per queued entry
// ---------------------------------------------------------------------------

/**
 * Attempt to POST every queued reconcile. Items that succeed AND
 * `reconciled:true` are dropped. Items that succeed with `reconciled:false`
 * stay queued (the next page load tries again) — their baseline is bumped
 * to the latest `cost_settled` so subsequent calls credit incremental deltas.
 * Items that hit 4xx are dropped (definitive reject). 5xx and network
 * errors stay queued for retry. Stale items (>7d) are GC'd before any POST.
 *
 * NOT a polling loop — one shot per entry. Repeated invocations (online
 * event, auth set, page load, post-stream) re-POST the queue. The
 * just-ended-stream's rapid 30s × 1s convergence lives in
 * `pollUntilReconciled`, not here.
 *
 * `skipMessageIds` lets the caller exclude entries that are currently being
 * handled by an active `pollUntilReconciled`. Without this, the stream-end
 * drain and the just-kicked-off poll would race on the same entry: drain
 * could read the original baseline while the poll's first tick is still in
 * flight, then both POST the same baseline, see the same `cost_settled`,
 * and both fire the bump — double-credit on the pill. With it, the drain
 * leaves the polled entry alone (poll exclusively owns its baseline writes
 * for the 30s window).
 *
 * Best-effort: never throws. Callers fire-and-forget.
 */
export async function drainPendingReconciles(
  authToken: string | null,
  onCostBump?: OnCostBump,
  skipMessageIds?: ReadonlySet<string>,
): Promise<void> {
  const all = readPendingReconciles();
  if (all.length === 0) return;

  const now = Date.now();
  const fresh = all.filter((p) => now - p.queued_at < PENDING_RECONCILE_STALE_MS);
  if (fresh.length === 0) {
    writePendingReconciles([]);
    return;
  }

  const remaining: PendingReconcile[] = [];
  for (const item of fresh) {
    // Polled-by-someone-else: skip the POST, leave the entry as-is so
    // the active poller's writes (baseline bumps, eventual drop on
    // reconciled:true) take effect.
    if (skipMessageIds?.has(item.logging_message_id)) {
      remaining.push(item);
      continue;
    }
    const result = await postReconcileOnce({
      logging_message_id: item.logging_message_id,
      cost_micro_usd: item.cost_micro_usd,
      authToken,
      chartId: item.chartId ?? null,
      keyLast4: item.keyLast4 ?? null,
      onCostBump,
    });

    if (!result.ok) {
      // 4xx → drop (definitive reject). 5xx, network → keep for next drain.
      if (result.status >= 400 && result.status < 500) continue;
      remaining.push(item);
      continue;
    }
    if (result.reconciled) continue; // drop — server says we're done

    // Server returned 200 + reconciled=false. Keep the entry, but advance
    // the baseline to the latest server figure so the next drain (a) doesn't
    // double-credit the pill, (b) shows the right "delta vs last seen"
    // increment when the IIFE finally lands.
    const newBaseline =
      result.cost_settled_micro_usd > BigInt(item.cost_micro_usd)
        ? result.cost_settled_micro_usd.toString()
        : item.cost_micro_usd;
    remaining.push({
      ...item,
      cost_micro_usd: newBaseline,
    });
  }
  writePendingReconciles(remaining);
}

// ---------------------------------------------------------------------------
// Polling: 30s × 1s for the just-ended stream
// ---------------------------------------------------------------------------

export interface PollUntilReconciledArgs {
  logging_message_id: string;
  /** The tracker's last cost figure at stream end. Used as the initial
   *  baseline for pill-bump delta math + as the POST body cost. */
  cost_micro_usd: string;
  authToken: string | null;
  chartId?: string | null;
  keyLast4?: string | null;
  onCostBump?: OnCostBump;
}

/**
 * Poll /api/reconcile-cost every 1s for up to 30s, stopping on:
 *  - `reconciled:true` (server's post-stream IIFE finished — the canonical
 *    success exit).
 *  - 4xx response (definitive reject — row gone, ownership mismatch).
 *  - 30s wall clock (safety bound — IIFE may have died on a Cloudflare
 *    time budget; we don't poll forever).
 *
 * Each tick re-POSTs the latest known baseline. When the server reports a
 * higher `cost_settled`, the baseline advances (so the next tick's POST
 * body matches the server's view; the GREATEST clamp makes this a no-op
 * server-side, but it keeps the pill-bump delta math consistent).
 *
 * Cleans up the queue entry for this `logging_message_id` on
 * reconciled=true. Leaves it in place on timeout or 4xx so a future
 * page-load drain can attempt once more.
 *
 * Best-effort: never throws.
 */
export async function pollUntilReconciled(args: PollUntilReconciledArgs): Promise<void> {
  const startMs = Date.now();
  let currentBaseline = args.cost_micro_usd;

  // Register active poll so concurrent drains skip this entry. The Set
  // lookup in drainPendingReconciles avoids the drain-poll race that would
  // otherwise double-credit the BYOK pill (both observing the same
  // cost_settled bump and both firing onCostBump).
  activePollIds.add(args.logging_message_id);

  try {
    // Loop until reconciled, 30s elapsed, or 4xx.
    // First POST fires immediately; subsequent ticks wait 1s.
    let firstTick = true;
    while (Date.now() - startMs < POLL_BUDGET_MS) {
      if (!firstTick) {
        await sleep(POLL_INTERVAL_MS);
      }
      firstTick = false;

      const result = await postReconcileOnce({
        logging_message_id: args.logging_message_id,
        cost_micro_usd: currentBaseline,
        authToken: args.authToken,
        chartId: args.chartId ?? null,
        keyLast4: args.keyLast4 ?? null,
        onCostBump: args.onCostBump,
      });

      if (!result.ok) {
        if (result.status >= 400 && result.status < 500) {
          // 4xx → definitive reject. Stop polling; leave queue entry in place
          // (drainPendingReconciles will drop it on the next pass).
          return;
        }
        // 5xx / network → next tick retries.
        continue;
      }

      // Bump baseline so the next tick's POST + the queue's persisted
      // baseline both stay in sync with the server's view.
      if (result.cost_settled_micro_usd > BigInt(currentBaseline)) {
        currentBaseline = result.cost_settled_micro_usd.toString();
        updateQueueBaseline(args.logging_message_id, currentBaseline);
      }

      if (result.reconciled) {
        // Done — drop the queue entry.
        dropQueueEntry(args.logging_message_id);
        return;
      }
    }

    // 30s timeout: leave the queue entry in place with its latest baseline so
    // the next page-load drain attempts one more catch-up POST.
  } finally {
    activePollIds.delete(args.logging_message_id);
  }
}

function updateQueueBaseline(loggingMessageId: string, newBaseline: string): void {
  const items = readPendingReconciles();
  let mutated = false;
  for (const item of items) {
    if (item.logging_message_id === loggingMessageId) {
      if (item.cost_micro_usd !== newBaseline) {
        item.cost_micro_usd = newBaseline;
        mutated = true;
      }
    }
  }
  if (mutated) writePendingReconciles(items);
}

function dropQueueEntry(loggingMessageId: string): void {
  const items = readPendingReconciles();
  const filtered = items.filter((p) => p.logging_message_id !== loggingMessageId);
  if (filtered.length !== items.length) writePendingReconciles(filtered);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Test-only helpers (NOT for production use)
// ---------------------------------------------------------------------------

export function __test_clearQueue(): void {
  writePendingReconciles([]);
}

export function __test_readQueue(): PendingReconcile[] {
  return readPendingReconciles();
}
