import { useSyncExternalStore } from 'react';

/**
 * BYOK spend tracking in localStorage.
 *
 * Two scopes are tracked, both as µUSD integers (stored as strings to survive
 * JSON / localStorage round-trip without precision loss):
 *
 *   - Per chart: `byok-spend-chart-<chartId>` — sum of cost for BYOK stream
 *     completions that happened while that chart was open. Shown inline next
 *     to the BYOK pill so users see "this document is costing me X."
 *   - Per key (lifetime): `byok-spend-key-<last4>` — cumulative across all
 *     charts for the currently-stored key. Shown in the API-key modal as the
 *     "overall" figure; reset when the user removes or swaps the key.
 *
 * The server doesn't track BYOK spend (by design — BYOK users are billed
 * directly by Anthropic), so these counters are best-effort client-side
 * aggregates. They do NOT replace the Anthropic dashboard as the source of
 * truth for billing; they're a real-time UX signal.
 */

const CHART_PREFIX = 'byok-spend-chart-';
const KEY_PREFIX = 'byok-spend-key-';

const USD_PER_MICRO = 1 / 1_000_000;

function safeReadMicroUsd(storageKey: string): number {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function safeWriteMicroUsd(storageKey: string, microUsd: number): void {
  try {
    localStorage.setItem(storageKey, String(Math.round(microUsd)));
  } catch {
    // Storage full / disabled — silently skip. Losing the counter is better
    // than crashing the stream-complete path.
  }
}

export function getChartSpendUsd(chartId: string | null): number {
  if (!chartId) return 0;
  return safeReadMicroUsd(CHART_PREFIX + chartId) * USD_PER_MICRO;
}

export function getKeySpendUsd(keyLast4: string | null): number {
  if (!keyLast4) return 0;
  return safeReadMicroUsd(KEY_PREFIX + keyLast4) * USD_PER_MICRO;
}

/**
 * Add a completed-stream cost to the per-chart and per-key counters.
 * Caller should only invoke this when the completed stream was actually
 * BYOK (server-side billing); free-tier usage is tracked server-side via
 * `user_api_usage` and MUST NOT be double-counted here.
 */
export function addByokSpend(
  chartId: string | null,
  keyLast4: string | null,
  costUsd: number,
): void {
  if (!(costUsd > 0)) return;
  const micro = Math.round(costUsd * 1_000_000);
  if (chartId) {
    const key = CHART_PREFIX + chartId;
    safeWriteMicroUsd(key, safeReadMicroUsd(key) + micro);
  }
  if (keyLast4) {
    const key = KEY_PREFIX + keyLast4;
    safeWriteMicroUsd(key, safeReadMicroUsd(key) + micro);
  }
  emitSpendChanged();
}

export function clearChartSpend(chartId: string): void {
  try { localStorage.removeItem(CHART_PREFIX + chartId); } catch { /* ignore */ }
  emitSpendChanged();
}

export function clearKeySpend(keyLast4: string): void {
  try { localStorage.removeItem(KEY_PREFIX + keyLast4); } catch { /* ignore */ }
  emitSpendChanged();
}

/**
 * Custom event fired after any spend mutation so same-tab consumers can
 * re-render without polling. The `storage` event only fires in OTHER tabs,
 * which is why we also listen for this one for same-tab updates.
 */
export const BYOK_SPEND_EVENT = 'byok-spend-changed';

function emitSpendChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(BYOK_SPEND_EVENT));
  } catch {
    /* non-browser env or event construction disabled; no-op */
  }
}

/**
 * useSyncExternalStore subscription for same-tab mutations (BYOK_SPEND_EVENT)
 * and cross-tab propagation (native storage event). Shared by the per-chart
 * and per-key hooks below.
 */
function subscribeSpendChanges(cb: () => void): () => void {
  window.addEventListener(BYOK_SPEND_EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(BYOK_SPEND_EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}

export function useChartByokSpendUsd(chartId: string | null): number {
  return useSyncExternalStore(
    subscribeSpendChanges,
    () => getChartSpendUsd(chartId),
    () => 0,
  );
}

export function useKeyByokSpendUsd(keyLast4: string | null): number {
  return useSyncExternalStore(
    subscribeSpendChanges,
    () => getKeySpendUsd(keyLast4),
    () => 0,
  );
}
