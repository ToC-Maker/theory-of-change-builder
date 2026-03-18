import { Handler } from '@netlify/functions';
import { neon } from '@neondatabase/serverless';
import { verifyToken, extractToken, tryMigrateDecoded } from './utils/auth';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json'
};

export const handler: Handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const chartId = event.queryStringParameters?.chartId;
    const editToken = event.queryStringParameters?.editToken;

    if (!chartId && !editToken) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Chart ID or edit token is required' })
      };
    }

    const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL not configured');
    }

    // Connect to database
    const sql = neon(DATABASE_URL);

    let result;
    if (editToken) {
      // Fetch by edit token (for editing)
      result = await sql`
        SELECT id, chart_data, user_id, link_sharing_level FROM charts
        WHERE edit_token = ${editToken}
      `;

      if (!result || result.length === 0) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ error: 'Chart not found' })
        };
      }

      const chartOwnerId = result[0].user_id;
      const linkSharingLevel = result[0].link_sharing_level || 'restricted';

      // If link sharing is set to 'editor', allow anyone with the edit token
      const allowAnonymousEdit = linkSharingLevel === 'editor';

      // If this chart has an owner AND is not publicly editable, require authentication
      if (chartOwnerId && !allowAnonymousEdit) {
        const token = extractToken(event.headers.authorization);

        if (!token) {
          return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ error: 'Authentication required. Please log in to access this chart.' })
          };
        }

        let decodedToken;
        try {
          decodedToken = await verifyToken(token);
        } catch (err) {
          return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ error: 'Invalid or expired authentication. Please log in again.' })
          };
        }

        const userId = decodedToken.sub;
        const userEmail = decodedToken.email || decodedToken.name;

        // Migrate user data if they logged in with a new Auth0 tenant (different sub, same email)
        await tryMigrateDecoded(sql, decodedToken, 'getChart');

        // Re-read chart owner after migration (may have changed from old sub to new sub)
        const refreshed = await sql`SELECT user_id FROM charts WHERE id = ${result[0].id}`;
        const currentOwnerId = refreshed[0]?.user_id ?? chartOwnerId;

        // Check if user already has permission or a pending request
        const existingPermission = await sql`
          SELECT user_id, status FROM chart_permissions
          WHERE chart_id = ${result[0].id} AND user_id = ${userId}
        `;

        if (existingPermission.length === 0) {
          // Determine permission level: owner if they created it, edit otherwise
          const permissionLevel = userId === currentOwnerId ? 'owner' : 'edit';

          if (userId === currentOwnerId) {
            // If they're the owner, auto-approve
            await sql`
              INSERT INTO chart_permissions (chart_id, user_id, user_email, permission_level, granted_by, status)
              VALUES (${result[0].id}, ${userId}, ${userEmail}, ${permissionLevel}, ${userId}, 'approved')
            `;
          } else {
            // Create a pending access request for non-owners
            await sql`
              INSERT INTO chart_permissions (chart_id, user_id, user_email, permission_level, granted_by, status)
              VALUES (${result[0].id}, ${userId}, ${userEmail}, ${permissionLevel}, ${currentOwnerId}, 'pending')
            `;

            return {
              statusCode: 403,
              headers,
              body: JSON.stringify({
                error: 'Access request pending. The chart owner needs to approve your request.',
                pending: true
              })
            };
          }
        } else {
          // Check if permission is pending or rejected
          const permStatus = existingPermission[0].status;
          if (permStatus === 'pending') {
            return {
              statusCode: 403,
              headers,
              body: JSON.stringify({
                error: 'Access request pending. The chart owner needs to approve your request.',
                pending: true
              })
            };
          } else if (permStatus === 'rejected') {
            return {
              statusCode: 403,
              headers,
              body: JSON.stringify({
                error: 'Access request was denied by the chart owner.',
                rejected: true
              })
            };
          }
          // If approved, continue to return chart data below
        }
      } else if (chartOwnerId && allowAnonymousEdit) {
        // Link sharing is 'editor' - allow access but still add authenticated users to permissions
        const token = extractToken(event.headers.authorization);

        if (token) {
          try {
            const decodedToken = await verifyToken(token);
            const userId = decodedToken.sub;
            const userEmail = decodedToken.email || decodedToken.name;

            // Migrate user data if they logged in with a new Auth0 tenant (different sub, same email)
            await tryMigrateDecoded(sql, decodedToken, 'getChart');

            // Auto-add authenticated user to permissions if they're not already there
            const existingPermission = await sql`
              SELECT user_id FROM chart_permissions
              WHERE chart_id = ${result[0].id} AND user_id = ${userId}
            `;

            if (existingPermission.length === 0) {
              // Determine permission level: owner if they created it, edit otherwise
              const permissionLevel = userId === chartOwnerId ? 'owner' : 'edit';

              // Add them to permissions as approved (since link sharing is 'editor')
              await sql`
                INSERT INTO chart_permissions (chart_id, user_id, user_email, permission_level, granted_by, status)
                VALUES (${result[0].id}, ${userId}, ${userEmail}, ${permissionLevel}, ${chartOwnerId || userId}, 'approved')
              `;
            }
          } catch (err) {
            // If token is invalid, that's okay - they can still access as anonymous
            console.log('Token verification failed, allowing anonymous access due to link sharing level');
          }
        }
        // If no token or invalid token, still allow access
      }
      // If chartOwnerId is null (anonymous chart), allow anyone with the edit token
    } else if (chartId) {
      // Fetch by chart ID (for viewing)
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
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Chart not found' })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        chartData: result[0].chart_data,
        chartId: result[0].id,
        canEdit: !!editToken
      })
    };
  } catch (error) {
    console.error('Error fetching chart:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch chart' })
    };
  }
};