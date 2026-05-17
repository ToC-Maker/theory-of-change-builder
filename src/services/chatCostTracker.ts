// Client-side cost tracker for the SSE chat stream.
//
// Extracted from chatService.ts (Task 10 of byok-cost-stream-recovery) so the
// per-`content_block_delta` cost estimation, the running-locals MAX merge,
// and the `/api/reconcile-cost` debounce/transport logic can be unit-tested
// without spinning up the full chat-streaming machinery (?raw prompt
// imports, fetch/SSE plumbing, AbortController wiring).
//
// Public surface mirrors what chatService.ts needs:
//   - `new CostTracker({ model, onCostUpdate, loggingMessageId, authToken, onFetchFailure? })`
//   - `recordOutputChars(charCount)` — call on every `content_block_delta`
//     `text_delta` / `thinking_delta`. Bumps `runningOutputChars`, recomputes
//     `lastCostMicroUsd`, fires `onCostUpdate` if cost strictly increased,
//     and triggers `maybePostReconcile()`.
//   - `recordUsage(usage)` — call on `message_start.message.usage` and
//     `message_delta.usage`. MAX-merges per field into running locals
//     (C8 fix in plan: never use shallow-merged `usage` object — it can
//     lose `cache_creation_input_tokens` if a later delta omits it). The
//     output token count is also MAX-merged against the char-derived
//     estimate.
//   - `recordServerCostMicroUsd(parsed)` — call on `running_cost` SSE frame
//     when `cost_micro_usd` is a parseable bigint. The server-tracked
//     value can dominate the client's reconstruction; only frames with a
//     strictly-higher value than the current `lastCostMicroUsd` update it.
//   - `maybePostReconcile(force?, useBeacon?)` — POST to /api/reconcile-cost.
//     Debounced by $0.01 / 5s (when force=false). When useBeacon=true,
//     tries `navigator.sendBeacon` first (survives unload), falls back to
//     `fetch` if beacon is missing or refuses.
//
// Output-only fallback: until a `running_cost` SSE frame arrives (or a
// `message_start` usage event lands input data), `runningInput` /
// `runningCacheCreate` / `runningCacheRead` / `runningWebSearch` remain 0
// and the client's estimate contributes only the output-side cost. This is
// strictly better than the previous "wait until message_stop" behavior —
// the BYOK pill catches up to the streaming reality before the user clicks
// Stop. C3 fix in plan: also fires `onCostUpdate` so the pill updates in
// real time, not just `lastCostMicroUsd` (which only fed the post-stream
// reconcile POST).
import { computeCostMicroUsd, type AnthropicUsage } from '../../shared/cost';

/** $0.01 in µUSD — minimum cost delta between consecutive /api/reconcile-cost POSTs. */
const RECONCILE_THRESHOLD_MICRO = 10_000n;
/** 5 seconds — maximum gap between consecutive periodic /api/reconcile-cost POSTs. */
const RECONCILE_INTERVAL_MS = 5_000;

export interface CostTrackerOptions {
  /** Anthropic model id. Drives the per-token rate via shared/cost.ts. */
  model: string;
  /** Fired with running cost in USD on every strict increase. C3 fix: keeps the BYOK pill live. */
  onCostUpdate?: (runningCostUsd: number) => void;
  /** logging_messages.id this stream writes against. Required for /api/reconcile-cost POSTs. */
  loggingMessageId: string | undefined;
  /** JWT for the user (if authed). When present, appended as `Authorization: Bearer …`. */
  authToken: string | null;
  /**
   * Optional override that suppresses outgoing /api/reconcile-cost POSTs.
   * Used by tests so the cadence/debounce can be verified without touching
   * fetch/navigator. When unset, the tracker uses globalThis.fetch /
   * globalThis.navigator.sendBeacon directly.
   */
  postReconcile?: (req: ReconcileRequest) => void;
  /**
   * Called when a fetch-mode reconcile POST throws (network error) or
   * resolves to 5xx. The chatService passes `enqueuePendingReconcile` so
   * the retry queue picks up the entry; tests pass a spy.
   */
  onFetchFailure?: (req: { logging_message_id: string; cost_micro_usd: string }) => void;
}

export interface ReconcileRequest {
  logging_message_id: string;
  cost_micro_usd: string;
  force: boolean;
  useBeacon: boolean;
  authToken: string | null;
}

export class CostTracker {
  // Running locals (MAX-merged per field — C7/C8 fix in plan).
  private runningInput = 0;
  private runningOutput = 0;
  private runningCacheCreate = 0;
  private runningCacheRead = 0;
  private runningWebSearch = 0;
  /** Character count accumulated from `content_block_delta` events. Output = max(usage.output_tokens, ceil(chars/4)). */
  private runningOutputChars = 0;

  /** Latest µUSD figure (any source: client compute, server running_cost frame). Monotone-non-decreasing. */
  private _lastCostMicroUsd: bigint = 0n;

  // Debounce state for periodic reconcile. lastPostTime is initialized to the
  // tracker's construction time, NOT 0 — otherwise the very first sub-threshold
  // POST would always fire because `now - 0` is huge. The intent of "$0.01 OR
  // 5s" is per-stream cadence, not "fire on first call regardless".
  private lastPostedMicro: bigint = 0n;
  private lastPostTime: number;

  private readonly opts: CostTrackerOptions;

  constructor(opts: CostTrackerOptions) {
    this.opts = opts;
    this.lastPostTime = Date.now();
  }

  get lastCostMicroUsd(): bigint {
    return this._lastCostMicroUsd;
  }

  /**
   * Add `chars` to the rolling output-character counter, then recompute cost.
   * Fires onCostUpdate / maybePostReconcile if the new cost strictly exceeds
   * the previous one. Output tokens are estimated as `ceil(runningOutputChars / 4)`.
   */
  recordOutputChars(chars: number): void {
    if (chars <= 0) return;
    this.runningOutputChars += chars;
    this.recomputeAndPropagate();
  }

  /**
   * MAX-merge a usage event into the running locals, then recompute cost.
   * The MAX semantics protect against out-of-order or partial Anthropic
   * frames (e.g. a later `message_delta.usage` that omits cache fields).
   */
  recordUsage(usage: Partial<AnthropicUsage>): void {
    this.runningInput = Math.max(this.runningInput, usage.input_tokens ?? 0);
    this.runningOutput = Math.max(this.runningOutput, usage.output_tokens ?? 0);
    this.runningCacheCreate = Math.max(
      this.runningCacheCreate,
      usage.cache_creation_input_tokens ?? 0,
    );
    this.runningCacheRead = Math.max(this.runningCacheRead, usage.cache_read_input_tokens ?? 0);
    this.runningWebSearch = Math.max(
      this.runningWebSearch,
      usage.server_tool_use?.web_search_requests ?? 0,
    );
    this.recomputeAndPropagate();
  }

  /**
   * Integrate a server-side `running_cost` SSE frame's µUSD figure. Only
   * raises `lastCostMicroUsd` (never lowers — stale/out-of-order frames
   * cannot regress the live total).
   */
  recordServerCostMicroUsd(parsed: bigint): void {
    if (parsed < 0n) return;
    if (parsed <= this._lastCostMicroUsd) return;
    this._lastCostMicroUsd = parsed;
    this.fireOnCostUpdate(Number(parsed) / 1_000_000);
    this.maybePostReconcile();
  }

  /**
   * Debounced POST to /api/reconcile-cost.
   *
   * - force=false: only fires when cost delta ≥ $0.01 OR ≥ 5s since last POST.
   * - useBeacon=true: tries navigator.sendBeacon first (survives unload),
   *   falls back to fetch if it's missing or returns false.
   *
   * No-op if loggingMessageId is unset or cost is 0.
   */
  maybePostReconcile(force = false, useBeacon = false): void {
    const lmid = this.opts.loggingMessageId;
    if (!lmid) return;
    const cost = this._lastCostMicroUsd;
    if (cost <= 0n) return;

    const now = Date.now();
    const deltaSinceLast = cost - this.lastPostedMicro;
    const timeSinceLast = now - this.lastPostTime;
    if (
      !force &&
      deltaSinceLast < RECONCILE_THRESHOLD_MICRO &&
      timeSinceLast < RECONCILE_INTERVAL_MS
    ) {
      return;
    }
    this.lastPostedMicro = cost;
    this.lastPostTime = now;

    if (this.opts.postReconcile) {
      this.opts.postReconcile({
        logging_message_id: lmid,
        cost_micro_usd: cost.toString(),
        force,
        useBeacon,
        authToken: this.opts.authToken,
      });
      return;
    }

    const body = JSON.stringify({
      logging_message_id: lmid,
      cost_micro_usd: cost.toString(),
    });
    const failurePayload = { logging_message_id: lmid, cost_micro_usd: cost.toString() };

    // Unload path (useBeacon=true) — the strict ordering below is load-bearing.
    // DO NOT "simplify" this back to a transport-first sequence: see W2 finding B.
    //
    //   1. Pre-enqueue to the localStorage retry queue FIRST. This is the
    //      only step that's guaranteed to complete even if the JS context is
    //      torn down a millisecond from now (visibilitychange='hidden' on
    //      mobile, bfcache eviction, browser quit). If neither transport
    //      below survives, the next session's drainPendingReconciles picks
    //      this entry up and replays it.
    //   2. Attempt navigator.sendBeacon. If queued, great — the OS will
    //      deliver it whether or not this page survives. The pre-enqueued
    //      retry entry is now redundant but harmless: server-side GREATEST
    //      clamp + reconciled_at lock make a duplicate POST a no-op (and
    //      drainPendingReconciles will dequeue it after a 2xx).
    //   3. If sendBeacon refuses (quota / refused / missing API), fall
    //      through to fetch as a best-effort cleanup. fetch failure no
    //      longer matters because the entry's already in the queue from
    //      step 1; even synchronous teardown errors are swallowed below.
    if (useBeacon) {
      try {
        this.opts.onFetchFailure?.(failurePayload);
      } catch (e) {
        // The retry-queue persistence hook should never throw, but if a
        // bug or full-localStorage quota does it, don't let it abort the
        // transport attempts.
        console.error('[cost-tracker] onFetchFailure pre-enqueue threw:', e);
      }
    }

    if (useBeacon && hasSendBeacon()) {
      try {
        const queued = navigator.sendBeacon(
          '/api/reconcile-cost',
          new Blob([body], { type: 'application/json' }),
        );
        if (queued) return;
        // Beacon refused — fall through to fetch.
      } catch (e) {
        // sendBeacon shouldn't throw, but some browsers historically have
        // (e.g. quota errors as exceptions instead of `false`). Fall through.
        console.error('[cost-tracker] sendBeacon threw:', e);
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.opts.authToken) headers['Authorization'] = `Bearer ${this.opts.authToken}`;

    // Wrap the fetch call so a synchronous teardown error (some browsers
    // throw mid-unload instead of returning a rejected promise) can't
    // escape the unload path. On the periodic (useBeacon=false) path the
    // .catch below still routes failures into the retry queue; on the
    // unload path the pre-enqueue above is the durable record.
    try {
      void fetch('/api/reconcile-cost', { method: 'POST', credentials: 'include', headers, body })
        .then((resp) => {
          // 5xx → enqueue for retry. 4xx → drop (definitive reject). 2xx → success.
          if (!resp.ok && resp.status >= 500) this.opts.onFetchFailure?.(failurePayload);
        })
        .catch(() => this.opts.onFetchFailure?.(failurePayload));
    } catch (e) {
      // fetch() threw synchronously — best-effort log + retry enqueue.
      // On the unload path the retry entry already landed in step 1 above;
      // on the periodic path this is the only retry signal.
      console.error('[cost-tracker] fetch threw synchronously:', e);
      try {
        this.opts.onFetchFailure?.(failurePayload);
      } catch {
        /* swallow: nothing useful to do during a teardown */
      }
    }
  }

  /**
   * Recompute the running cost and propagate any strict increase.
   *
   * The output token count fed to computeCostMicroUsd is
   * `max(runningOutput, ceil(runningOutputChars / 4))`. This handles both
   * cases: an authoritative usage event (Anthropic-side count) and the
   * char-derived live estimate during streaming. MAX-monotone in both
   * directions, so a small char-delta after a large server count can't
   * regress.
   */
  private recomputeAndPropagate(): void {
    const charEstimate = Math.ceil(this.runningOutputChars / 4);
    const outputTokens = Math.max(this.runningOutput, charEstimate);

    const usage: AnthropicUsage = {
      input_tokens: this.runningInput,
      output_tokens: outputTokens,
      cache_creation_input_tokens: this.runningCacheCreate,
      cache_read_input_tokens: this.runningCacheRead,
      server_tool_use: { web_search_requests: this.runningWebSearch },
    };
    const clientMicro = computeCostMicroUsd(this.opts.model, usage);
    if (clientMicro > this._lastCostMicroUsd) {
      this._lastCostMicroUsd = clientMicro;
      this.fireOnCostUpdate(Number(clientMicro) / 1_000_000);
      this.maybePostReconcile();
    }
  }

  /**
   * Invoke the caller's onCostUpdate without letting a callback throw kill
   * the stream. Symmetric with how chatService.ts wraps onComplete and
   * onContentBlocks: a React-side throw (e.g. setState on an unmounted
   * component, or a render-time exception inside the cost-pill component)
   * would otherwise propagate up through recordOutputChars / recordUsage /
   * recordServerCostMicroUsd into chatService's SSE-event try/catch, get
   * tagged as `isSSEProcessingError`, and tear down the whole stream.
   * Logged via console.error so on-call can spot the failure; not rethrown
   * because the cost state has already been advanced and the next delta
   * will fire the callback again with the higher figure.
   */
  private fireOnCostUpdate(usd: number): void {
    if (!this.opts.onCostUpdate) return;
    try {
      this.opts.onCostUpdate(usd);
    } catch (e) {
      console.error('[cost-tracker] onCostUpdate callback threw:', e);
    }
  }
}

function hasSendBeacon(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';
}
