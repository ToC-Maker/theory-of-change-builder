import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { resolveAnonActor } from '../_shared/anon-id';
import { toBigInt } from '../_shared/bigint';

/**
 * `GET /api/chart-byok-cost?chartId=X`
 *
 * Returns `{ cost_settled_micro_usd: "<string>" }` — the sum of
 * `logging_messages.cost_settled_micro_usd` for the caller's logging_messages
 * rows attached to `chartId`. This is the authoritative server-side total for
 * the chart's BYOK pill, used by the client to converge the local
 * (localStorage) per-chart counter on chart load and before each new stream
 * send. The need: post-stream `pollUntilReconciled` can miss the final IIFE
 * bump (Cloudflare time budget kills, or a different tab observed the bump
 * and the original tab never saw it); summing from DB on a known-safe moment
 * (chart load, new send) catches up the gap.
 *
 * Ownership: filtered by `user_id = $actorId`. Foreign / unknown chartIds
 * return `"0"` (same shape as no-rows) rather than 403/404 — keeps probe
 * surfaces consistent with the rest of the worker.
 *
 * Auth: JWT preferred. Anon falls back to cookie-pinned actor id (same path
 * as /api/usage). BYOK is auth-only, but we accept anon callers so the
 * endpoint can also serve free-tier charts later if we widen the pill;
 * currently anon callers get back "0" for any chart_id (their messages are
 * keyed off the anon actor_id and won't match charts owned by an auth sub).
 */
export async function handler(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const chartId = url.searchParams.get('chartId');
    if (!chartId) {
      return Response.json({ error: 'chartId required' }, { status: 400 });
    }

    let userId: string | null = null;
    const token = extractToken(request.headers.get('authorization'));
    if (token) {
      try {
        const decoded = await verifyToken(token, env);
        userId = decoded.sub;
      } catch (err) {
        if (err instanceof JWKSFetchError) {
          return Response.json({ error: 'Authentication service unavailable' }, { status: 502 });
        }
        return Response.json({ error: 'Invalid or expired token' }, { status: 401 });
      }
    }

    const sql = getDb(env);
    if (!userId) {
      try {
        const resolved = await resolveAnonActor(request, env);
        userId = resolved.userId;
      } catch (e) {
        console.error('Failed to resolve anonymous actor for chart-byok-cost:', e);
        userId = 'anon-unknown';
      }
    }

    // Sum cost_settled_micro_usd for this user's messages on this chart.
    // The `chartId` URL param can be EITHER the 12-char chart id OR the
    // 36-char edit_token, because the client's BYOK pill is keyed by
    // whichever the URL exposed (`/chart/<id>` vs `/edit/<token>`), and
    // those are the keys it uses to round-trip pill values. The DB stores
    // only the 12-char chart_id on logging_messages, so we resolve the
    // edit_token form via charts in the same statement (one round trip)
    // and treat both forms as equivalent. COALESCE handles the no-rows
    // case (foreign id/token, fresh chart with no messages yet) — returns
    // 0 instead of NULL.
    const rows = (await sql`
      SELECT COALESCE(SUM(cost_settled_micro_usd), 0) AS total
      FROM logging_messages
      WHERE user_id = ${userId}
        AND (
          chart_id = ${chartId}
          OR chart_id = (SELECT id FROM charts WHERE edit_token = ${chartId})
        )
    `) as { total: bigint | number | string | null }[];
    const total = rows.length > 0 ? toBigInt(rows[0].total) : 0n;

    return Response.json({ cost_settled_micro_usd: total.toString() });
  } catch (error) {
    console.error('Error fetching chart-byok-cost:', error);
    return Response.json({ error: 'Failed to fetch chart cost' }, { status: 500 });
  }
}
