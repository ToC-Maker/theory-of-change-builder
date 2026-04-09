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
      const linkSharingLevel = result[0].link_sharing_level || 'restricted';
      const allowAnonymousEdit = linkSharingLevel === 'editor';

      if (chartOwnerId && !allowAnonymousEdit) {
        const token = extractToken(request.headers.get('authorization'));

        if (!token) {
          return Response.json(
            { error: 'Authentication required. Please log in to access this chart.' },
            { status: 401 }
          );
        }

        let decodedToken;
        try {
          decodedToken = await verifyToken(token, env);
        } catch (err) {
          if (err instanceof JWKSFetchError) {
            return Response.json(
              { error: 'Authentication service unavailable. Please try again later.' },
              { status: 502 }
            );
          }
          return Response.json(
            { error: 'Invalid or expired authentication. Please log in again.' },
            { status: 401 }
          );
        }

        const userId = decodedToken.sub;
        const userEmail = decodedToken.email || decodedToken.name;

        await tryMigrateDecoded(sql, decodedToken, 'getChart');

        // Re-read chart owner after migration (may have changed from old sub to new sub)
        const refreshed = await sql`SELECT user_id FROM charts WHERE id = ${result[0].id}`;
        const currentOwnerId = refreshed[0]?.user_id ?? chartOwnerId;

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
              { error: 'Access request pending. The chart owner needs to approve your request.', pending: true },
              { status: 403 }
            );
          }
        } else {
          const permStatus = existingPermission[0].status;
          if (permStatus === 'pending') {
            return Response.json(
              { error: 'Access request pending. The chart owner needs to approve your request.', pending: true },
              { status: 403 }
            );
          } else if (permStatus === 'rejected') {
            return Response.json(
              { error: 'Access request was denied by the chart owner.', rejected: true },
              { status: 403 }
            );
          }
        }
      } else if (chartOwnerId && allowAnonymousEdit) {
        const token = extractToken(request.headers.get('authorization'));

        if (token) {
          try {
            const decodedToken = await verifyToken(token, env);
            const userId = decodedToken.sub;
            const userEmail = decodedToken.email || decodedToken.name;

            await tryMigrateDecoded(sql, decodedToken, 'getChart');

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
          } catch (err) {
            console.log('Token verification failed, allowing anonymous access due to link sharing level');
          }
        }
      }
    } else if (chartId) {
      result = await sql`
        SELECT id, chart_data FROM charts
        WHERE id = ${chartId}
      `;
      // Increment view count
      await sql`
        UPDATE charts SET view_count = view_count + 1
        WHERE id = ${chartId}
      `;
    }

    if (!result || result.length === 0) {
      return Response.json({ error: 'Chart not found' }, { status: 404 });
    }

    return Response.json({
      chartData: result[0].chart_data,
      chartId: result[0].id,
      canEdit: !!editToken
    });
  } catch (error) {
    console.error('Error fetching chart:', error);
    return Response.json({ error: 'Failed to fetch chart' }, { status: 500 });
  }
};
