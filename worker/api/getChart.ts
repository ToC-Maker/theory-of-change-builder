import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken, tryMigrateDecoded, JWKSFetchError } from '../_shared/auth';

export async function handler(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const chartId = url.searchParams.get('chartId');
    const editToken = url.searchParams.get('editToken');

    if (!chartId && !editToken) {
      return Response.json({ error: 'Chart ID or edit token is required' }, { status: 400 });
    }

    const sql = getDb(env);

    // Track the authenticated caller's sub (if any) and the chart owner's
    // sub so we can surface isOwner in the response. The client uses this to
    // skip owner-only follow-up fetches (managePermissions), which otherwise
    // spam 403s on every render for charts the caller doesn't own.
    let verifiedUserId: string | null = null;
    let ownerIdForResponse: string | null = null;
    let result;
    if (editToken) {
      result = await sql`
        SELECT id, chart_data, user_id, link_sharing_level FROM charts
        WHERE edit_token = ${editToken}
      `;

      if (!result || result.length === 0) {
        return Response.json({ error: 'Chart not found' }, { status: 404 });
      }

      const chartOwnerId = result[0].user_id;
      ownerIdForResponse = chartOwnerId;
      const linkSharingLevel = result[0].link_sharing_level || 'restricted';
      const allowAnonymousEdit = linkSharingLevel === 'editor';

      if (chartOwnerId && !allowAnonymousEdit) {
        const token = extractToken(request.headers.get('authorization'));

        if (!token) {
          return Response.json(
            { error: 'Authentication required. Please log in to access this chart.' },
            { status: 401 },
          );
        }

        let decodedToken;
        try {
          decodedToken = await verifyToken(token, env);
        } catch (err) {
          if (err instanceof JWKSFetchError) {
            return Response.json(
              { error: 'Authentication service unavailable. Please try again later.' },
              { status: 502 },
            );
          }
          return Response.json(
            { error: 'Invalid or expired authentication. Please log in again.' },
            { status: 401 },
          );
        }

        const userId = decodedToken.sub;
        verifiedUserId = userId;
        const userEmail = decodedToken.email || decodedToken.name;

        await tryMigrateDecoded(sql, decodedToken, 'getChart');

        // Re-read chart owner after migration (may have changed from old sub to new sub)
        const refreshed = await sql`SELECT user_id FROM charts WHERE id = ${result[0].id}`;
        const currentOwnerId = refreshed[0]?.user_id ?? chartOwnerId;
        ownerIdForResponse = currentOwnerId;

        const existingPermission = await sql`
          SELECT user_id, status FROM chart_permissions
          WHERE chart_id = ${result[0].id} AND user_id = ${userId}
        `;

        if (existingPermission.length === 0) {
          const permissionLevel = userId === currentOwnerId ? 'owner' : 'edit';

          if (userId === currentOwnerId) {
            await sql`
              INSERT INTO chart_permissions (chart_id, user_id, user_email, permission_level, granted_by, status)
              VALUES (${result[0].id}, ${userId}, ${userEmail}, ${permissionLevel}, ${userId}, 'approved')
            `;
          } else {
            await sql`
              INSERT INTO chart_permissions (chart_id, user_id, user_email, permission_level, granted_by, status)
              VALUES (${result[0].id}, ${userId}, ${userEmail}, ${permissionLevel}, ${currentOwnerId}, 'pending')
            `;
            return Response.json(
              {
                error: 'Access request pending. The chart owner needs to approve your request.',
                pending: true,
              },
              { status: 403 },
            );
          }
        } else {
          const permStatus = existingPermission[0].status;
          if (permStatus === 'pending') {
            return Response.json(
              {
                error: 'Access request pending. The chart owner needs to approve your request.',
                pending: true,
              },
              { status: 403 },
            );
          } else if (permStatus === 'rejected') {
            return Response.json(
              { error: 'Access request was denied by the chart owner.', rejected: true },
              { status: 403 },
            );
          }
        }
      } else if (chartOwnerId && allowAnonymousEdit) {
        const token = extractToken(request.headers.get('authorization'));

        if (token) {
          try {
            const decodedToken = await verifyToken(token, env);
            const userId = decodedToken.sub;
            verifiedUserId = userId;
            const userEmail = decodedToken.email || decodedToken.name;

            await tryMigrateDecoded(sql, decodedToken, 'getChart');

            // Re-read owner post-migration so the isOwner signal we return is
            // based on the owner's current sub, not the pre-migration one.
            const refreshed = await sql`SELECT user_id FROM charts WHERE id = ${result[0].id}`;
            ownerIdForResponse = refreshed[0]?.user_id ?? chartOwnerId;

            const existingPermission = await sql`
              SELECT user_id FROM chart_permissions
              WHERE chart_id = ${result[0].id} AND user_id = ${userId}
            `;

            if (existingPermission.length === 0) {
              const permissionLevel = userId === chartOwnerId ? 'owner' : 'edit';
              await sql`
                INSERT INTO chart_permissions (chart_id, user_id, user_email, permission_level, granted_by, status)
                VALUES (${result[0].id}, ${userId}, ${userEmail}, ${permissionLevel}, ${chartOwnerId || userId}, 'approved')
              `;
            }
          } catch {
            console.log(
              'Token verification failed, allowing anonymous access due to link sharing level',
            );
          }
        }
      }
    } else if (chartId) {
      result = await sql`
        SELECT id, chart_data, user_id, link_sharing_level FROM charts
        WHERE id = ${chartId}
      `;
      if (!result || result.length === 0) {
        return Response.json({ error: 'Chart not found' }, { status: 404 });
      }

      const chartOwnerId = result[0].user_id;
      ownerIdForResponse = chartOwnerId;
      const linkSharingLevel = result[0].link_sharing_level || 'restricted';

      // Owned + restricted: enforce the same approval gate used by the
      // editToken branch. View-by-chartId previously ignored
      // link_sharing_level, so anyone with the 6-byte chartId could read a
      // chart the owner had explicitly locked down.
      if (chartOwnerId && linkSharingLevel === 'restricted') {
        const token = extractToken(request.headers.get('authorization'));
        if (!token) {
          return Response.json(
            { error: 'Authentication required. This chart is restricted.' },
            { status: 403 },
          );
        }

        let decodedToken;
        try {
          decodedToken = await verifyToken(token, env);
        } catch (err) {
          if (err instanceof JWKSFetchError) {
            return Response.json(
              { error: 'Authentication service unavailable. Please try again later.' },
              { status: 502 },
            );
          }
          return Response.json(
            { error: 'Invalid or expired authentication. Please log in again.' },
            { status: 401 },
          );
        }

        const userId = decodedToken.sub;
        verifiedUserId = userId;
        await tryMigrateDecoded(sql, decodedToken, 'getChart');

        // Re-read owner post-migration so a sub swap doesn't cause a spurious 403.
        const refreshed = await sql`SELECT user_id FROM charts WHERE id = ${chartId}`;
        const currentOwnerId = refreshed[0]?.user_id ?? chartOwnerId;
        ownerIdForResponse = currentOwnerId;

        if (userId !== currentOwnerId) {
          const perm = await sql`
            SELECT status FROM chart_permissions
            WHERE chart_id = ${chartId} AND user_id = ${userId}
          `;
          if (!perm.length || perm[0].status !== 'approved') {
            return Response.json(
              { error: 'You do not have access to this chart.' },
              { status: 403 },
            );
          }
        }
      }

      // Increment view_count only after successful authorization, so a 403
      // response doesn't pollute analytics.
      await sql`
        UPDATE charts SET view_count = view_count + 1
        WHERE id = ${chartId}
      `;
    }

    if (!result || result.length === 0) {
      return Response.json({ error: 'Chart not found' }, { status: 404 });
    }

    // isOwner: true iff we verified the caller's JWT and their sub matches the
    // (post-migration) chart owner's sub. Anonymous callers and cross-user
    // callers get false. Anon charts (ownerIdForResponse === null) have no
    // owner at all — everyone is a non-owner.
    const isOwner = Boolean(
      verifiedUserId && ownerIdForResponse && verifiedUserId === ownerIdForResponse,
    );

    return Response.json({
      chartData: result[0].chart_data,
      chartId: result[0].id,
      canEdit: !!editToken,
      isOwner,
    });
  } catch (error) {
    console.error('Error fetching chart:', error);
    return Response.json({ error: 'Failed to fetch chart' }, { status: 500 });
  }
}
