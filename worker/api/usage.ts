import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { LIFETIME_CAP_USD, tierFor } from '../_shared/tiers';
import { resolveAnonActor } from '../_shared/anon-id';

function microToUsd(micro: bigint | number | null | undefined): number {
  if (micro === null || micro === undefined) return 0;
  const asBig = typeof micro === 'bigint' ? micro : BigInt(Math.trunc(Number(micro)));
  // Preserve up to 6 decimals of precision while staying within Number range.
  // Divide in two steps to keep the integer part accurate for large values.
  const whole = asBig / 1_000_000n;
  const frac = Number(asBig % 1_000_000n) / 1_000_000;
  return Number(whole) + frac;
}

export async function handler(request: Request, env: Env): Promise<Response> {
  try {
    // Resolve actor id: verified JWT sub for authenticated users, anon-<ip-hash> otherwise.
    let userId: string | null = null;
    const authHeader = request.headers.get('authorization');
    const token = extractToken(authHeader);
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

    // Cookie-first anon identity. setCookieHeader is set when the resolver
    // minted or rewrote the cookie (first visit or IP-change migration);
    // surface it on the response.
    let anonSetCookie: string | undefined;
    if (!userId) {
      try {
        const resolved = await resolveAnonActor(request, env, sql);
        userId = resolved.userId;
        anonSetCookie = resolved.setCookieHeader;
      } catch (e) {
        console.error('Failed to resolve anonymous actor for usage lookup:', e);
        userId = 'anon-unknown';
      }
    }

    const [userRows, byokRows] = await Promise.all([
      sql`
        SELECT cost_micro_usd
        FROM user_api_usage
        WHERE user_id = ${userId}
      `,
      // Only meaningful for authenticated users; anon can never have a BYOK row.
      userId.startsWith('anon-')
        ? Promise.resolve([] as { user_id: string }[])
        : sql`SELECT user_id FROM user_byok_keys WHERE user_id = ${userId}`,
    ]);

    const hasByok = byokRows.length > 0;
    const userMicro = userRows.length > 0 ? (userRows[0].cost_micro_usd as bigint | number) : 0;

    // Global monthly spend is observability-only (tracked in `global_monthly_usage`,
    // written via anthropic-stream's reconcile). It's NOT exposed here — users
    // can't act on it, and the Anthropic Console cap is the authoritative hard
    // stop. Clients learn about exhaustion via the 402 `global_budget_exhausted`
    // response when a stream fails upstream.
    const headers = new Headers({ 'content-type': 'application/json' });
    if (anonSetCookie) headers.append('Set-Cookie', anonSetCookie);
    return new Response(
      JSON.stringify({
        used_usd: microToUsd(userMicro),
        limit_usd: LIFETIME_CAP_USD,
        tier: tierFor(userId, hasByok),
      }),
      { status: 200, headers },
    );
  } catch (error) {
    console.error('Error fetching usage:', error);
    return Response.json({ error: 'Failed to fetch usage' }, { status: 500 });
  }
}
