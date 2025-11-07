import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken } from './utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'DELETE, GET, PATCH, PUT, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL not configured');
  }

  const sql = neon(DATABASE_URL);

  try {
    // Verify authentication for all requests
    const token = extractToken(event.headers.authorization);
    if (!token) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Authentication required' })
      };
    }

    let decodedToken;
    try {
      decodedToken = await verifyToken(token);
    } catch (err) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid or expired token' })
      };
    }

    const authenticatedUserId = decodedToken.sub; // Auth0 user ID from token
    const authenticatedUserEmail = decodedToken.email || decodedToken.name;

    // GET - List permissions for a chart
    if (event.httpMethod === 'GET') {
      const chartId = event.queryStringParameters?.chartId;

      if (!chartId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Chart ID is required' })
        };
      }

      // Check if requesting user is the owner
      const ownerCheck = await sql`
        SELECT permission_level FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${authenticatedUserId}
      `;

      if (!ownerCheck.length || ownerCheck[0].permission_level !== 'owner') {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Only the owner can view permissions' })
        };
      }

      // Get all permissions for this chart with emails and status
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

      // Get link sharing settings
      const chartInfo = await sql`
        SELECT link_sharing_level FROM charts WHERE id = ${chartId}
      `;

      const linkSharingLevel = chartInfo.length > 0 ? chartInfo[0].link_sharing_level : 'restricted';

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ permissions, linkSharingLevel })
      };
    }


    // PATCH - Update a user's permission level or approve/reject access
    if (event.httpMethod === 'PATCH') {
      const { chartId, targetUserId, permissionLevel, action } = JSON.parse(event.body || '{}');

      if (!chartId || !targetUserId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Chart ID and target user ID are required' })
        };
      }

      // Check if requesting user is the owner
      const ownerCheck = await sql`
        SELECT permission_level FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${authenticatedUserId}
      `;

      if (!ownerCheck.length || ownerCheck[0].permission_level !== 'owner') {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Only the owner can manage permissions' })
        };
      }

      // Handle approve/reject actions
      if (action === 'approve' || action === 'reject') {
        const newStatus = action === 'approve' ? 'approved' : 'rejected';

        const result = await sql`
          UPDATE chart_permissions
          SET status = ${newStatus}
          WHERE chart_id = ${chartId} AND user_id = ${targetUserId}
          RETURNING user_id
        `;

        if (!result.length) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Permission request not found' })
          };
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            message: action === 'approve' ? 'Access approved successfully' : 'Access rejected successfully'
          })
        };
      }

      // Handle permission level change
      if (permissionLevel) {
        // Validate permission level
        if (!['owner', 'edit'].includes(permissionLevel)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Permission level must be "owner" or "edit"' })
          };
        }

        // Don't allow changing your own permission
        if (targetUserId === authenticatedUserId) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Cannot change your own permission level' })
          };
        }

        // Update the permission level
        const result = await sql`
          UPDATE chart_permissions
          SET permission_level = ${permissionLevel}
          WHERE chart_id = ${chartId} AND user_id = ${targetUserId}
          RETURNING user_id
        `;

        if (!result.length) {
          return {
            statusCode: 404,
            headers,
            body: JSON.stringify({ error: 'Permission not found' })
          };
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, message: 'Permission updated successfully' })
        };
      }

      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Either permissionLevel or action must be provided' })
      };
    }

    // PUT - Update link sharing settings
    if (event.httpMethod === 'PUT') {
      const { chartId, linkSharingLevel } = JSON.parse(event.body || '{}');

      if (!chartId || !linkSharingLevel) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Chart ID and link sharing level are required' })
        };
      }

      // Validate link sharing level
      if (!['restricted', 'viewer', 'editor'].includes(linkSharingLevel)) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Link sharing level must be "restricted", "viewer", or "editor"' })
        };
      }

      // Check if requesting user is the owner
      const ownerCheck = await sql`
        SELECT permission_level FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${authenticatedUserId}
      `;

      if (!ownerCheck.length || ownerCheck[0].permission_level !== 'owner') {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Only the owner can change link sharing settings' })
        };
      }

      // Update the link sharing level
      const result = await sql`
        UPDATE charts
        SET link_sharing_level = ${linkSharingLevel}
        WHERE id = ${chartId}
        RETURNING id
      `;

      if (!result.length) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Chart not found' })
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'Link sharing settings updated successfully' })
      };
    }

    // DELETE - Remove a permission
    if (event.httpMethod === 'DELETE') {
      const { chartId, targetUserId } = JSON.parse(event.body || '{}');

      if (!chartId || !targetUserId) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Chart ID and target user ID are required' })
        };
      }

      // Check if requesting user is the owner
      const ownerCheck = await sql`
        SELECT permission_level FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${authenticatedUserId}
      `;

      if (!ownerCheck.length || ownerCheck[0].permission_level !== 'owner') {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ error: 'Only the owner can remove permissions' })
        };
      }

      // Prevent removing owner permission
      const targetPermission = await sql`
        SELECT permission_level FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${targetUserId}
      `;

      if (targetPermission.length && targetPermission[0].permission_level === 'owner') {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Cannot remove owner permission' })
        };
      }

      // Remove the permission
      const result = await sql`
        DELETE FROM chart_permissions
        WHERE chart_id = ${chartId} AND user_id = ${targetUserId}
        RETURNING user_id
      `;

      if (!result.length) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Permission not found' })
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'Permission removed successfully' })
      };
    }

    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  } catch (error) {
    console.error('Error managing permissions:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to manage permissions' })
    };
  }
};
