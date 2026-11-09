import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from './types';
import { extractToken, verifyToken, JWKSFetchError } from './auth';

export interface EditableChart {
  id: string;
  user_id: string | null;
  link_sharing_level: string | null;
}

export type ChartEditAccess =
  | { ok: true; chart: EditableChart }
  | { ok: false; response: Response };

/**
 * Decides whether this request may edit (and so also poll) the chart behind
 * `editToken`. Shared by updateChart and pollChart so the two can never
 * disagree about who is allowed in. Reads only: a refusal carries no version
 * or chart data and nothing is written.
 *
 * The edit token alone suffices for anonymous charts (user_id IS NULL) and for
 * owned charts shared as 'editor'. Any other owned chart also needs a verified
 * JWT that is the owner's or has an `approved` chart_permissions row, so a
 * rejected collaborator or an ex-member cannot keep editing with a remembered
 * edit URL.
 */
export async function authorizeChartEdit(
  request: Request,
  env: Env,
  sql: NeonQueryFunction<false, false>,
  editToken: string,
): Promise<ChartEditAccess> {
  const rows = (await sql`
    SELECT id, user_id, link_sharing_level FROM charts WHERE edit_token = ${editToken}
  `) as EditableChart[];

  if (rows.length === 0) {
    return refuse('Chart not found or invalid edit token', 404);
  }

  const chart = rows[0];
  const linkSharingLevel = chart.link_sharing_level || 'restricted';

  if (chart.user_id && linkSharingLevel !== 'editor') {
    const authToken = extractToken(request.headers.get('authorization'));
    if (!authToken) {
      return refuse('Authentication required to edit this chart.', 403);
    }
    let decoded;
    try {
      decoded = await verifyToken(authToken, env);
    } catch (err) {
      if (err instanceof JWKSFetchError) {
        console.error('[authorizeChartEdit] JWKS fetch failed:', err.cause);
        return refuse('Authentication service unavailable. Please try again later.', 502);
      }
      return refuse('Invalid or expired authentication. Please log in again.', 403);
    }

    if (decoded.sub !== chart.user_id) {
      const perm = (await sql`
        SELECT status FROM chart_permissions
        WHERE chart_id = ${chart.id} AND user_id = ${decoded.sub}
      `) as { status: string }[];
      if (!perm.length || perm[0].status !== 'approved') {
        return refuse('You do not have permission to edit this chart.', 403);
      }
    }
  }

  return { ok: true, chart };
}

function refuse(error: string, status: number): { ok: false; response: Response } {
  return { ok: false, response: Response.json({ error }, { status }) };
}
