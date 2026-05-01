import type { NeonQueryFunction } from '@neondatabase/serverless';

/**
 * Best-effort diagnostic insert into `logging_errors`.
 *
 * Centralises the ~25-line `INSERT ... ON CONFLICT DO NOTHING` boilerplate
 * that was duplicated across the post-stream reconcile IIFE in
 * `worker/api/anthropic-stream.ts` (12+ near-identical sites). The helper
 * lives in `_shared/` rather than alongside the caller so future diagnostic
 * sites in other Worker routes can opt in without reimporting from a
 * sibling file.
 *
 * Recovery-of-recovery semantics: every caller is already in an
 * error-handling path (catch block, kill-switch fallback, abandoned-stream
 * cleanup). Throwing here would replace the original error with a less
 * informative one, so we swallow on failure and `console.error` for
 * wrangler-tail visibility. Callers can still wrap in their own try/catch
 * if they want a different fallback, but they MUST NOT depend on the row
 * actually landing — the diagnostic insert is observability, not state.
 *
 * `error_id` defaults to a fresh UUID; pass an explicit value only when
 * the same logical event might fire multiple times in one Worker
 * invocation and you want `ON CONFLICT (error_id) DO NOTHING` to
 * deduplicate. `fired_at_ms` and `deployment_host` auto-stamp into
 * `request_metadata` if not already supplied — pre-existing keys are
 * preserved so legacy call sites that bake them into `request_metadata`
 * directly stay byte-identical to the previous payload shape.
 */
export interface DiagnosticInsertParams {
  /** Optional UUID; auto-generated when omitted. */
  error_id?: string;
  /** Required: PascalCase diagnostic name (e.g. `DiagnosticReconcileEntered`). */
  error_name: string;
  /** Required: human-readable summary; what wrangler tail shows first. */
  error_message: string;
  /**
   * The actor whose stream / reconcile this diagnostic is about. Use the
   * cookie-pinned anon UUID for anon callers, the Auth0 sub for authed.
   * Pass `null` only for system-level diagnostics with no actor context.
   */
  user_id: string | null;
  /** Chart context if available; null for chart-less diagnostics. */
  chart_id?: string | null;
  /** Upstream HTTP status, when the diagnostic captures one (poll fail etc.). */
  http_status?: number | null;
  /** Free-form metadata; merged with auto-stamped fired_at_ms/deployment_host. */
  request_metadata: Record<string, unknown>;
  /** When provided, auto-stamped into request_metadata.deployment_host. */
  deployment_host?: string;
  /** When provided, auto-stamped into request_metadata.fired_at_ms. */
  fired_at_ms?: number;
}

export async function writeDiagnostic(
  sql: NeonQueryFunction<false, false>,
  params: DiagnosticInsertParams,
): Promise<void> {
  const {
    error_id = crypto.randomUUID(),
    error_name,
    error_message,
    user_id,
    chart_id = null,
    http_status = null,
    request_metadata,
    deployment_host,
    fired_at_ms,
  } = params;

  // Auto-stamp deployment_host / fired_at_ms when supplied. Pre-existing
  // keys win — some legacy call sites bake them into request_metadata and
  // we preserve those bytes exactly so analytics queries don't drift.
  const merged: Record<string, unknown> = { ...request_metadata };
  if (deployment_host !== undefined && merged.deployment_host === undefined) {
    merged.deployment_host = deployment_host;
  }
  if (fired_at_ms !== undefined && merged.fired_at_ms === undefined) {
    merged.fired_at_ms = fired_at_ms;
  }

  try {
    await sql`
      INSERT INTO logging_errors (
        error_id, error_name, error_message, user_id, chart_id,
        http_status, request_metadata
      )
      VALUES (
        ${error_id},
        ${error_name},
        ${error_message},
        ${user_id},
        ${chart_id},
        ${http_status},
        ${JSON.stringify(merged)}
      )
      ON CONFLICT (error_id) DO NOTHING
    `;
  } catch (e) {
    // Recovery-of-recovery: callers are already in an error path. Surface
    // to wrangler tail so a silent diagnostic-write outage doesn't hide
    // the underlying failure mode, then return — never re-throw.
    console.error(`writeDiagnostic(${error_name}) insert failed:`, e);
  }
}
