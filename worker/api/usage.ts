import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, JWKSFetchError } from '../_shared/auth';
import { LIFETIME_CAP_USD, tierFor } from '../_shared/tiers';
import {
  resolveAnonActor,
  mergeAnonUsageIntoAuth,
  signAuthLinkCookie,
  buildAuthLinkCookieHeader,
} from '../_shared/anon-id';
import { microToUsd } from '../../shared/pricing';

export async function handler(request: Request, env: Env): Promise<Response> {
  try {
    // Resolve actor id: verified JWT sub for authenticated users, anon-<ip-hash> otherwise.
    let userId: string | null = null;
    let jwtVerified = false;
    const authHeader = request.headers.get('authorization');
    const token = extractToken(authHeader);
    if (token) {
      try {
        const decoded = await verifyToken(token, env);
        userId = decoded.sub;
        jwtVerified = true;
      } catch (err) {
        if (err instanceof JWKSFetchError) {
          return Response.json({ error: 'Authentication service unavailable' }, { status: 502 });
        }
        return Response.json({ error: 'Invalid or expired token' }, { status: 401 });
      }
    }

    const sql = getDb(env);

    // Immediately after sign-in the client refreshes usage; running the
    // anon→auth merge here means the first /api/usage response already
    // reflects any pre-sign-in anon spend folded into the auth row, rather
    // than showing $0 and then jumping on the next anthropic-stream call.
    // Also mint/refresh the tocb_auth_link cookie so a subsequent logout
    // doesn't reset the cap (see helper comment in anon-id.ts).
    let authLinkSetCookie: string | undefined;
    if (userId) {
      await mergeAnonUsageIntoAuth(sql, userId, request);
      authLinkSetCookie = buildAuthLinkCookieHeader(
        await signAuthLinkCookie(userId, env.IP_HASH_SALT),
      );
    }

    // Cookie-first anon identity. setCookieHeader is set when the resolver
    // minted a fresh UUID (no prior cookie); surface it on the response.
    let anonSetCookie: string | undefined;
    if (!userId) {
      try {
        const resolved = await resolveAnonActor(request, env);
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
      // BYOK lookup requires a verified JWT, NOT just a non-anon user_id.
      // resolveAnonActor returns the auth sub via tocb_auth_link (Policy B
      // cap preservation across sign-out), so a logged-out user can land
      // here with userId=`auth0|...` despite having no JWT. Without
      // jwtVerified guarding the query, the server reports tier='byok' to
      // an unauthenticated caller — misleading (the user can't actually
      // use BYOK without a JWT, since /api/anthropic-stream requires it
      // for decryption).
      //
      // key_last4 round-trips so the client can rebuild byok-spend-key-<last4>
      // bucket lookups after a page reload (submitKey only fires on first
      // submission; without this, keyLast4 stays null and per-key spend
      // tracking silently breaks).
      jwtVerified
        ? sql`SELECT user_id, key_last4 FROM user_byok_keys WHERE user_id = ${userId}`
        : Promise.resolve([] as { user_id: string; key_last4: string | null }[]),
    ]);

    const hasByok = byokRows.length > 0;
    const byokLast4 = hasByok ? ((byokRows[0].key_last4 as string | null) ?? null) : null;
    const userMicro = userRows.length > 0 ? (userRows[0].cost_micro_usd as bigint | number) : 0;

    // Global monthly spend is observability-only (tracked in `global_monthly_usage`,
    // written via anthropic-stream's reconcile). It's NOT exposed here — users
    // can't act on it, and the Anthropic Console cap is the authoritative hard
    // stop. Clients learn about exhaustion via the 402 `global_budget_exhausted`
    // response when a stream fails upstream.
    const headers = new Headers({ 'content-type': 'application/json' });
    if (anonSetCookie) headers.append('Set-Cookie', anonSetCookie);
    if (authLinkSetCookie) headers.append('Set-Cookie', authLinkSetCookie);
    return new Response(
      JSON.stringify({
        used_usd: microToUsd(userMicro),
        limit_usd: LIFETIME_CAP_USD,
        tier: tierFor(userId, hasByok),
        byok_last4: byokLast4,
      }),
      { status: 200, headers },
    );
  } catch (error) {
    console.error('Error fetching usage:', error);
    return Response.json({ error: 'Failed to fetch usage' }, { status: 500 });
  }
}
