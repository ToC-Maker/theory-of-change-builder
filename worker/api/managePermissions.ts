import type { Env } from '../_shared/types';
import { getDb } from '../_shared/db';
import { verifyToken, extractToken } from '../_shared/auth';

// Multi-method handler: GET, PATCH, PUT, DELETE
export async function handler(request: Request, env: Env): Promise<Response> {
  const method = request.method;

  if (!['GET', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const sql = getDb(env);
    // Verify authentication for all requests
    const token = extractToken(request.headers.get('authorization'));
    if (!token) {
      return Response.json({ error: 'Authentication required' }, { status: 401 });
    }

    let decodedToken;
    try {
      decodedToken = await verifyToken(token, env);
    } catch (err) {
      return Response.json({ error: 'Invalid or expired token' }, { status: 401 });
    }

    const authenticatedUserId = decodedToken.sub;

    // GET - List permissions for a chart
    if (method === 'GET') {
      const url = new URL(request.url);
      const chartId = url.searchParams.get('chartId');

      if (!chartId) {
        return Response.json({ error: 'Chart ID is required' }, { status: 400 });
      }

      const ownerCheck = await sql`
        SELECT permission_level FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${authenticatedUserId}
      `;

      if (!ownerCheck.length || ownerCheck[0].permission_level !== 'owner') {
        return Response.json({ error: 'Only the owner can view permissions' }, { status: 403 });
      }

      const permissions = await sql`
        SELECT user_id, user_email, permission_level, status, granted_at, granted_by
        FROM chart_permissions
        WHERE chart_id = ${chartId}
        ORDER BY
          CASE
            WHEN status = 'pending' THEN 1
            WHEN status = 'approved' THEN 2
            WHEN status = 'rejected' THEN 3
          END,
          granted_at ASC
      `;

      const chartInfo = await sql`
        SELECT link_sharing_level FROM charts WHERE id = ${chartId}
      `;
      const linkSharingLevel = chartInfo.length > 0 ? chartInfo[0].link_sharing_level : 'restricted';

      return Response.json({ permissions, linkSharingLevel });
    }

    // PATCH - Update a user's permission level or approve/reject access
    if (method === 'PATCH') {
      let patchBody: { chartId?: string; targetUserId?: string; permissionLevel?: string; action?: string };
      try { patchBody = await request.json() as typeof patchBody; }
      catch { return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 }); }
      const { chartId, targetUserId, permissionLevel, action } = patchBody;

      if (!chartId || !targetUserId) {
        return Response.json({ error: 'Chart ID and target user ID are required' }, { status: 400 });
      }

      const ownerCheck = await sql`
        SELECT permission_level FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${authenticatedUserId}
      `;

      if (!ownerCheck.length || ownerCheck[0].permission_level !== 'owner') {
        return Response.json({ error: 'Only the owner can manage permissions' }, { status: 403 });
      }

      if (action === 'approve' || action === 'reject') {
        const newStatus = action === 'approve' ? 'approved' : 'rejected';
        const result = await sql`
          UPDATE chart_permissions
          SET status = ${newStatus}
          WHERE chart_id = ${chartId} AND user_id = ${targetUserId}
          RETURNING user_id
        `;

        if (!result.length) {
          return Response.json({ error: 'Permission request not found' }, { status: 404 });
        }

        return Response.json({
          success: true,
          message: action === 'approve' ? 'Access approved successfully' : 'Access rejected successfully'
        });
      }

      if (permissionLevel) {
        if (!['owner', 'edit'].includes(permissionLevel)) {
          return Response.json({ error: 'Permission level must be "owner" or "edit"' }, { status: 400 });
        }

        if (targetUserId === authenticatedUserId) {
          return Response.json({ error: 'Cannot change your own permission level' }, { status: 400 });
        }

        const result = await sql`
          UPDATE chart_permissions
          SET permission_level = ${permissionLevel}
          WHERE chart_id = ${chartId} AND user_id = ${targetUserId}
          RETURNING user_id
        `;

        if (!result.length) {
          return Response.json({ error: 'Permission not found' }, { status: 404 });
        }

        return Response.json({ success: true, message: 'Permission updated successfully' });
      }

      return Response.json({ error: 'Either permissionLevel or action must be provided' }, { status: 400 });
    }

    // PUT - Update link sharing settings
    if (method === 'PUT') {
      let putBody: { chartId?: string; linkSharingLevel?: string };
      try { putBody = await request.json() as typeof putBody; }
      catch { return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 }); }
      const { chartId, linkSharingLevel } = putBody;

      if (!chartId || !linkSharingLevel) {
        return Response.json({ error: 'Chart ID and link sharing level are required' }, { status: 400 });
      }

      if (!['restricted', 'viewer', 'editor'].includes(linkSharingLevel)) {
        return Response.json({ error: 'Link sharing level must be "restricted", "viewer", or "editor"' }, { status: 400 });
      }

      const ownerCheck = await sql`
        SELECT permission_level FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${authenticatedUserId}
      `;

      if (!ownerCheck.length || ownerCheck[0].permission_level !== 'owner') {
        return Response.json({ error: 'Only the owner can change link sharing settings' }, { status: 403 });
      }

      const result = await sql`
        UPDATE charts SET link_sharing_level = ${linkSharingLevel}
        WHERE id = ${chartId}
        RETURNING id
      `;

      if (!result.length) {
        return Response.json({ error: 'Chart not found' }, { status: 404 });
      }

      return Response.json({ success: true, message: 'Link sharing settings updated successfully' });
    }

    // DELETE - Remove a permission
    if (method === 'DELETE') {
      let deleteBody: { chartId?: string; targetUserId?: string };
      try { deleteBody = await request.json() as typeof deleteBody; }
      catch { return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 }); }
      const { chartId, targetUserId } = deleteBody;

      if (!chartId || !targetUserId) {
        return Response.json({ error: 'Chart ID and target user ID are required' }, { status: 400 });
      }

      const ownerCheck = await sql`
        SELECT permission_level FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${authenticatedUserId}
      `;

      if (!ownerCheck.length || ownerCheck[0].permission_level !== 'owner') {
        return Response.json({ error: 'Only the owner can remove permissions' }, { status: 403 });
      }

      const targetPermission = await sql`
        SELECT permission_level FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${targetUserId}
      `;

      if (targetPermission.length && targetPermission[0].permission_level === 'owner') {
        return Response.json({ error: 'Cannot remove owner permission' }, { status: 400 });
      }

      const result = await sql`
        DELETE FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${targetUserId}
        RETURNING user_id
      `;

      if (!result.length) {
        return Response.json({ error: 'Permission not found' }, { status: 404 });
      }

      return Response.json({ success: true, message: 'Permission removed successfully' });
    }

    // Unreachable: method guard at top rejects non-GET/PATCH/PUT/DELETE
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (error) {
    console.error('Error managing permissions:', error);
    return Response.json({ error: 'Failed to manage permissions' }, { status: 500 });
  }
};
